import { Context } from 'hono';
import { LLMProvider } from '../base';
import { QwenProvider, ProviderStatus } from './provider';
import { logger } from '../../core/logger';
import { IStorage } from '../../core/storage';
import { quotaManager } from '../../core/quota';

export class MultiQwenProvider implements LLMProvider {
    private providers: QwenProvider[] = [];
    private currentIndex = 0;
    private storage: IStorage;
    private clientId: string;
    private staticAuthFiles: string[];

    constructor(storage: IStorage, authFiles: string[], clientId: string) {
        this.storage = storage;
        this.staticAuthFiles = authFiles;
        this.clientId = clientId;
    }

    async initialize() {
        await this.scanAndLoadProviders();
    }

    private normalizeKey(key: string): string {
        return key.startsWith('./') ? key.substring(2) : key;
    }

    private async scanAndLoadProviders() {
        const [dynamicQwen, dynamicQwenLegacy, dynamicOauth, dynamicOauthLegacy] = await Promise.all([
            this.storage.list('qwen_creds_'),
            this.storage.list('./qwen_creds_'),
            this.storage.list('oauth_creds_'),
            this.storage.list('./oauth_creds_')
        ]);

        const validStaticKeys: string[] = [];
        for (const key of this.staticAuthFiles) {
            const cleanKey = this.normalizeKey(key);
            const exists = (await this.storage.get(cleanKey)) || (await this.storage.get(`./${cleanKey}`));
            if (exists) validStaticKeys.push(cleanKey);
        }

        const discoveredKeys = [
            ...validStaticKeys,
            ...dynamicQwen,
            ...dynamicQwenLegacy,
            ...dynamicOauth,
            ...dynamicOauthLegacy
        ].map((k) => this.normalizeKey(k));

        const allActiveKeys = Array.from(new Set(discoveredKeys));

        logger.info(`Refreshing provider pool. Active: ${allActiveKeys.length}`);

        const currentMap = new Map(this.providers.map((p) => [p.getRuntimeStatus().id, p]));
        const newProviders: QwenProvider[] = [];
        const initPromises: Promise<void>[] = [];

        for (const key of allActiveKeys) {
            if (currentMap.has(key)) {
                newProviders.push(currentMap.get(key)!);
            } else {
                const p = new QwenProvider(this.storage, key, this.clientId);
                initPromises.push(p.initialize());
                newProviders.push(p);
            }
        }

        if (initPromises.length > 0) {
            await Promise.allSettled(initPromises);
        }

        this.providers = newProviders;
        if (this.currentIndex >= this.providers.length) {
            this.currentIndex = 0;
        }
    }

    public async addProvider(credsKey: string) {
        const normalized = this.normalizeKey(credsKey);
        const existing = this.providers.find((p) => p.getRuntimeStatus().id === normalized);
        if (existing) {
            logger.info(`Reloading provider ${normalized}...`);
            await existing.reload();
        } else {
            await this.scanAndLoadProviders();
        }
    }

    public async removeProvider(credsKey: string) {
        const normalized = this.normalizeKey(credsKey);
        this.providers = this.providers.filter((p) => p.getRuntimeStatus().id !== normalized);
        if (this.currentIndex >= this.providers.length) {
            this.currentIndex = 0;
        }
    }

    public async getAllProviderStatus(): Promise<ProviderStatus[]> {
        const baseStatuses = this.providers.map((p) => p.getStatusBase());
        const usageMap = await quotaManager.getUsageBatch(baseStatuses.map((s) => s.id));
        return baseStatuses.map((s) => ({
            ...s,
            quota: usageMap[s.id]
        }));
    }

    public getCurrentIndex(): number {
        return this.currentIndex;
    }

    private isAuthErrorMessage(message: string): boolean {
        return message.includes('AUTH_EXPIRED') || message.includes('Unauthorized (Please Login)');
    }

    async handleChatCompletion(c: Context, payload?: any): Promise<Response | void> {
        const availableProviders = this.providers.length;
        if (availableProviders === 0) {
            return c.json({ error: 'No Qwen providers configured' }, 500);
        }

        let lastError: any = null;
        let triedCount = 0;
        const startIndex = this.currentIndex;
        const errorMessages: string[] = [];
        let authExpiredCount = 0;
        let rateLimitedCount = 0;
        let quotaBlockedCount = 0;

        for (let attempt = 0; attempt < availableProviders; attempt++) {
            const providerIndex = (startIndex + attempt) % availableProviders;
            const provider = this.providers[providerIndex];
            const status = provider.getRuntimeStatus();

            if (status.status === 'error' && status.lastError && this.isAuthErrorMessage(status.lastError)) {
                authExpiredCount++;
                errorMessages.push(status.lastError);
                continue;
            }

            // Circuit-breaker cooldown: temporarily skip known failing provider.
            if (!provider.canAttempt() && attempt < availableProviders - 1) {
                continue;
            }

            const quotaResult = await quotaManager.checkQuota(status.id, 'chat');
            if (!quotaResult.allowed) {
                quotaBlockedCount++;
                continue;
            }

            triedCount++;

            try {
                if (attempt === 0) {
                    this.currentIndex = (providerIndex + 1) % availableProviders;
                }

                logger.debug(`Attempting request with provider: ${status.id} (Attempt ${attempt + 1})`);
                return await provider.handleChatCompletion(c, payload);
            } catch (err: any) {
                lastError = err;
                const message = String(err?.message || 'Unknown error');
                errorMessages.push(message);
                if (this.isAuthErrorMessage(message)) {
                    authExpiredCount++;
                }
                if (message.includes('Rate limited')) {
                    rateLimitedCount++;
                }
                logger.warn(`Provider ${status.id} failed, trying next... Error: ${err.message}`);
            }
        }

        if (triedCount === 0) {
            if (authExpiredCount === availableProviders) {
                return c.json(
                    {
                        error: 'All providers unauthorized',
                        details: 'All accounts require re-login in admin console.'
                    },
                    401
                );
            }
            if (quotaBlockedCount === availableProviders) {
                return c.json(
                    {
                        error: 'All providers rate limited',
                        details: 'All accounts are currently rate limited.'
                    },
                    429
                );
            }
            return c.json(
                {
                    error: 'No available providers',
                    details: 'Providers are either unauthorized, cooling down, or rate limited.',
                    errors: errorMessages
                },
                503
            );
        }

        if (authExpiredCount === triedCount && triedCount > 0) {
            return c.json(
                {
                    error: 'All providers unauthorized',
                    details: 'All accounts require re-login in admin console.'
                },
                401
            );
        }

        if (rateLimitedCount === triedCount && triedCount > 0) {
            return c.json(
                {
                    error: 'All providers rate limited',
                    details: 'All accounts are currently rate limited.'
                },
                429
            );
        }

        return c.json(
            {
                error: 'All providers failed',
                details: lastError?.message,
                attempts: triedCount,
                errors: errorMessages
            },
            500
        );
    }

    async handleWebSearch(c: Context, payload?: any): Promise<Response | void> {
        const availableProviders = this.providers.length;
        if (availableProviders === 0) {
            return c.json({ error: 'No Qwen providers configured' }, 500);
        }

        let lastError: any = null;
        let triedCount = 0;
        const startIndex = this.currentIndex;
        let authExpiredCount = 0;
        let quotaBlockedCount = 0;

        for (let attempt = 0; attempt < availableProviders; attempt++) {
            const providerIndex = (startIndex + attempt) % availableProviders;
            const provider = this.providers[providerIndex];
            const status = provider.getRuntimeStatus();

            if (status.status === 'error' && status.lastError && this.isAuthErrorMessage(status.lastError)) {
                authExpiredCount++;
                continue;
            }

            if (!provider.canAttempt() && attempt < availableProviders - 1) {
                continue;
            }

            const quotaResult = await quotaManager.checkQuota(status.id, 'search');
            if (!quotaResult.allowed) {
                quotaBlockedCount++;
                continue;
            }

            triedCount++;

            try {
                if (attempt === 0) {
                    this.currentIndex = (providerIndex + 1) % availableProviders;
                }
                return await provider.handleWebSearch(c, payload);
            } catch (err: any) {
                lastError = err;
                logger.warn(`Search failed with provider ${status.id}, trying next... Error: ${err.message}`);
            }
        }

        if (triedCount === 0) {
            if (authExpiredCount === availableProviders) {
                return c.json(
                    {
                        error: 'All providers unauthorized',
                        details: 'All accounts require re-login in admin console.'
                    },
                    401
                );
            }
            if (quotaBlockedCount === availableProviders) {
                return c.json(
                    {
                        error: 'All providers rate limited',
                        details: 'All accounts are currently rate limited.'
                    },
                    429
                );
            }
            return c.json(
                {
                    error: 'No available providers',
                    details: 'Search providers are either unauthorized, cooling down, or rate limited.'
                },
                503
            );
        }

        return c.json({ error: 'All search providers failed', details: lastError?.message }, 500);
    }
}
