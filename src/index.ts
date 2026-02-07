import { KVNamespace, D1Database } from '@cloudflare/workers-types';
import { createApp } from './app';
import { loadConfig } from './config';
import { KVStorage } from './core/storage';
import { quotaManager } from './core/quota';
import { monitor } from './core/monitor';

export interface Env {
  AUTH_STORE: KVNamespace;
  DB: D1Database;
  
  API_KEY?: string;
  LOG_LEVEL?: string;
  CONFIG_YAML?: string;
  MODEL_MAPPINGS?: string;
  QWEN_CLIENT_ID?: string;
  QWEN_CREDS_JSON?: string;
  CHAT_DAILY_LIMIT?: string;
  CHAT_RPM_LIMIT?: string;
  SEARCH_DAILY_LIMIT?: string;
  SEARCH_RPM_LIMIT?: string;
  AUDIT_SUCCESS_LOG?: string;
}

let appInstance: any;

async function seedCredentialsIfNeeded(env: Env, storage: KVStorage) {
    if (!env.QWEN_CREDS_JSON) return;
    const exists = await storage.get('oauth_creds.json');
    if (!exists) {
        console.log('[INIT] Detected QWEN_CREDS_JSON. Seeding KV storage...');
        try {
            const creds = JSON.parse(env.QWEN_CREDS_JSON);
            await storage.set('oauth_creds.json', creds);
            console.log('[INIT] KV seeding successful.');
        } catch (e) {
            console.error('[INIT] KV seeding failed:', e);
        }
    }
}

const MIGRATION_SQL = [
  `CREATE TABLE IF NOT EXISTS usage_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      count INTEGER DEFAULT 0,
      UNIQUE(date, provider_id, kind)
  )`,
  `CREATE TABLE IF NOT EXISTS global_monitor (
      key TEXT PRIMARY KEY,
      value INTEGER DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS request_audit_minute (
      minute_bucket TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      outcome TEXT NOT NULL,
      count INTEGER DEFAULT 0,
      PRIMARY KEY (minute_bucket, provider_id, kind, outcome)
  )`,
  `INSERT OR IGNORE INTO global_monitor (key, value) VALUES ('uptime_start', unixepoch())`
];

async function migrateDatabase(db: D1Database) {
    try {
        await db.batch(MIGRATION_SQL.map((sql) => db.prepare(sql)));
        console.log('[INIT] D1 Migration checked.');
    } catch (e) {
        console.error('[INIT] D1 Migration failed:', e);
    }
}

export default {
  async fetch(request: Request, env: Env, ctx: any): Promise<Response> {
    try {
      if (!appInstance) {
        console.log('--- LLM GATEWAY STARTING ---');
        console.log(`[BOOT] API_KEY configured: ${env.API_KEY ? 'YES' : 'NO'}`);
        
        const storage = new KVStorage(env.AUTH_STORE);
        await seedCredentialsIfNeeded(env, storage);

        // Init Quota & Monitor with D1
        if (env.DB) {
            // --- Auto Migration ---
            await migrateDatabase(env.DB);
            
            await quotaManager.init(storage, env.DB);
            await monitor.init(env.DB);
        } else {
            console.warn('[BOOT] D1 Database not bound! Quota and stats will be ephemeral.');
            await quotaManager.init(storage); // Fallback to KV-only
        }

        const config = loadConfig(env);
        console.log('[BOOT] Admin Console Path: /admin/ui (Shortcut: /ui)');
        
        appInstance = await createApp(config, storage);
        console.log('--- LLM GATEWAY READY ---');
      }
      return appInstance.fetch(request, env, ctx);
    } catch (e: any) {
      console.error('[FATAL ERROR]', e);
      return new Response(`Startup Failed: ${e.message}`, { status: 500 });
    }
  },
};
