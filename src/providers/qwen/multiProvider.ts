import { Context } from 'hono';
import { LLMProvider } from '../base';
import { QwenProvider, ProviderStatus } from './provider';
import { logger } from '../../core/logger';
import { IStorage } from '../../core/storage';
import { quotaManager } from '../../core/quota';
import { ProviderRegistry } from '../../core/providerRegistry';

export class MultiQwenProvider implements LLMProvider {
    private providers: QwenProvider[] = [];
    private currentIndex = 0;
    private storage: IStorage;
    private clientId: string;
    private staticAuthFiles: string[];
    private registry?: ProviderRegistry;
    private lastScanAt = 0;
    private readonly scanIntervalMs: number;
    private scanPromise: Promise<void> | null = null;

    constructor(
        storage: IStorage,
        authFiles: string[],
        clientId: string,
        registry?: ProviderRegistry,
        options?: { scanIntervalMs?: number }
    ) {
        this.storage = storage;
        this.staticAuthFiles = Array.from(
            new Set(authFiles.map((key) => this.normalizeKey(key)).filter(Boolean))
        );
        this.clientId = clientId;
        this.registry = registry;
        this.scanIntervalMs = Math.max(5000, options?.scanIntervalMs ?? 30000);
    }

    async initialize() {
        // Do not hard-depend on KV full scan at startup.
        // KV list quota may be exhausted; D1 registry-first must still keep service available.
        await this.forceRescan('light');
    }

    private normalizeKey(key: string): string {
        return key.startsWith('./') ? key.substring(2) : key;
    }

    private async scanAndLoadProviders(mode: 'light' | 'full' = 'light') {
        const registryIds = (await this.registry?.listProviderIds()) || [];
        const aliasMap = (await this.registry?.getAliasMap()) || {};

        let kvDiscovered: string[] = [];
        const needsFullScan = mode === 'full' || (registryIds.length === 0 && this.staticAuthFiles.length === 0);
        if (needsFullScan) {
            try {
                const [dynamicQwen, dynamicQwenLegacy, dynamicOauth, dynamicOauthLegacy] = await Promise.all([
                    this.storage.list('qwen_creds_'),
                    this.storage.list('./qwen_creds_'),
                    this.storage.list('oauth_creds_'),
                    this.storage.list('./oauth_creds_')
                ]);
                kvDiscovered = [
                    ...dynamicQwen,
                    ...dynamicQwenLegacy,
                    ...dynamicOauth,
                    ...dynamicOauthLegacy
                ];
            } catch (e: any) {
                logger.warn(`[ProviderPool] KV full scan skipped: ${e?.message || e}`);
            }
        }

        const discoveredKeys = [
            ...this.staticAuthFiles,
            ...registryIds,
            ...kvDiscovered
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
        for (const provider of this.providers) {
            const status = provider.getRuntimeStatus();
            const alias = aliasMap[this.normalizeKey(status.id)];
            if (alias) {
                provider.setAlias(alias);
            }
        }
        if (this.currentIndex >= this.providers.length) {
            this.currentIndex = 0;
        }
    }

    private async forceRescan(mode: 'light' | 'full' = 'light'): Promise<void> {
        if (this.scanPromise) {
            await this.scanPromise;
            return;
        }
        this.scanPromise = this.scanAndLoadProviders(mode)
            .finally(() => {
                this.lastScanAt = Date.now();
                this.scanPromise = null;
            });
        await this.scanPromise;
    }

    private async ensureFreshPool(): Promise<void> {
        const now = Date.now();
        if (now - this.lastScanAt < this.scanIntervalMs) return;
        await this.forceRescan('light');
    }

    public async manualRescan(mode: 'light' | 'full' = 'full') {
        await this.forceRescan(mode);
    }

    public async addProvider(credsKey: string) {
        const normalized = this.normalizeKey(credsKey);
        await this.registry?.upsertProvider(normalized);
        const existing = this.providers.find((p) => p.getRuntimeStatus().id === normalized);
        if (existing) {
            logger.info(`Reloading provider ${normalized}...`);
            await existing.reload();
        } else {
            await this.forceRescan('light');
        }
    }

    public async removeProvider(credsKey: string) {
        const normalized = this.normalizeKey(credsKey);
        await this.registry?.removeProvider(normalized);
        this.providers = this.providers.filter((p) => p.getRuntimeStatus().id !== normalized);
        if (this.currentIndex >= this.providers.length) {
            this.currentIndex = 0;
        }
    }

    public async getAllProviderStatus(): Promise<ProviderStatus[]> {
        await this.ensureFreshPool();
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
        await this.ensureFreshPool();
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
        let quotaExceededCount = 0;
        let quotaBlockedCount = 0;

        for (let attempt = 0; attempt < availableProviders; attempt++) {
            const providerIndex = (startIndex + attempt) % availableProviders;
            const provider = this.providers[providerIndex];
            const status = provider.getRuntimeStatus();

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
                if (message.includes('Quota exceeded')) {
                    quotaExceededCount++;
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
                        error: 'All providers quota limited',
                        details: 'Gateway quota/RPM reached. Wait for next minute or adjust limits.'
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

        if (quotaExceededCount === triedCount && triedCount > 0) {
            return c.json(
                {
                    error: 'All providers quota exceeded',
                    details: 'Qwen free quota exhausted. Re-login with another account or wait for quota reset.'
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
        await this.ensureFreshPool();
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
                        error: 'All providers quota limited',
                        details: 'Gateway quota/RPM reached. Wait for next minute or adjust limits.'
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
