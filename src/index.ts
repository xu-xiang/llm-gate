import { KVNamespace } from '@cloudflare/workers-types';
import { createApp } from './app';
import { loadConfig } from './config';
import { KVStorage } from './core/storage';

export interface Env {
  AUTH_STORE: KVNamespace;
  
  // 核心配置
  API_KEY?: string;
  LOG_LEVEL?: string;
  
  // 进阶配置
  CONFIG_YAML?: string;
  MODEL_MAPPINGS?: string;
  
  // Qwen 特定配置
  QWEN_CLIENT_ID?: string;
  QWEN_CREDS_JSON?: string;
  
  // 配额配置
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
        console.log('🌱 Auto-seeding credentials from QWEN_CREDS_JSON...');
        try {
            const creds = JSON.parse(env.QWEN_CREDS_JSON);
            await storage.set('oauth_creds.json', creds);
            console.log('✅ Credentials seeded.');
        } catch (e) {
            console.error('❌ Seed failed:', e);
        }
    }
}

export default {
  async fetch(request: Request, env: Env, ctx: any): Promise<Response> {
    try {
      if (!appInstance) {
        const storage = new KVStorage(env.AUTH_STORE);
        await seedCredentialsIfNeeded(env, storage);

        const config = loadConfig(env);
        appInstance = await createApp(config, storage);
      }
      return appInstance.fetch(request, env, ctx);
    } catch (e: any) {
      return new Response(JSON.stringify({
        error: "Configuration Error",
        message: e.message,
        tip: "Please set API_KEY in Cloudflare Environment Variables."
      }), { 
        status: 500, 
        headers: { "Content-Type": "application/json" } 
      });
    }
  },
};
