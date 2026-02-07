import { Context } from 'hono';
import { LLMProvider } from '../base';
import { QwenAuthManager } from './auth';
import { DEFAULT_DASHSCOPE_BASE_URL, QWEN_SEARCH_PATH } from './constants';
import { logger } from '../../core/logger';
import { quotaManager } from '../../core/quota';
import { IStorage } from '../../core/storage';
import { createSSETransformer } from '../../core/stream';

export interface ProviderStatus {
    id: string;
    path: string;
    alias?: string;
    status: 'active' | 'inactive' | 'error' | 'initializing';
    lastError?: string;
    totalRequests: number;
    errorCount: number;
    lastLatency?: number;
    lastUsed?: Date;
    quota?: {
        chat: {
            daily: { used: number; limit: number; percent: number };
            rpm: { used: number; limit: number; percent: number };
        };
        search: {
            daily: { used: number; limit: number; percent: number };
            rpm: { used: number; limit: number; percent: number };
        };
    };
}

export class QwenProvider implements LLMProvider {
    private authManager: QwenAuthManager;
    private credsPath: string;
    private providerStatus: ProviderStatus;
    private retryAfterTs = 0;
    private readonly errorCooldownMs = 15000;

    constructor(storage: IStorage, credsPath: string, clientId: string) {
        this.credsPath = credsPath;
        this.authManager = new QwenAuthManager(storage, credsPath, clientId);
        this.providerStatus = {
            id: credsPath,
            path: credsPath,
            status: 'initializing',
            totalRequests: 0,
            errorCount: 0,
            alias: credsPath.replace('qwen_creds_', '').replace('.json', '')
        };
    }

    public getRuntimeStatus(): ProviderStatus {
        return { ...this.providerStatus };
    }

    public canAttempt(now = Date.now()): boolean {
        return now >= this.retryAfterTs;
    }

    public async reload() {
        this.authManager.clearCache();
        await this.initialize();
    }

    public async getStatus(): Promise<ProviderStatus> {
        return {
            ...this.providerStatus,
            alias: this.providerStatus.alias || this.authManager.getCachedAlias(),
            quota: await quotaManager.getUsage(this.providerStatus.id)
        };
    }

    public getStatusBase(): ProviderStatus {
        return {
            ...this.providerStatus,
            alias: this.providerStatus.alias || this.authManager.getCachedAlias()
        };
    }

    async initialize() {
        try {
            logger.info(`QwenProvider initializing for ${this.credsPath}...`);
            this.providerStatus.status = 'initializing';
            let creds;
            try {
                creds = await this.authManager.getValidCredentials();
            } catch (e: any) {
                if (e.message.includes('No credentials found')) {
                    logger.error('No credentials found in KV storage.');
                    this.providerStatus.status = 'error';
                    this.providerStatus.lastError = 'Missing Credentials';
                    return;
                }
                if (e.message === 'AUTH_EXPIRED') {
                    this.providerStatus.status = 'error';
                    this.providerStatus.lastError = 'Unauthorized (Please Login)';
                    return;
                }
                throw e;
            }

            this.providerStatus.alias = creds.alias || this.authManager.getCachedAlias();

            logger.info(`Verifying token for ${this.credsPath}...`);
            const isValid = await this.authManager.checkTokenValidity(creds);

            if (isValid) {
                this.providerStatus.status = 'active';
                this.providerStatus.lastError = undefined;
                this.retryAfterTs = 0;
            } else {
                logger.warn(`Token invalid for ${this.credsPath}. Attempting refresh...`);
                const refreshed = await this.authManager.refreshToken(creds.refresh_token);
                this.providerStatus.alias = refreshed.alias || this.providerStatus.alias;
                this.providerStatus.status = 'active';
                this.providerStatus.lastError = undefined;
                this.retryAfterTs = 0;
            }
        } catch (e: any) {
            logger.error(`QwenProvider initialization failed for ${this.credsPath}`, e);
            this.providerStatus.status = 'error';
            this.providerStatus.lastError = e.message === 'AUTH_EXPIRED' ? 'Unauthorized (Please Login)' : e.message;
        }
    }

    async handleChatCompletion(c: Context, payload?: any): Promise<Response | void> {
        const startTime = Date.now();
        const body = payload ?? (await c.req.json());
        let failureRecorded = false;

        const attemptRequest = async (forceRefresh = false): Promise<Response | null> => {
            try {
                let creds;
                try {
                    creds = await this.authManager.getValidCredentials();
                } catch (e: any) {
                    throw new Error(e.message === 'AUTH_EXPIRED' ? 'AUTH_EXPIRED' : 'Missing credentials');
                }

                if (forceRefresh) {
                    creds = await this.authManager.refreshToken(creds.refresh_token);
                }

                this.providerStatus.alias = creds.alias || this.providerStatus.alias || this.authManager.getCachedAlias();

                if (!creds || !creds.access_token) {
                    throw new Error('Invalid Credentials: Access Token missing');
                }

                const baseUrl = creds.resource_url || DEFAULT_DASHSCOPE_BASE_URL;
                const suffix = '/v1';
                let normalizedUrl = baseUrl.startsWith('http') ? baseUrl : `https://${baseUrl}`;
                if (normalizedUrl.endsWith('/')) normalizedUrl = normalizedUrl.slice(0, -1);
                if (!normalizedUrl.endsWith(suffix)) normalizedUrl = `${normalizedUrl}${suffix}`;

                const url = `${normalizedUrl}/chat/completions`;
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 60000);

                try {
                    return await fetch(url, {
                        method: 'POST',
                        headers: {
                            Authorization: `Bearer ${creds.access_token}`,
                            'X-DashScope-AuthType': 'qwen-oauth',
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify(body),
                        signal: controller.signal
                    });
                } finally {
                    clearTimeout(timeoutId);
                }
            } catch (error: any) {
                if (error.name === 'AbortError') throw new Error('Upstream Timeout (60s)');
                throw error;
            }
        };

        try {
            let response = await attemptRequest(false);
            if (!response || response.status === 401) response = await attemptRequest(true);

            if (!response) throw new Error('Upstream unreachable');

            if (!response.ok) {
                this.providerStatus.errorCount++;
                this.providerStatus.status = 'error';
                this.providerStatus.lastError = `HTTP ${response.status}`;
                this.retryAfterTs = Date.now() + this.errorCooldownMs;
                failureRecorded = true;

                if (response.status === 429) {
                    await quotaManager.recordFailure(this.providerStatus.id, 'chat', 'upstream_429');
                    throw new Error('Rate limited');
                }

                await quotaManager.recordFailure(this.providerStatus.id, 'chat', `upstream_${response.status}`);
                throw new Error(`Upstream Error: ${response.status}`);
            }

            this.providerStatus.status = 'active';
            this.providerStatus.lastError = undefined;
            this.retryAfterTs = 0;
            this.providerStatus.totalRequests++;
            this.providerStatus.lastUsed = new Date();
            this.providerStatus.lastLatency = Date.now() - startTime;

            c.executionCtx.waitUntil(quotaManager.incrementUsage(this.providerStatus.id, 'chat'));

            const newHeaders = new Headers();
            response.headers.forEach((value: string, key: string) => {
                if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(key.toLowerCase())) {
                    newHeaders.set(key, value);
                }
            });

            const isStreaming = response.headers.get('content-type')?.includes('text/event-stream');
            let bodyStream = response.body;
            if (isStreaming && bodyStream) {
                const transformer = createSSETransformer();
                // @ts-ignore
                bodyStream = bodyStream.pipeThrough(transformer);
            }

            return new Response(bodyStream, { status: response.status, headers: newHeaders });
        } catch (error: any) {
            if (!failureRecorded) {
                this.providerStatus.errorCount++;
            }
            this.providerStatus.lastError = error.message === 'AUTH_EXPIRED' ? 'Unauthorized (Please Login)' : error.message;
            if (error.message === 'AUTH_EXPIRED') this.providerStatus.status = 'error';
            this.retryAfterTs = Date.now() + this.errorCooldownMs;

            if (!failureRecorded) {
                c.executionCtx.waitUntil(quotaManager.recordFailure(this.providerStatus.id, 'chat', 'runtime_error'));
            }

            throw error;
        }
    }

    async handleWebSearch(c: Context, payload?: any): Promise<Response | void> {
        const body = payload ?? (await c.req.json());
        const query = body.query;
        if (!query) return c.json({ error: 'Missing query' }, 400);
        let failureRecorded = false;

        const attemptSearch = async (forceRefresh = false): Promise<Response | null> => {
            let creds = await this.authManager.getValidCredentials();
            if (forceRefresh) creds = await this.authManager.refreshToken(creds.refresh_token);

            this.providerStatus.alias = creds.alias || this.providerStatus.alias || this.authManager.getCachedAlias();

            const baseUrl = creds.resource_url || 'portal.qwen.ai';
            let normalizedBase = baseUrl.startsWith('http') ? baseUrl : `https://${baseUrl}`;
            if (normalizedBase.endsWith('/')) normalizedBase = normalizedBase.slice(0, -1);

            const url = `${normalizedBase}${QWEN_SEARCH_PATH}`;
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 30000);

            try {
                return await fetch(url, {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${creds.access_token}`,
                        'X-DashScope-AuthType': 'qwen-oauth',
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ uq: query, page: 1, rows: 10 }),
                    signal: controller.signal
                });
            } finally {
                clearTimeout(timeoutId);
            }
        };

        try {
            let response = await attemptSearch(false);
            if (!response || response.status === 401) response = await attemptSearch(true);

            if (!response || !response.ok) {
                const statusCode = response?.status || 500;
                failureRecorded = true;
                await quotaManager.recordFailure(this.providerStatus.id, 'search', `upstream_${statusCode}`);
                throw new Error(`Search Error: ${statusCode}`);
            }

            const data: any = await response.json();
            if (!data || data.status !== 0) {
                failureRecorded = true;
                await quotaManager.recordFailure(this.providerStatus.id, 'search', 'invalid_payload');
                throw new Error(data?.message || 'Search failed');
            }

            this.providerStatus.totalRequests++;
            this.providerStatus.lastUsed = new Date();
            this.providerStatus.status = 'active';
            this.providerStatus.lastError = undefined;
            this.retryAfterTs = 0;

            c.executionCtx.waitUntil(quotaManager.incrementUsage(this.providerStatus.id, 'search'));

            const results = (data?.data?.docs || []).map((item: any) => ({
                title: item.title,
                url: item.url,
                content: item.snippet,
                score: item._score,
                publishedDate: item.timestamp_format
            }));

            return c.json({ success: true, query, results });
        } catch (error: any) {
            logger.error('WebSearch Failed', error);
            this.providerStatus.status = 'error';
            this.providerStatus.lastError = error.message;
            this.retryAfterTs = Date.now() + this.errorCooldownMs;
            if (!failureRecorded) {
                c.executionCtx.waitUntil(quotaManager.recordFailure(this.providerStatus.id, 'search', 'runtime_error'));
            }
            return c.json({ error: error.message }, 500);
        }
    }
}
