import { D1Database } from '@cloudflare/workers-types';
import { IStorage } from './storage';
import { logger } from './logger';
import { getBeijingDate, getBeijingMinuteBucket } from './time';

type UsageKind = 'chat' | 'search';
type LimitReason = 'daily' | 'rpm';

type UsageByType = { chat: number; search: number };
type RpmBucket = { minute: number; count: number };
type CachedUsage = { expiresAt: number; usage: UsageByType };

class QuotaManager {
    private storage?: IStorage;
    private db?: D1Database;

    private pendingUsageWrites: Map<string, number> = new Map();
    private pendingAuditWrites: Map<string, number> = new Map();
    private globalBuffer: Record<string, number> = {};

    private chatDailyLimit = 2000;
    private chatRpmLimit = 60;
    private searchDailyLimit = 0;
    private searchRpmLimit = 0;

    private rpmData: Record<string, Record<UsageKind, RpmBucket>> = {};
    private usageCache: Map<string, CachedUsage> = new Map();

    private readonly usageCacheTtlMs = 5000;
    private flushChain: Promise<void> = Promise.resolve();
    private auditSuccessEnabled = false;

    public async init(storage: IStorage, db?: D1Database) {
        this.storage = storage;
        this.db = db;
    }

    public setAuditOptions(options?: { success?: boolean }) {
        if (typeof options?.success === 'boolean') {
            this.auditSuccessEnabled = options.success;
        }
    }

    public isReady(): boolean {
        return Boolean(this.storage);
    }

    private normalizeProviderId(providerId: string): string {
        return providerId.startsWith('./') ? providerId.substring(2) : providerId;
    }

    private getRpmCount(providerId: string, kind: UsageKind): number {
        const cleanId = this.normalizeProviderId(providerId);
        const currentMinute = Math.floor(Date.now() / 60000);
        const entry = this.rpmData[cleanId]?.[kind];
        if (!entry || entry.minute !== currentMinute) return 0;
        return entry.count;
    }

    private bumpRpm(providerId: string, kind: UsageKind): number {
        const cleanId = this.normalizeProviderId(providerId);
        const currentMinute = Math.floor(Date.now() / 60000);

        if (!this.rpmData[cleanId]) {
            this.rpmData[cleanId] = {
                chat: { minute: currentMinute, count: 0 },
                search: { minute: currentMinute, count: 0 }
            };
        }

        const bucket = this.rpmData[cleanId][kind];
        if (bucket.minute !== currentMinute) {
            bucket.minute = currentMinute;
            bucket.count = 0;
        }

        bucket.count += 1;
        return bucket.count;
    }

    private mergeUsageToCache(providerId: string, kind: UsageKind, delta: number) {
        const cleanId = this.normalizeProviderId(providerId);
        const now = Date.now();
        const cached = this.usageCache.get(cleanId);

        const usage: UsageByType = cached
            ? { ...cached.usage }
            : { chat: 0, search: 0 };

        usage[kind] = Math.max(0, usage[kind] + delta);
        this.usageCache.set(cleanId, {
            usage,
            expiresAt: now + this.usageCacheTtlMs
        });
    }

    private bufferUsage(providerId: string, kind: UsageKind, count: number) {
        const cleanId = this.normalizeProviderId(providerId);
        const date = getBeijingDate();
        const usageKey = `${date}|${cleanId}|${kind}`;
        this.pendingUsageWrites.set(usageKey, (this.pendingUsageWrites.get(usageKey) || 0) + count);
    }

    private bufferAudit(providerId: string, kind: UsageKind, outcome: string, count = 1) {
        const cleanId = this.normalizeProviderId(providerId);
        const minuteBucket = getBeijingMinuteBucket();
        const auditKey = `${minuteBucket}|${cleanId}|${kind}|${outcome}`;
        this.pendingAuditWrites.set(auditKey, (this.pendingAuditWrites.get(auditKey) || 0) + count);
    }

    private bumpGlobal(key: string, count = 1) {
        this.globalBuffer[key] = (this.globalBuffer[key] || 0) + count;
    }

    private async loadUsageFromDb(providerId: string): Promise<UsageByType> {
        if (!this.db) return { chat: 0, search: 0 };

        const cleanId = this.normalizeProviderId(providerId);
        const date = getBeijingDate();

        try {
            const rows = await this.db
                .prepare(`
                    SELECT kind, SUM(count) as count
                    FROM usage_stats
                    WHERE date = ?1 AND provider_id IN (?2, ?3)
                    GROUP BY kind
                `)
                .bind(date, cleanId, `./${cleanId}`)
                .all();

            const usage: UsageByType = { chat: 0, search: 0 };
            for (const row of rows.results as any[]) {
                const kind = row.kind as UsageKind;
                if (kind === 'chat' || kind === 'search') {
                    usage[kind] = Number(row.count || 0);
                }
            }
            return usage;
        } catch (e) {
            logger.error('[Quota] Failed to load usage from D1', e);
            return { chat: 0, search: 0 };
        }
    }

    private async getUsageSnapshot(providerId: string): Promise<UsageByType> {
        const cleanId = this.normalizeProviderId(providerId);
        const now = Date.now();
        const cached = this.usageCache.get(cleanId);
        if (cached && cached.expiresAt > now) {
            return cached.usage;
        }

        const usage = await this.loadUsageFromDb(cleanId);
        this.usageCache.set(cleanId, {
            usage,
            expiresAt: now + this.usageCacheTtlMs
        });
        return usage;
    }

    private async getCurrentMinuteUsageFromDb(providerId: string): Promise<UsageByType> {
        if (!this.db) return { chat: 0, search: 0 };
        const cleanId = this.normalizeProviderId(providerId);
        const minuteBucket = getBeijingMinuteBucket();
        try {
            const rows = await this.db
                .prepare(`
                    SELECT kind, SUM(count) as count
                    FROM request_audit_minute
                    WHERE minute_bucket = ?1
                      AND provider_id IN (?2, ?3)
                    GROUP BY kind
                `)
                .bind(minuteBucket, cleanId, `./${cleanId}`)
                .all();

            const usage: UsageByType = { chat: 0, search: 0 };
            for (const row of rows.results as any[]) {
                const kind = row.kind as UsageKind;
                if (kind === 'chat' || kind === 'search') {
                    usage[kind] = Number(row.count || 0);
                }
            }
            return usage;
        } catch (e) {
            logger.error('[Quota] Failed to load minute usage from D1', e);
            return { chat: this.getRpmCount(providerId, 'chat'), search: this.getRpmCount(providerId, 'search') };
        }
    }

    public async checkQuota(providerId: string, kind: UsageKind = 'chat'): Promise<{ allowed: boolean; reason?: LimitReason }> {
        const usage = await this.getUsageSnapshot(providerId);
        const dailyUsed = usage[kind];
        const rpmUsed = this.getRpmCount(providerId, kind);

        const dailyLimit = kind === 'chat' ? this.chatDailyLimit : this.searchDailyLimit;
        const rpmLimit = kind === 'chat' ? this.chatRpmLimit : this.searchRpmLimit;

        if (dailyLimit > 0 && dailyUsed >= dailyLimit) {
            await this.recordLimitHit(providerId, kind, 'daily');
            return { allowed: false, reason: 'daily' };
        }

        if (rpmLimit > 0 && rpmUsed >= rpmLimit) {
            await this.recordLimitHit(providerId, kind, 'rpm');
            return { allowed: false, reason: 'rpm' };
        }

        return { allowed: true };
    }

    public async incrementUsage(providerId: string, kind: UsageKind = 'chat'): Promise<void> {
        this.bumpRpm(providerId, kind);
        this.bufferUsage(providerId, kind, 1);
        // Always persist minute-level success aggregate so RPM is accurate across isolates.
        this.bufferAudit(providerId, kind, 'success', 1);

        this.bumpGlobal(`${kind}_total`, 1);
        this.bumpGlobal(`${kind}_success`, 1);

        this.mergeUsageToCache(providerId, kind, 1);

        await this.flushBufferedWrites();
    }

    public async recordFailure(providerId: string, kind: UsageKind, reason: string): Promise<void> {
        this.bumpRpm(providerId, kind);
        this.bufferUsage(providerId, kind, 1);
        this.bufferAudit(providerId, kind, `error:${reason}`, 1);
        this.bumpGlobal(`${kind}_total`, 1);
        this.bumpGlobal(`${kind}_error`, 1);
        this.mergeUsageToCache(providerId, kind, 1);
        await this.flushBufferedWrites();
    }

    public async recordLimitHit(providerId: string, kind: UsageKind, reason: LimitReason): Promise<void> {
        this.bumpRpm(providerId, kind);
        this.bufferUsage(providerId, kind, 1);
        this.bufferAudit(providerId, kind, `limited:${reason}`, 1);
        this.bumpGlobal(`${kind}_total`, 1);
        this.bumpGlobal(`${kind}_rate_limited`, 1);
        this.mergeUsageToCache(providerId, kind, 1);
        await this.flushBufferedWrites();
    }

    private async flushToDB() {
        if (!this.db) return;

        const usageEntries = Array.from(this.pendingUsageWrites.entries());
        const auditEntries = Array.from(this.pendingAuditWrites.entries());
        const globalEntries = Object.entries(this.globalBuffer).filter(([, value]) => value > 0);

        this.pendingUsageWrites.clear();
        this.pendingAuditWrites.clear();
        this.globalBuffer = {};

        const batch = [];

        for (const [key, count] of usageEntries) {
            const [date, providerId, kind] = key.split('|');
            batch.push(
                this.db
                    .prepare(`
                        INSERT INTO usage_stats (date, provider_id, kind, count)
                        VALUES (?1, ?2, ?3, ?4)
                        ON CONFLICT(date, provider_id, kind)
                        DO UPDATE SET count = count + excluded.count
                    `)
                    .bind(date, providerId, kind, count)
            );
        }

        for (const [key, count] of auditEntries) {
            const [minuteBucket, providerId, kind, outcome] = key.split('|');
            batch.push(
                this.db
                    .prepare(`
                        INSERT INTO request_audit_minute (minute_bucket, provider_id, kind, outcome, count)
                        VALUES (?1, ?2, ?3, ?4, ?5)
                        ON CONFLICT(minute_bucket, provider_id, kind, outcome)
                        DO UPDATE SET count = count + excluded.count
                    `)
                    .bind(minuteBucket, providerId, kind, outcome, count)
            );
        }

        for (const [key, count] of globalEntries) {
            batch.push(
                this.db
                    .prepare(`
                        INSERT INTO global_monitor (key, value)
                        VALUES (?1, ?2)
                        ON CONFLICT(key)
                        DO UPDATE SET value = value + excluded.value
                    `)
                    .bind(key, count)
            );
        }

        if (batch.length === 0) return;

        await this.db.batch(batch).catch((e) => {
            logger.error('[Quota] Stats flush failed', e);
        });
    }

    private async flushBufferedWrites() {
        if (!this.db) return;

        this.flushChain = this.flushChain
            .then(() => this.flushToDB())
            .catch((e) => {
                logger.error('[Quota] Flush chain failed', e);
            });

        await this.flushChain;
    }

    public async getUsage(providerId: string) {
        const usage = await this.getUsageSnapshot(providerId);
        const rpmUsage = await this.getCurrentMinuteUsageFromDb(providerId);
        const chatRpmCount = rpmUsage.chat;
        const searchRpmCount = rpmUsage.search;

        const chatDailyPercent = this.chatDailyLimit > 0 ? Math.min(100, (usage.chat / this.chatDailyLimit) * 100) : 0;
        const chatRpmPercent = this.chatRpmLimit > 0 ? Math.min(100, (chatRpmCount / this.chatRpmLimit) * 100) : 0;

        const searchDailyPercent = this.searchDailyLimit > 0 ? Math.min(100, (usage.search / this.searchDailyLimit) * 100) : 0;
        const searchRpmPercent = this.searchRpmLimit > 0 ? Math.min(100, (searchRpmCount / this.searchRpmLimit) * 100) : 0;

        return {
            chat: {
                daily: { used: usage.chat, limit: this.chatDailyLimit, percent: chatDailyPercent },
                rpm: { used: chatRpmCount, limit: this.chatRpmLimit, percent: chatRpmPercent }
            },
            search: {
                daily: { used: usage.search, limit: this.searchDailyLimit, percent: searchDailyPercent },
                rpm: { used: searchRpmCount, limit: this.searchRpmLimit, percent: searchRpmPercent }
            }
        };
    }

    public async getUsageBatch(providerIds: string[]) {
        const result: Record<string, Awaited<ReturnType<QuotaManager['getUsage']>>> = {};
        if (providerIds.length === 0) return result;

        const cleanedIds = Array.from(new Set(providerIds.map((id) => this.normalizeProviderId(id))));
        const queryIds = Array.from(new Set(cleanedIds.flatMap((id) => [id, `./${id}`])));
        const placeholders = queryIds.map((_, idx) => `?${idx + 2}`).join(', ');
        const date = getBeijingDate();
        const minute = getBeijingMinuteBucket();

        const usageMap: Record<string, UsageByType> = {};
        const rpmMap: Record<string, UsageByType> = {};
        for (const id of cleanedIds) {
            usageMap[id] = { chat: 0, search: 0 };
            rpmMap[id] = { chat: 0, search: 0 };
        }

        if (this.db) {
            try {
                const usageRows = await this.db
                    .prepare(
                        `
                        SELECT provider_id, kind, SUM(count) AS count
                        FROM usage_stats
                        WHERE date = ?1 AND provider_id IN (${placeholders})
                        GROUP BY provider_id, kind
                        `
                    )
                    .bind(date, ...queryIds)
                    .all();

                for (const row of usageRows.results as any[]) {
                    const provider = this.normalizeProviderId(String(row.provider_id));
                    const kind = row.kind as UsageKind;
                    if (!usageMap[provider]) usageMap[provider] = { chat: 0, search: 0 };
                    if (kind === 'chat' || kind === 'search') {
                        usageMap[provider][kind] = Number(row.count || 0);
                    }
                }
            } catch (e) {
                logger.error('[Quota] Batch usage read failed', e);
            }

            try {
                const rpmRows = await this.db
                    .prepare(
                        `
                        SELECT provider_id, kind, SUM(count) AS count
                        FROM request_audit_minute
                        WHERE minute_bucket = ?1 AND provider_id IN (${placeholders})
                        GROUP BY provider_id, kind
                        `
                    )
                    .bind(minute, ...queryIds)
                    .all();

                for (const row of rpmRows.results as any[]) {
                    const provider = this.normalizeProviderId(String(row.provider_id));
                    const kind = row.kind as UsageKind;
                    if (!rpmMap[provider]) rpmMap[provider] = { chat: 0, search: 0 };
                    if (kind === 'chat' || kind === 'search') {
                        rpmMap[provider][kind] = Number(row.count || 0);
                    }
                }
            } catch (e) {
                logger.error('[Quota] Batch rpm read failed', e);
            }
        }

        for (const id of cleanedIds) {
            const usage = usageMap[id] || { chat: 0, search: 0 };
            const rpmUsage = rpmMap[id] || { chat: 0, search: 0 };
            const chatDailyPercent = this.chatDailyLimit > 0 ? Math.min(100, (usage.chat / this.chatDailyLimit) * 100) : 0;
            const chatRpmPercent = this.chatRpmLimit > 0 ? Math.min(100, (rpmUsage.chat / this.chatRpmLimit) * 100) : 0;
            const searchDailyPercent = this.searchDailyLimit > 0 ? Math.min(100, (usage.search / this.searchDailyLimit) * 100) : 0;
            const searchRpmPercent = this.searchRpmLimit > 0 ? Math.min(100, (rpmUsage.search / this.searchRpmLimit) * 100) : 0;

            result[id] = {
                chat: {
                    daily: { used: usage.chat, limit: this.chatDailyLimit, percent: chatDailyPercent },
                    rpm: { used: rpmUsage.chat, limit: this.chatRpmLimit, percent: chatRpmPercent }
                },
                search: {
                    daily: { used: usage.search, limit: this.searchDailyLimit, percent: searchDailyPercent },
                    rpm: { used: rpmUsage.search, limit: this.searchRpmLimit, percent: searchRpmPercent }
                }
            };
        }

        return result;
    }

    public setLimits(limits: any) {
        if (typeof limits.chat?.daily === 'number') this.chatDailyLimit = limits.chat.daily;
        if (typeof limits.chat?.rpm === 'number') this.chatRpmLimit = limits.chat.rpm;
        if (typeof limits.search?.daily === 'number') this.searchDailyLimit = limits.search.daily;
        if (typeof limits.search?.rpm === 'number') this.searchRpmLimit = limits.search.rpm;
    }

    public async getRecentAudit(limit = 120) {
        if (!this.db) return [];
        try {
            const successClause = this.auditSuccessEnabled ? '' : "WHERE outcome != 'success'";
            const rows = await this.db
                .prepare(
                    `SELECT minute_bucket, provider_id, kind, outcome, count
                     FROM request_audit_minute
                     ${successClause}
                     ORDER BY minute_bucket DESC
                     LIMIT ?1`
                )
                .bind(limit)
                .all();
            return rows.results || [];
        } catch (e) {
            logger.error('[Quota] Failed to read recent audit logs', e);
            return [];
        }
    }
}

export const quotaManager = new QuotaManager();
