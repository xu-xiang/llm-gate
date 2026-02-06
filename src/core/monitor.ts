import { D1Database } from '@cloudflare/workers-types';

export class Monitor {
    private db?: D1Database;

    public async init(db?: D1Database) {
        this.db = db;
        if (!db) return;
        // Ensure uptime start is set once
        const now = Math.floor(Date.now() / 1000);
        await db.prepare("INSERT OR IGNORE INTO global_monitor (key, value) VALUES ('uptime_start', ?)").bind(now).run().catch(() => {});
    }

    // Deprecated: No-op because QuotaManager handles writes now
    public async recordRequest(status: any, kind: any) {
        // Leaving this empty but keeping signature for compatibility if needed
    }

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
                    success: 0, 
                    error: 0,
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
