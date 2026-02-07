import { D1Database } from '@cloudflare/workers-types';
import { getBeijingDate } from './time';

export class Monitor {
    private db?: D1Database;
    private statsCache?: { expiresAt: number; value: any };
    private readonly statsCacheTtlMs = 5000;

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
        if (this.statsCache && this.statsCache.expiresAt > Date.now()) {
            return this.statsCache.value;
        }

        try {
            const uptimeRow = await this.db
                .prepare("SELECT value FROM global_monitor WHERE key = 'uptime_start' LIMIT 1")
                .first<any>();
            const now = Math.floor(Date.now() / 1000);
            const uptimeStart = Number(uptimeRow?.value || now);
            const datePrefix = `${getBeijingDate()}%`;
            const rows = await this.db
                .prepare(
                    `SELECT kind,
                            SUM(count) as total,
                            SUM(CASE WHEN outcome = 'success' THEN count ELSE 0 END) as success,
                            SUM(CASE
                                WHEN outcome LIKE 'limited:%'
                                  OR outcome = 'error:upstream_429'
                                  OR outcome = 'error:upstream_quota_exceeded'
                                THEN count ELSE 0 END) as rate_limited,
                            SUM(CASE
                                WHEN outcome != 'success'
                                  AND outcome NOT LIKE 'limited:%'
                                  AND outcome != 'error:upstream_429'
                                  AND outcome != 'error:upstream_quota_exceeded'
                                THEN count ELSE 0 END) as error
                     FROM request_audit_minute
                     WHERE minute_bucket LIKE ?1
                     GROUP BY kind`
                )
                .bind(datePrefix)
                .all();

            const out = {
                uptime: now - uptimeStart,
                chat: {
                    total: 0,
                    success: 0,
                    error: 0,
                    rateLimited: 0
                },
                search: {
                    total: 0,
                    success: 0,
                    error: 0,
                    rateLimited: 0
                }
            };

            for (const row of rows.results as any[]) {
                const kind = row.kind === 'search' ? 'search' : 'chat';
                out[kind].total = Number(row.total || 0);
                out[kind].success = Number(row.success || 0);
                out[kind].error = Number(row.error || 0);
                out[kind].rateLimited = Number(row.rate_limited || 0);
            }

            this.statsCache = {
                value: out,
                expiresAt: Date.now() + this.statsCacheTtlMs
            };
            return out;
        } catch (e) {
            return this.getFallbackStats();
        }
    }

    private getFallbackStats() {
        return { uptime: 0, chat: { total: 0, success: 0, error: 0, rateLimited: 0 }, search: { total: 0, success: 0, error: 0, rateLimited: 0 } };
    }
}

export const monitor = new Monitor();
