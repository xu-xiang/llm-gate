import { Request, Response } from 'express';
import { LLMProvider } from '../base';
import { QwenAuthManager } from './auth';
import { DEFAULT_DASHSCOPE_BASE_URL } from './constants';
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
        daily: { used: number, limit: number, percent: number };
        rpm: { used: number, limit: number, percent: number };
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
                monitor.recordRequest('ratelimit');
                throw new Error('Rate limited');
            } else if (response.status >= 500) {
                this.providerStatus.status = 'error';
                this.providerStatus.lastError = `Server Error (${response.status})`;
                monitor.recordRequest('error');
                this.providerStatus.errorCount++;
                throw new Error(`Upstream server error: ${response.status}`);
            } else if (response.status === 401) {
                this.providerStatus.status = 'error';
                this.providerStatus.lastError = 'Auth Failed (401)';
                monitor.recordRequest('error');
                this.providerStatus.errorCount++;
                throw new Error('Authentication failed');
            } else if (!response.ok) {
                this.providerStatus.status = 'error';
                this.providerStatus.lastError = `HTTP ${response.status}`;
                monitor.recordRequest('error');
                this.providerStatus.errorCount++;
                // Non-retryable maybe? But for now let's throw to allow failover
                throw new Error(`HTTP Error ${response.status}`);
            }

            // Success
            this.providerStatus.status = 'active';
            monitor.recordRequest('success');
            quotaManager.incrementUsage(this.providerStatus.id); // 记录成功请求到持久化计数器

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
                monitor.recordRequest('error');
            }

            // Re-throw so MultiQwenProvider can try next
            throw error;
        }
    }
}