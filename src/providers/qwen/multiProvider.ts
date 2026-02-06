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

    private async scanAndLoadProviders() {
        // 1. 获取动态 Key
        const dynamicKeys = await this.storage.list('qwen_creds_');
        
        // 2. 验证静态 Key
        const validStaticKeys: string[] = [];
        for (const key of this.staticAuthFiles) {
            const exists = await this.storage.get(key);
            if (exists) validStaticKeys.push(key);
        }
        
        // 合并
        const allActiveKeys = Array.from(new Set([...validStaticKeys, ...dynamicKeys]));
        logger.info(`Refreshing provider pool. Active: ${allActiveKeys.length}`);

        const currentMap = new Map(this.providers.map(p => [p.getStatus().id, p]));
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
    }

    public async addProvider(credsKey: string) {
        // If provider exists, reload it to pick up changes (e.g. alias update or new token)
        const existing = this.providers.find(p => p.getStatus().id === credsKey);
        if (existing) {
            logger.info(`Reloading provider ${credsKey}...`);
            await existing.reload();
        } else {
            // New provider, rescan
            await this.scanAndLoadProviders();
        }
    }

    public async removeProvider(credsKey: string) {
        // Assume storage delete happens outside, we just re-scan
        // Or we filter manually
        this.providers = this.providers.filter(p => p.getStatus().id !== credsKey);
    }

    public async getAllProviderStatus(): Promise<ProviderStatus[]> {
        return Promise.all(this.providers.map(p => p.getStatus()));
    }

    public getCurrentIndex(): number {
        return this.currentIndex;
    }

    async handleChatCompletion(c: Context): Promise<Response | void> {
        const availableProviders = this.providers.length;
        if (availableProviders === 0) {
            return c.json({ error: 'No Qwen providers configured' }, 500);
        }

        let lastError: any = null;
        let triedCount = 0;

        // Try rotating through all providers
        for (let attempt = 0; attempt < availableProviders; attempt++) {
            const providerIndex = (this.currentIndex + attempt) % availableProviders;
            const provider = this.providers[providerIndex];
            const status = provider.getStatus();

            // 1. Skip if provider is dead or initializing (unless it's the only one, then maybe wait?)
            if (status.status === 'error' && attempt < availableProviders - 1) {
                continue;
            }

            // 2. SMART ROUTING: Check local quota BEFORE making request
            // If we know this provider is out of quota, don't even try it.
            if (!quotaManager.checkQuota(status.id, 'chat')) {
                // Only log warning if we are skipping. If all are skipped, we'll return error at end.
                // logger.debug(`Skipping provider ${status.id} due to local quota limit.`);
                continue;
            }

            triedCount++;

            try {
                // Update sticky index for next request
                if (attempt === 0) {
                    this.currentIndex = (this.currentIndex + 1) % availableProviders;
                }

                logger.debug(`Attempting request with provider: ${status.id} (Attempt ${attempt + 1})`);
                
                return await provider.handleChatCompletion(c);
            } catch (err: any) {
                lastError = err;
                logger.warn(`Provider ${status.id} failed, trying next... Error: ${err.message}`);
            }
        }

        if (triedCount === 0) {
            return c.json({ 
                error: 'Quota Exceeded', 
                message: 'All providers have reached their daily or rate limits locally.' 
            }, 429);
        }

        return c.json({ 
            error: 'All providers failed', 
            details: lastError?.message 
        }, 500);
    }

    async handleWebSearch(c: Context): Promise<Response | void> {
        const availableProviders = this.providers.length;
        if (availableProviders === 0) {
            return c.json({ error: 'No Qwen providers configured' }, 500);
        }

        let lastError: any = null;
        let triedCount = 0;

        for (let attempt = 0; attempt < availableProviders; attempt++) {
            const providerIndex = (this.currentIndex + attempt) % availableProviders;
            const provider = this.providers[providerIndex];
            const status = provider.getStatus();

            if (status.status === 'error' && attempt < availableProviders - 1) {
                continue;
            }

            // SMART ROUTING CHECK
            if (!quotaManager.checkQuota(status.id, 'search')) {
                continue;
            }

            triedCount++;

            try {
                if (attempt === 0) {
                    this.currentIndex = (this.currentIndex + 1) % availableProviders;
                }
                return await provider.handleWebSearch(c);
            } catch (err: any) {
                lastError = err;
                logger.warn(`Search failed with provider ${status.id}, trying next...`);
            }
        }

        if (triedCount === 0) {
            return c.json({ 
                error: 'Quota Exceeded', 
                message: 'All search providers have reached their limits.' 
            }, 429);
        }

        return c.json({ error: 'All search providers failed', details: lastError?.message }, 500);
    }
}



