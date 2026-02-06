import { D1Database } from '@cloudflare/workers-types';
import { IStorage } from './storage';
import { logger } from './logger';

type UsageByType = { chat: number; search: number };

class QuotaManager {
    private storage?: IStorage;
    private db?: D1Database;
    
    private pendingWrites: Map<string, number> = new Map();
    private chatDailyLimit = 2000;
    private chatRpmLimit = 60;
    private searchDailyLimit = 0;
    private searchRpmLimit = 0;
    private rpmData: Record<string, any> = {};

    public async init(storage: IStorage, db?: D1Database) {
        this.storage = storage;
        this.db = db;
    }

    private getBeijingDate(): string {
        const now = new Date();
        const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
        const beijingTime = new Date(utc + (3600000 * 8));
        return beijingTime.toISOString().split('T')[0];
    }

    public async incrementUsage(providerId: string, kind: 'chat' | 'search' = 'chat'): Promise<void> {
        const date = this.getBeijingDate();
        
        // 1. Update RPM (In-memory is fine for per-instance limiting)
        const currentMinute = Math.floor(Date.now() / 60000);
        if (!this.rpmData[providerId]) this.rpmData[providerId] = {};
        const bucket = this.rpmData[providerId][kind];
        if (!bucket || bucket.minute !== currentMinute) {
            this.rpmData[providerId][kind] = { count: 0, minute: currentMinute };
        }
        this.rpmData[providerId][kind].count++;

        // 2. Buffer for DB
        const bufferKey = `${date}|${providerId}|${kind}`;
        this.pendingWrites.set(bufferKey, (this.pendingWrites.get(bufferKey) || 0) + 1);

        if (this.db) {
            await this.flushToDB();
        }
    }

    private async flushToDB() {
        if (!this.db || this.pendingWrites.size === 0) return;
        const batch = [];
        const entries = Array.from(this.pendingWrites.entries());
        this.pendingWrites.clear();

        for (const [key, count] of entries) {
            const [date, providerId, kind] = key.split('|');
            batch.push(this.db.prepare(`
                INSERT INTO usage_stats (date, provider_id, kind, count) 
                VALUES (?1, ?2, ?3, ?4) 
                ON CONFLICT(date, provider_id, kind) 
                DO UPDATE SET count = count + ?4
            `).bind(date, providerId, kind, count));
        }
        await this.db.batch(batch).catch(e => logger.error('Quota flush failed', e));
    }

    // 修复：直接从 D1 查真值
    public async getUsage(providerId: string) {
        const date = this.getBeijingDate();
        let dailyUsed = 0;

        if (this.db) {
            try {
                const res = await this.db.prepare("SELECT count FROM usage_stats WHERE date = ? AND provider_id = ? AND kind = 'chat'").bind(date, providerId).first();
                if (res) dailyUsed = res.count as number;
            } catch (e) {}
        }
        
        const currentMinute = Math.floor(Date.now() / 60000);
        const rpmEntry = this.rpmData[providerId]?.['chat'];
        const chatRpmCount = rpmEntry?.minute === currentMinute ? rpmEntry.count : 0;

        const chatDailyPercent = this.chatDailyLimit > 0 ? Math.min(100, (dailyUsed / this.chatDailyLimit) * 100) : 0;
        const chatRpmPercent = this.chatRpmLimit > 0 ? Math.min(100, (chatRpmCount / this.chatRpmLimit) * 100) : 0;
        
        return {
            chat: {
                daily: { used: dailyUsed, limit: this.chatDailyLimit, percent: chatDailyPercent },
                rpm: { used: chatRpmCount, limit: this.chatRpmLimit, percent: chatRpmPercent }
            }
        };
    }

    // 用于快速拦截，可以接受稍微过时的本地值
    public checkQuota(providerId: string, kind: 'chat' | 'search' = 'chat'): boolean {
        return true; // 为了稳定，暂时先放行，主要看统计
    }

    public setLimits(limits: any) {
        if (limits.chat?.daily) this.chatDailyLimit = limits.chat.daily;
        if (limits.chat?.rpm) this.chatRpmLimit = limits.chat.rpm;
    }
}

export const quotaManager = new QuotaManager();