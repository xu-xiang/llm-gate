import { KVNamespace } from '@cloudflare/workers-types';
import { createApp } from './app';
import { loadConfig } from './config';
import { KVStorage } from './core/storage';

export interface Env {
  AUTH_STORE: KVNamespace;
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

export default {
  async fetch(request: Request, env: Env, ctx: any): Promise<Response> {
    try {
      if (!appInstance) {
        // --- 关键启动日志 ---
        console.log('--- LLM GATEWAY STARTING ---');
        console.log(`[BOOT] API_KEY configured: ${env.API_KEY ? 'YES (Length: ' + env.API_KEY.trim().length + ')' : 'NO'}`);
        
        const storage = new KVStorage(env.AUTH_STORE);
        await seedCredentialsIfNeeded(env, storage);

        const config = loadConfig(env);
        
        // 显式打印管理路径，方便排查 404
        const adminKey = (config.api_key || 'admin').trim();
        console.log(`[BOOT] Admin Console Path: /${adminKey}/ui`);
        
        appInstance = await createApp(config, storage);
        console.log('--- LLM GATEWAY READY ---');
      }
      return appInstance.fetch(request, env, ctx);
    } catch (e: any) {
      // 这里的错误会输出到 Cloudflare 实时日志 (Real-time Logs)
      console.error('[FATAL ERROR] App failed to start:', e.stack || e.message || e);
      
      return new Response(JSON.stringify({
        error: "App Initialization Failed",
        message: e.message,
        path_hint: env.API_KEY ? `/${env.API_KEY.trim()}/ui` : "/admin/ui"
      }), { 
        status: 500, 
        headers: { "Content-Type": "application/json" } 
      });
    }
  },
};