import { D1Database } from '@cloudflare/workers-types';
import { IStorage } from './storage';
import { logger } from './logger';

type UsageByType = { chat: number; search: number };

export interface DailyUsage {
    [date: string]: {
        [providerId: string]: UsageByType | number;
    };
}

class QuotaManager {
    private storage?: IStorage;
    private db?: D1Database;
    
    // In-memory buffer
    private pendingWrites: Map<string, number> = new Map();
    
    private usageCache: DailyUsage = {};
    private chatDailyLimit = 2000;
    private chatRpmLimit = 60;
    private searchDailyLimit = 0;
    private searchRpmLimit = 0;
    private rpmData: Record<string, any> = {};

    public async init(storage: IStorage, db?: D1Database) {
        this.storage = storage;
        this.db = db;
        
        const cached = await this.storage.get('quota_snapshot');
        if (cached) {
            this.usageCache = cached;
        } else if (this.db) {
            await this.loadFromDB();
        }
    }

    private async loadFromDB() {
        if (!this.db) return;
        const date = this.getBeijingDate();
        try {
            const results = await this.db.prepare(
                'SELECT provider_id, kind, count FROM usage_stats WHERE date = ?'
            ).bind(date).all();
            
            if (results.results) {
                this.usageCache[date] = {};
                for (const row of results.results as any[]) {
                    this.ensureUsageEntry(date, row.provider_id);
                    // @ts-ignore
                    this.usageCache[date][row.provider_id][row.kind] = row.count;
                }
                await this.storage?.set('quota_snapshot', this.usageCache, { expirationTtl: 3600 });
            }
        } catch (e) {
            logger.error('Failed to load quota from DB', e);
        }
    }

    private getBeijingDate(): string {
        const now = new Date();
        const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
        const beijingTime = new Date(utc + (3600000 * 8));
        return beijingTime.toISOString().split('T')[0];
    }

    private ensureUsageEntry(date: string, providerId: string): UsageByType {
        if (!this.usageCache[date]) this.usageCache[date] = {};
        if (!this.usageCache[date][providerId]) {
            this.usageCache[date][providerId] = { chat: 0, search: 0 };
        }
        const entry = this.usageCache[date][providerId];
        if (typeof entry === 'number') {
            this.usageCache[date][providerId] = { chat: entry, search: 0 };
            return this.usageCache[date][providerId] as UsageByType;
        }
        return entry as UsageByType;
    }

    public async incrementUsage(providerId: string, kind: 'chat' | 'search' = 'chat'): Promise<void> {
        const date = this.getBeijingDate();
        
        // 1. Update Memory
        const usage = this.ensureUsageEntry(date, providerId);
        usage[kind]++;

        // 2. Update RPM
        const currentMinute = Math.floor(Date.now() / 60000);
        if (!this.rpmData[providerId]) this.rpmData[providerId] = {};
        const bucket = this.rpmData[providerId][kind];
        if (!bucket || bucket.minute !== currentMinute) {
            this.rpmData[providerId][kind] = { count: 0, minute: currentMinute };
        }
        this.rpmData[providerId][kind].count++;

        // 3. Buffer for DB
        const bufferKey = `${date}|${providerId}|${kind}`;
        const currentBuffer = this.pendingWrites.get(bufferKey) || 0;
        this.pendingWrites.set(bufferKey, currentBuffer + 1);

        // 4. Flush immediately (async) to avoid data loss in serverless
        if (this.db) {
            await this.flushToDB();
        }
    }

    private async flushToDB() {
        if (!this.db || this.pendingWrites.size === 0) return;

        const batch = [];
        const entries = Array.from(this.pendingWrites.entries());
        this.pendingWrites.clear(); // Clear immediately to prevent double write

        for (const [key, count] of entries) {
            const [date, providerId, kind] = key.split('|');
            batch.push(this.db.prepare(`
                INSERT INTO usage_stats (date, provider_id, kind, count) 
                VALUES (?1, ?2, ?3, ?4) 
                ON CONFLICT(date, provider_id, kind) 
                DO UPDATE SET count = count + ?4
            `).bind(date, providerId, kind, count));
        }

        try {
            await this.db.batch(batch);
            // Sync snapshot to KV eventually
            await this.storage?.set('quota_snapshot', this.usageCache, { expirationTtl: 3600 });
        } catch (e) {
            logger.error('Failed to flush quota to D1', e);
            // Restore buffer on failure
            for (const [key, count] of entries) {
                this.pendingWrites.set(key, (this.pendingWrites.get(key) || 0) + count);
            }
        }
    }

    public checkQuota(providerId: string, kind: 'chat' | 'search' = 'chat'): boolean {
        const date = this.getBeijingDate();
        const usage = this.ensureUsageEntry(date, providerId);
        const dailyUsed = usage[kind];
        
        const dailyLimit = kind === 'chat' ? this.chatDailyLimit : this.searchDailyLimit;
        if (dailyLimit > 0 && dailyUsed >= dailyLimit) return false;

        const currentMinute = Math.floor(Date.now() / 60000);
        const rpmEntry = this.rpmData[providerId]?.[kind];
        if (rpmEntry && rpmEntry.minute === currentMinute) {
            const rpmLimit = kind === 'chat' ? this.chatRpmLimit : this.searchRpmLimit;
            if (rpmLimit > 0 && rpmEntry.count >= rpmLimit) return false;
        }

        return true;
    }

    public setLimits(limits: any) {
        if (limits.chat?.daily) this.chatDailyLimit = limits.chat.daily;
        if (limits.chat?.rpm) this.chatRpmLimit = limits.chat.rpm;
        if (limits.search?.daily) this.searchDailyLimit = limits.search.daily;
        if (limits.search?.rpm) this.searchRpmLimit = limits.search.rpm;
    }

    public getUsage(providerId: string) {
        const date = this.getBeijingDate();
        const usage = this.ensureUsageEntry(date, providerId);
        
        const currentMinute = Math.floor(Date.now() / 60000);
        const rpmEntry = this.rpmData[providerId];
        const chatRpmCount = rpmEntry?.chat?.minute === currentMinute ? rpmEntry.chat.count : 0;
        const searchRpmCount = rpmEntry?.search?.minute === currentMinute ? rpmEntry.search.count : 0;

        const chatDailyPercent = this.chatDailyLimit > 0 ? Math.min(100, (usage.chat / this.chatDailyLimit) * 100) : 0;
        const chatRpmPercent = this.chatRpmLimit > 0 ? Math.min(100, (chatRpmCount / this.chatRpmLimit) * 100) : 0;
        
        return {
            chat: {
                daily: { used: usage.chat, limit: this.chatDailyLimit, percent: chatDailyPercent },
                rpm: { used: chatRpmCount, limit: this.chatRpmLimit, percent: chatRpmPercent }
            },
            search: {
                daily: { used: usage.search, limit: this.searchDailyLimit, percent: 0 },
                rpm: { used: searchRpmCount, limit: this.searchRpmLimit, percent: 0 }
            }
        };
    }
}

export const quotaManager = new QuotaManager();
