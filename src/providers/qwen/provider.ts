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
    private readonly upstreamUserAgent = 'QwenCode/0.9.1 (linux; x64)';
    private readonly defaultSystemPrompt = '你是助手';

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

    public setAlias(alias?: string) {
        if (alias && alias.trim()) {
            this.providerStatus.alias = alias.trim();
        }
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
            // Do not probe upstream on initialize. Probing consumes free quota and can
            // create false 429 storms across edge isolates. Runtime requests handle
            // 401/429 and update status accordingly.
            this.providerStatus.status = 'active';
            this.providerStatus.lastError = undefined;
            this.retryAfterTs = 0;
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
                const upstreamBody = this.buildDashScopeCompatibleBody(body);

                try {
                    return await fetch(url, {
                        method: 'POST',
                        headers: {
                            Authorization: `Bearer ${creds.access_token}`,
                            'X-DashScope-AuthType': 'qwen-oauth',
                            'X-DashScope-CacheControl': 'enable',
                            'X-DashScope-UserAgent': this.upstreamUserAgent,
                            'User-Agent': this.upstreamUserAgent,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify(upstreamBody),
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
                let upstreamBody = '';
                try {
                    upstreamBody = await response.text();
                } catch {}
                this.providerStatus.lastError = `HTTP ${response.status}`;
                this.retryAfterTs = Date.now() + this.errorCooldownMs;
                failureRecorded = true;

                if (response.status === 429) {
                    const bodyLower = upstreamBody.toLowerCase();
                    if (bodyLower.includes('insufficient_quota') || bodyLower.includes('free allocated quota exceeded')) {
                        this.providerStatus.lastError = 'Quota exceeded (Qwen free tier)';
                        await quotaManager.recordFailure(this.providerStatus.id, 'chat', 'upstream_quota_exceeded');
                        throw new Error('Quota exceeded (Qwen free tier)');
                    }
                    this.providerStatus.lastError = 'Rate limited';
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
                const reason = error.message === 'AUTH_EXPIRED' ? 'auth_expired' : 'runtime_error';
                c.executionCtx.waitUntil(quotaManager.recordFailure(this.providerStatus.id, 'chat', reason));
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
                const reason = error.message === 'AUTH_EXPIRED' ? 'auth_expired' : 'runtime_error';
                c.executionCtx.waitUntil(quotaManager.recordFailure(this.providerStatus.id, 'search', reason));
            }
            return c.json({ error: error.message }, 500);
        }
    }

    private buildDashScopeCompatibleBody(input: any): any {
        if (!input || typeof input !== 'object') return input;
        const out: any = { ...input };
        if (!Array.isArray(input.messages)) return out;

        const messages = input.messages.map((m: any) => ({ ...m }));
        const hasSystem = messages.some((m: any) => m?.role === 'system');
        if (!hasSystem) {
            messages.unshift({
                role: 'system',
                content: this.defaultSystemPrompt
            });
        }

        const systemIndex = messages.findIndex((m: any) => m?.role === 'system');
        const lastIndex = messages.length - 1;

        const mark = (idx: number) => {
            if (idx < 0 || idx >= messages.length) return;
            const msg = messages[idx];
            if (!msg || msg.content == null) return;

            if (typeof msg.content === 'string') {
                msg.content = [{ type: 'text', text: msg.content, cache_control: { type: 'ephemeral' } }];
                return;
            }

            if (Array.isArray(msg.content) && msg.content.length > 0) {
                const arr = msg.content.map((p: any) => ({ ...p }));
                const li = arr.length - 1;
                arr[li] = { ...arr[li], cache_control: { type: 'ephemeral' } };
                msg.content = arr;
            }
        };

        mark(systemIndex);
        mark(lastIndex);
        out.messages = messages;
        return out;
    }
}
