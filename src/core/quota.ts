import { D1Database } from '@cloudflare/workers-types';
import { IStorage } from './storage';
import { logger } from './logger';

type UsageByType = { chat: number; search: number };

class QuotaManager {
    private storage?: IStorage;
    private db?: D1Database;
    
    // Buffer both Account usage and Global stats
    private pendingWrites: Map<string, number> = new Map();
    private globalBuffer = { chat: 0, search: 0 };
    
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

    // Unified Increment Method
    public async incrementUsage(providerId: string, kind: 'chat' | 'search' = 'chat'): Promise<void> {
        const date = this.getBeijingDate();
        
        // 1. Update RPM (Local Memory)
        const currentMinute = Math.floor(Date.now() / 60000);
        if (!this.rpmData[providerId]) this.rpmData[providerId] = {};
        const bucket = this.rpmData[providerId][kind];
        if (!bucket || bucket.minute !== currentMinute) {
            this.rpmData[providerId][kind] = { count: 0, minute: currentMinute };
        }
        this.rpmData[providerId][kind].count++;

        // 2. Buffer Account Usage
        // Ensure providerId is clean (no ./ prefix for consistency)
        const cleanId = providerId.startsWith('./') ? providerId.substring(2) : providerId;
        const bufferKey = `${date}|${cleanId}|${kind}`;
        this.pendingWrites.set(bufferKey, (this.pendingWrites.get(bufferKey) || 0) + 1);

        // 3. Buffer Global Stats
        if (kind === 'chat') this.globalBuffer.chat++;
        else this.globalBuffer.search++;

        // 4. Flush Immediately (One Batch)
        if (this.db) {
            await this.flushToDB();
        }
    }

    private async flushToDB() {
        if (!this.db) return;
        
        const batch = [];
        
        // A. Account Usage Updates
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

        // B. Global Monitor Updates (Merged here!)
        const chatCount = this.globalBuffer.chat;
        const searchCount = this.globalBuffer.search;
        this.globalBuffer = { chat: 0, search: 0 };

        if (chatCount > 0) {
            batch.push(this.db.prepare("INSERT INTO global_monitor (key, value) VALUES ('chat_total', ?1) ON CONFLICT(key) DO UPDATE SET value = value + ?1").bind(chatCount));
        }
        if (searchCount > 0) {
            batch.push(this.db.prepare("INSERT INTO global_monitor (key, value) VALUES ('search_total', ?1) ON CONFLICT(key) DO UPDATE SET value = value + ?1").bind(searchCount));
        }

        if (batch.length > 0) {
            await this.db.batch(batch).catch(e => logger.error('Stats flush failed', e));
        }
    }

    public async getUsage(providerId: string) {
        const date = this.getBeijingDate();
        let dailyUsed = 0;

        if (this.db) {
            try {
                // Read with clean ID
                const cleanId = providerId.startsWith('./') ? providerId.substring(2) : providerId;
                // Double check both to be safe
                let res = await this.db.prepare("SELECT count FROM usage_stats WHERE date = ? AND provider_id = ? AND kind = 'chat'").bind(date, cleanId).first();
                if (!res) {
                     res = await this.db.prepare("SELECT count FROM usage_stats WHERE date = ? AND provider_id = ? AND kind = 'chat'").bind(date, `./${cleanId}`).first();
                }
                if (res) dailyUsed = res.count as number;
            } catch (e) {
                logger.error('[Quota] D1 Read Error', e);
            }
        }
        
        // RPM logic remains same
        const currentMinute = Math.floor(Date.now() / 60000);
        const rpmEntry = this.rpmData[providerId]?.['chat'];
        const chatRpmCount = rpmEntry?.minute === currentMinute ? rpmEntry.count : 0;
        
        // Calculate Percents
        const chatDailyPercent = this.chatDailyLimit > 0 ? Math.min(100, (dailyUsed / this.chatDailyLimit) * 100) : 0;
        const chatRpmPercent = this.chatRpmLimit > 0 ? Math.min(100, (chatRpmCount / this.chatRpmLimit) * 100) : 0;

        return {
            chat: {
                daily: { used: dailyUsed, limit: this.chatDailyLimit, percent: chatDailyPercent },
                rpm: { used: chatRpmCount, limit: this.chatRpmLimit, percent: chatRpmPercent }
            }
        };
    }

    public checkQuota(providerId: string, kind: 'chat' | 'search' = 'chat'): boolean { return true; }
    public setLimits(limits: any) {
        if (limits.chat?.daily) this.chatDailyLimit = limits.chat.daily;
        if (limits.chat?.rpm) this.chatRpmLimit = limits.chat.rpm;
    }
}

export const quotaManager = new QuotaManager();
