import { z } from 'zod';
import yaml from 'yaml';
import { logger } from '../core/logger';

const ConfigSchema = z.object({
    port: z.number().default(3000),
    // API_KEY 设为必填字符串
    api_key: z.string().min(1, "API_KEY is mandatory"),
    log_level: z.enum(['DEBUG', 'INFO', 'WARN', 'ERROR']).default('INFO'),
    model_mappings: z.record(z.string(), z.string()).default({
        "research-model-v1": "coder-model"
    }),
    qwen_oauth_client_id: z.string().default('f0304373b74a44d2b584a3fb70ca9e56'),
    quota: z.object({
        chat: z.object({
            daily: z.number().default(2000),
            rpm: z.number().default(60)
        }).default({ daily: 2000, rpm: 60 }),
        search: z.object({
            daily: z.number().default(0),
            rpm: z.number().default(0)
        }).default({ daily: 0, rpm: 0 })
    }).default({ chat: { daily: 2000, rpm: 60 }, search: { daily: 0, rpm: 0 } }),
    audit: z.object({
        success_logs: z.boolean().default(false)
    }).default({ success_logs: false }),
    tuning: z.object({
        provider_scan_seconds: z.number().default(60),
        provider_full_kv_scan_minutes: z.number().default(30)
    }).default({
        provider_scan_seconds: 60,
        provider_full_kv_scan_minutes: 30
    }),
    providers: z.object({
        qwen: z.object({
            enabled: z.boolean().default(true),
            auth_files: z.array(z.string()).default([]), // 改为空数组
            rate_limit: z.object({
                requests_per_minute: z.number().default(60)
            }).optional()
        }).optional()
    }).default({})
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(env: any): AppConfig {
    let baseConfig: any = {};

    if (env.CONFIG_YAML) {
        try {
            baseConfig = yaml.parse(env.CONFIG_YAML);
        } catch (e) {
            logger.error('Failed to parse CONFIG_YAML');
        }
    }

    if (env.API_KEY) baseConfig.api_key = env.API_KEY;
    if (env.LOG_LEVEL) baseConfig.log_level = env.LOG_LEVEL;
    if (env.QWEN_CLIENT_ID) baseConfig.qwen_oauth_client_id = env.QWEN_CLIENT_ID;
    
    if (env.MODEL_MAPPINGS) {
        try {
            baseConfig.model_mappings = typeof env.MODEL_MAPPINGS === 'string' 
                ? JSON.parse(env.MODEL_MAPPINGS) 
                : env.MODEL_MAPPINGS;
        } catch (e) {
            logger.error('Failed to parse MODEL_MAPPINGS JSON');
        }
    }

    if (!baseConfig.quota) baseConfig.quota = { chat: {}, search: {} };
    if (env.CHAT_DAILY_LIMIT) baseConfig.quota.chat.daily = parseInt(env.CHAT_DAILY_LIMIT, 10);
    if (env.CHAT_RPM_LIMIT) baseConfig.quota.chat.rpm = parseInt(env.CHAT_RPM_LIMIT, 10);
    if (env.SEARCH_DAILY_LIMIT) baseConfig.quota.search.daily = parseInt(env.SEARCH_DAILY_LIMIT, 10);
    if (env.SEARCH_RPM_LIMIT) baseConfig.quota.search.rpm = parseInt(env.SEARCH_RPM_LIMIT, 10);
    if (!baseConfig.audit) baseConfig.audit = {};
    if (env.AUDIT_SUCCESS_LOG) baseConfig.audit.success_logs = env.AUDIT_SUCCESS_LOG === 'true';
    if (!baseConfig.tuning) baseConfig.tuning = {};
    if (env.PROVIDER_SCAN_SECONDS) baseConfig.tuning.provider_scan_seconds = parseInt(env.PROVIDER_SCAN_SECONDS, 10);
    if (env.PROVIDER_FULL_KV_SCAN_MINUTES) baseConfig.tuning.provider_full_kv_scan_minutes = parseInt(env.PROVIDER_FULL_KV_SCAN_MINUTES, 10);

    try {
        return ConfigSchema.parse(baseConfig);
    } catch (e: any) {
        if (e instanceof z.ZodError) {
            const missing = e.issues.map((issue: any) => `${issue.path.join('.')}: ${issue.message}`).join(', ');
            throw new Error(`Configuration Error: ${missing}`);
        }
        throw e;
    }
}
