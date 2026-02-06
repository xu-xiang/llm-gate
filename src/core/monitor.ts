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

        // 1. Get or Set global start time
        try {
            const res = await db.prepare("SELECT value FROM global_monitor WHERE key = 'uptime_start'").first();
            if (res) {
                this.globalStats.uptimeStart = res.value as number;
            } else {
                const now = Math.floor(Date.now() / 1000);
                await db.prepare("INSERT OR IGNORE INTO global_monitor (key, value) VALUES ('uptime_start', ?)").bind(now).run();
                this.globalStats.uptimeStart = now;
            }
            
            // 2. Load total counts
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

    public recordRequest(status: 'success' | 'error' | 'ratelimit', kind: 'chat' | 'search' = 'chat') {
        // Update local buffer
        this.buffer[kind][status]++;
        
        // Update local cache for immediate display
        if (kind === 'chat') this.globalStats.chatTotal++;
        else this.globalStats.searchTotal++;

        // Async flush to DB (fire and forget)
        if (this.db) {
            this.flushToDB(); // In reality, we should debounce this
        }
    }

    private async flushToDB() {
        if (!this.db) return;
        // Simple immediate flush for now, can be optimized with batching if high load
        // But D1 batch is efficient enough for moderate load
        // We accumulate in buffer and flush every few requests or seconds
        // For simplicity in this demo, let's just assume this is called inside waitUntil context
        
        const b = this.buffer;
        // Reset buffer
        this.buffer = { chat: { success: 0, error: 0, ratelimit: 0 }, search: { success: 0, error: 0, ratelimit: 0 } };

        const batch = [];
        // Chat updates
        if (b.chat.success) batch.push(this.updateStat('chat_total', b.chat.success));
        if (b.chat.success) batch.push(this.updateStat('chat_success', b.chat.success));
        if (b.chat.error) batch.push(this.updateStat('chat_error', b.chat.error));
        
        // Search updates
        if (b.search.success) batch.push(this.updateStat('search_total', b.search.success));
        
        if (batch.length > 0) {
            this.db.batch(batch).catch(e => console.error('Monitor flush failed', e));
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
                success: 0, // Simplified for read (would need separate query)
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