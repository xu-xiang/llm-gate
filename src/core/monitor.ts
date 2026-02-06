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
    private startTime: number = Date.now();
    
    // Local buffer
    private buffer = {
        chat: { success: 0, error: 0, ratelimit: 0 },
        search: { success: 0, error: 0, ratelimit: 0 }
    };
    
    // Global cached stats (refreshed periodically)
    private globalStats = {
        uptimeStart: 0,
        chatTotal: 0,
        searchTotal: 0
    };

    public async init(db?: D1Database) {
        this.db = db;
        if (!db) return;

        try {
            const res = await db.prepare("SELECT value FROM global_monitor WHERE key = 'uptime_start'").first();
            if (res) {
                this.globalStats.uptimeStart = res.value as number;
            } else {
                const now = Math.floor(Date.now() / 1000);
                await db.prepare("INSERT OR IGNORE INTO global_monitor (key, value) VALUES ('uptime_start', ?)").bind(now).run();
                this.globalStats.uptimeStart = now;
            }
            
            const totals = await db.prepare("SELECT key, value FROM global_monitor WHERE key LIKE '%_total'").all();
            if (totals.results) {
                for (const row of totals.results as any[]) {
                    if (row.key === 'chat_total') this.globalStats.chatTotal = row.value;
                    if (row.key === 'search_total') this.globalStats.searchTotal = row.value;
                }
            }
        } catch (e) {
            console.error('Monitor init failed', e);
        }
    }

    // 修复：返回 Promise，确保 waitUntil 能等待它完成
    public async recordRequest(status: 'success' | 'error' | 'ratelimit', kind: 'chat' | 'search' = 'chat'): Promise<void> {
        // 1. Update memory state immediately for fast read
        this.buffer[kind][status]++;
        if (kind === 'chat') this.globalStats.chatTotal++;
        else this.globalStats.searchTotal++;

        // 2. Persist to DB
        if (this.db) {
            await this.flushToDB();
        }
    }

    private async flushToDB() {
        if (!this.db) return;
        
        const b = this.buffer;
        // Snapshot current buffer
        const chatSuccess = b.chat.success;
        const chatError = b.chat.error;
        const searchSuccess = b.search.success;

        // Reset memory buffer immediately
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
            try {
                await this.db.batch(batch);
            } catch (e) {
                console.error('Monitor flush failed', e);
            }
        }
    }

    private updateStat(key: string, delta: number) {
        return this.db!.prepare(`
            INSERT INTO global_monitor (key, value) VALUES (?1, ?2)
            ON CONFLICT(key) DO UPDATE SET value = value + ?2
        `).bind(key, delta);
    }

    public getStats() {
        const now = Math.floor(Date.now() / 1000);
        const uptime = this.globalStats.uptimeStart > 0 ? (now - this.globalStats.uptimeStart) : 0;
        
        return {
            uptime,
            chat: {
                total: this.globalStats.chatTotal,
                success: 0, 
                error: 0,
                rateLimited: 0
            },
            search: {
                total: this.globalStats.searchTotal,
                success: 0,
                error: 0,
                rateLimited: 0
            }
        };
    }
}

export const monitor = new Monitor();
