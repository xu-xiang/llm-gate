import { D1Database } from '@cloudflare/workers-types';
import { logger } from './logger';

export interface ProviderRecord {
    id: string;
    alias?: string;
}

export class ProviderRegistry {
    private db?: D1Database;

    public async init(db?: D1Database) {
        this.db = db;
    }

    private normalizeId(id: string): string {
        return id.startsWith('./') ? id.substring(2) : id;
    }

    public async listProviderIds(): Promise<string[]> {
        if (!this.db) return [];
        try {
            let rows = await this.db
                .prepare(`SELECT id FROM providers ORDER BY updated_at DESC`)
                .all();
            let ids = (rows.results || []).map((r: any) => this.normalizeId(String(r.id)));
            if (ids.length > 0) return ids;

            // Self-heal: bootstrap provider ids from historical usage/audit rows.
            const fallbackRows = await this.db
                .prepare(
                    `SELECT provider_id AS id FROM usage_stats
                     UNION
                     SELECT provider_id AS id FROM request_audit_minute
                     LIMIT 100`
                )
                .all();
            ids = (fallbackRows.results || []).map((r: any) => this.normalizeId(String(r.id)));
            ids = Array.from(new Set(ids.filter(Boolean)));

            if (ids.length > 0) {
                await Promise.all(ids.map((id) => this.upsertProvider(id)));
            }
            return ids;
        } catch (e) {
            logger.error('[ProviderRegistry] Failed to list providers', e);
            return [];
        }
    }

    public async getAliasMap(): Promise<Record<string, string>> {
        const out: Record<string, string> = {};
        if (!this.db) return out;
        try {
            const rows = await this.db
                .prepare(`SELECT id, alias FROM providers`)
                .all();
            for (const row of rows.results || []) {
                const id = this.normalizeId(String((row as any).id));
                const alias = String((row as any).alias || '').trim();
                if (alias) out[id] = alias;
            }
        } catch (e) {
            logger.error('[ProviderRegistry] Failed to load alias map', e);
        }
        return out;
    }

    public async upsertProvider(id: string, alias?: string): Promise<void> {
        if (!this.db) return;
        const cleanId = this.normalizeId(id);
        try {
            await this.db
                .prepare(
                    `INSERT INTO providers (id, alias, updated_at)
                     VALUES (?1, ?2, unixepoch())
                     ON CONFLICT(id)
                     DO UPDATE SET alias = COALESCE(excluded.alias, providers.alias), updated_at = unixepoch()`
                )
                .bind(cleanId, alias || null)
                .run();
        } catch (e) {
            logger.error('[ProviderRegistry] Failed to upsert provider', e);
        }
    }

    public async setAlias(id: string, alias: string): Promise<void> {
        if (!this.db) return;
        const cleanId = this.normalizeId(id);
        try {
            await this.db
                .prepare(
                    `INSERT INTO providers (id, alias, updated_at)
                     VALUES (?1, ?2, unixepoch())
                     ON CONFLICT(id)
                     DO UPDATE SET alias = excluded.alias, updated_at = unixepoch()`
                )
                .bind(cleanId, alias)
                .run();
        } catch (e) {
            logger.error('[ProviderRegistry] Failed to set alias', e);
        }
    }

    public async removeProvider(id: string): Promise<void> {
        if (!this.db) return;
        const cleanId = this.normalizeId(id);
        try {
            await this.db
                .prepare(`DELETE FROM providers WHERE id = ?1`)
                .bind(cleanId)
                .run();
        } catch (e) {
            logger.error('[ProviderRegistry] Failed to remove provider', e);
        }
    }
}

export const providerRegistry = new ProviderRegistry();
