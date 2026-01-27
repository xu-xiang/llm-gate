import { Request, Response } from 'express';
import { LLMProvider } from '../base';
import { QwenAuthManager } from './auth';
import { DEFAULT_DASHSCOPE_BASE_URL, QWEN_SEARCH_PATH } from './constants';
import { Readable } from 'stream';
import { logger } from '../../core/logger';
import { monitor } from '../../core/monitor';
import { quotaManager } from '../../core/quota';

export interface ProviderStatus {
    id: string;
    path: string;
    status: 'active' | 'inactive' | 'error' | 'initializing';
    lastError?: string;
    totalRequests: number;
    errorCount: number;
    lastLatency?: number;
    lastUsed?: Date;
    quota?: {
        chat: {
            daily: { used: number, limit: number, percent: number };
            rpm: { used: number, limit: number, percent: number };
        };
        search: {
            daily: { used: number, limit: number, percent: number };
            rpm: { used: number, limit: number, percent: number };
        };
    };
}

export class QwenProvider implements LLMProvider {
    private authManager: QwenAuthManager;
    private credsPath: string;
    private providerStatus: ProviderStatus;

    constructor(credsPath: string) {
        this.credsPath = credsPath;
        this.authManager = new QwenAuthManager(credsPath);
        this.providerStatus = {
            id: credsPath.split('/').pop() || credsPath,
            path: credsPath,
            status: 'initializing',
            totalRequests: 0,
            errorCount: 0
        };
    }

    public getStatus(): ProviderStatus {
        return { 
            ...this.providerStatus,
            quota: quotaManager.getUsage(this.providerStatus.id)
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
                    logger.info('No credentials found. Proactively starting OAuth flow...');
                    creds = await this.authManager.authenticateInteractive();
                } else {
                    throw e;
                }
            }
            
            logger.info('Verifying token with active API check...');
            const isValid = await this.authManager.checkTokenValidity(creds);
            
            if (isValid) {
                logger.info('✅ Token verification successful. Provider ready.');
                this.providerStatus.status = 'active';
            } else {
                logger.warn('❌ Token verification failed (401). Attempting refresh...');
                await this.authManager.refreshToken(creds.refresh_token);
                logger.info('✅ Token refreshed successfully.');
                this.providerStatus.status = 'active';
            }
        } catch (e: any) {
            logger.error('QwenProvider initialization failed', e);
            this.providerStatus.status = 'error';
            this.providerStatus.lastError = e.message;
        }
    }

    async handleChatCompletion(req: Request, res: Response): Promise<void> {
        this.providerStatus.totalRequests++;
        this.providerStatus.lastUsed = new Date();
        const startTime = Date.now();

        const attemptRequest = async (forceRefresh = false): Promise<any | null> => {
            try {
                let creds;
                try {
                    creds = await this.authManager.getValidCredentials();
                } catch (e: any) {
                    if (e.message.includes('No credentials found')) {
                        creds = await this.authManager.authenticateInteractive();
                    } else {
                        throw e;
                    }
                }
                
                if (forceRefresh) {
                    creds = await this.authManager.refreshToken(creds.refresh_token);
                }

                const baseUrl = creds.resource_url || DEFAULT_DASHSCOPE_BASE_URL;
                const suffix = '/v1';
                let normalizedUrl = baseUrl.startsWith('http') ? baseUrl : `https://${baseUrl}`;
                if (normalizedUrl.endsWith('/')) normalizedUrl = normalizedUrl.slice(0, -1);
                if (!normalizedUrl.endsWith(suffix)) normalizedUrl = `${normalizedUrl}${suffix}`;
                
                const url = `${normalizedUrl}/chat/completions`;

                const response = await fetch(url, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${creds.access_token}`,
                        'X-DashScope-AuthType': 'qwen-oauth',
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(req.body)
                });

                if (response.status === 401 && !forceRefresh) {
                    return null; // Signal retry
                }

                return response;
            } catch (error: any) {
                throw error;
            }
        };

        try {
            let response = await attemptRequest(false);
            
            if (!response) {
                response = await attemptRequest(true);
            }

            if (!response) throw new Error('Failed to get response from upstream');

            this.providerStatus.lastLatency = Date.now() - startTime;
            
            if (response.status === 429) {
                this.providerStatus.status = 'error'; // Rate limited is a temporary error
                this.providerStatus.lastError = 'Rate Limited (429)';
                monitor.recordRequest('ratelimit', 'chat');
                throw new Error('Rate limited');
            } else if (response.status >= 500) {
                this.providerStatus.status = 'error';
                this.providerStatus.lastError = `Server Error (${response.status})`;
                monitor.recordRequest('error', 'chat');
                this.providerStatus.errorCount++;
                throw new Error(`Upstream server error: ${response.status}`);
            } else if (response.status === 401) {
                this.providerStatus.status = 'error';
                this.providerStatus.lastError = 'Auth Failed (401)';
                monitor.recordRequest('error', 'chat');
                this.providerStatus.errorCount++;
                throw new Error('Authentication failed');
            } else if (!response.ok) {
                this.providerStatus.status = 'error';
                this.providerStatus.lastError = `HTTP ${response.status}`;
                monitor.recordRequest('error', 'chat');
                this.providerStatus.errorCount++;
                // Non-retryable maybe? But for now let's throw to allow failover
                throw new Error(`HTTP Error ${response.status}`);
            }

            // Success
            this.providerStatus.status = 'active';
            monitor.recordRequest('success', 'chat');
            quotaManager.incrementUsage(this.providerStatus.id, 'chat'); // 记录成功请求到持久化计数器

            res.status(response.status);
            const contentType = response.headers.get('content-type');
            if (contentType) res.setHeader('Content-Type', contentType);
            
            if (response.body) {
                // @ts-ignore
                Readable.fromWeb(response.body).pipe(res);
            } else {
                res.end();
            }

        } catch (error: any) {
            // Only handle here if it's NOT a retryable error that we want MultiProvider to see
            // But wait, MultiProvider needs to catch this. 
            // If headers are already sent, we can't retry anyway.
            if (res.headersSent) {
                logger.error('Error occurred after headers sent, cannot retry', error);
                return;
            }

            // Record local error
            this.providerStatus.status = 'error';
            this.providerStatus.lastError = error.message;
            if (!error.message.includes('Rate limited')) {
                this.providerStatus.errorCount++;
                monitor.recordRequest('error', 'chat');
            }

            // Re-throw so MultiQwenProvider can try next
            throw error;
        }
    }

    async handleWebSearch(req: Request, res: Response): Promise<void> {
        const { query } = req.body;
        if (!query) {
            res.status(400).json({ error: 'Missing query parameter' });
            return;
        }

        logger.info(`Handling web search for: ${query}`);

        const attemptSearch = async (forceRefresh = false): Promise<any | null> => {
            let creds = await this.authManager.getValidCredentials();
            if (forceRefresh) {
                creds = await this.authManager.refreshToken(creds.refresh_token);
            }

            const baseUrl = creds.resource_url || 'portal.qwen.ai';
            let normalizedBase = baseUrl.startsWith('http') ? baseUrl : `https://${baseUrl}`;
            if (normalizedBase.endsWith('/')) normalizedBase = normalizedBase.slice(0, -1);
            
            const url = `${normalizedBase}${QWEN_SEARCH_PATH}`;

            const requestBody = {
                uq: query,
                page: 1,
                rows: 10
            };

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${creds.access_token}`,
                    'X-DashScope-AuthType': 'qwen-oauth',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(requestBody)
            });

            if (response.status === 401 && !forceRefresh) {
                return null; // Retry
            }

            return response;
        };

        try {
            let response = await attemptSearch(false);
            if (!response) response = await attemptSearch(true);

            if (!response.ok) {
                const err = await response.text();
                throw new Error(`Upstream Search Error: ${response.status} ${err}`);
            }

            const data = await response.json();
            if (!data || typeof data.status === 'undefined') {
                throw new Error('Upstream Search Error: Invalid response format');
            }
            if (data.status !== 0) {
                throw new Error(`Upstream Search Error: ${data.status} ${data.message || 'Unknown error'}`);
            }
            const docs = data?.data?.docs || [];
            const results = docs.map((item: any) => ({
                title: item.title,
                url: item.url,
                content: item.snippet,
                score: item._score,
                publishedDate: item.timestamp_format
            }));
            monitor.recordRequest('success', 'search');
            quotaManager.incrementUsage(this.providerStatus.id, 'search');
            res.json({
                success: true,
                query,
                results
            });
        } catch (error: any) {
            logger.error('WebSearch Failed', error);
            monitor.recordRequest('error', 'search');
            res.status(500).json({ error: error.message });
        }
    }
}
