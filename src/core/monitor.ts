import { D1Database } from '@cloudflare/workers-types';

export interface RequestStats {
    total: number;
    success: number;
    error: number;
    rateLimited: number;
    lastRequestTime?: Date;
}

class Monitor {
    private db?: D1Database;
    
    private buffer = {
        chat: { success: 0, error: 0, ratelimit: 0 },
        search: { success: 0, error: 0, ratelimit: 0 }
    };

    public async init(db?: D1Database) {
        this.db = db;
    }

    public async recordRequest(status: 'success' | 'error' | 'ratelimit', kind: 'chat' | 'search' = 'chat'): Promise<void> {
        this.buffer[kind][status]++;
        if (this.db) {
            await this.flushToDB();
        }
    }

    private async flushToDB() {
        if (!this.db) return;
        const b = this.buffer;
        const chatSuccess = b.chat.success;
        const chatError = b.chat.error;
        const searchSuccess = b.search.success;

        b.chat.success = 0; b.chat.error = 0; b.chat.ratelimit = 0;
        b.search.success = 0; b.search.error = 0; b.search.ratelimit = 0;

        const batch = [];
        if (chatSuccess) {
            batch.push(this.updateStat('chat_total', chatSuccess));
            batch.push(this.updateStat('chat_success', chatSuccess));
        }
        if (chatError) batch.push(this.updateStat('chat_error', chatError));
        if (searchSuccess) batch.push(this.updateStat('search_total', searchSuccess));
        
        if (batch.length > 0) {
            await this.db.batch(batch).catch(e => console.error('Monitor flush failed', e));
        }
    }

    private updateStat(key: string, delta: number) {
        return this.db!.prepare(`
            INSERT INTO global_monitor (key, value) VALUES (?1, ?2)
            ON CONFLICT(key) DO UPDATE SET value = value + ?2
        `).bind(key, delta);
    }

    // 关键修复：直接从 D1 读取全网数据
    public async getStats() {
        if (!this.db) return this.getFallbackStats();

        try {
            const results = await this.db.prepare("SELECT key, value FROM global_monitor").all();
            const statsMap: Record<string, number> = {};
            results.results.forEach((row: any) => {
                statsMap[row.key] = row.value;
            });

            const now = Math.floor(Date.now() / 1000);
            const uptimeStart = statsMap['uptime_start'] || now;
            
            return {
                uptime: now - uptimeStart,
                chat: {
                    total: statsMap['chat_total'] || 0,
                    success: statsMap['chat_success'] || 0,
                    error: statsMap['chat_error'] || 0,
                    rateLimited: 0
                },
                search: {
                    total: statsMap['search_total'] || 0,
                    success: 0,
                    error: 0,
                    rateLimited: 0
                }
            };
        } catch (e) {
            return this.getFallbackStats();
        }
    }

    private getFallbackStats() {
        return { uptime: 0, chat: { total: 0, success: 0, error: 0, rateLimited: 0 }, search: { total: 0, success: 0, error: 0, rateLimited: 0 } };
    }
}

export const monitor = new Monitor();