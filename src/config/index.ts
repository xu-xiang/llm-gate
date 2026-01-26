import { z } from 'zod';
import fs from 'fs-extra';
import yaml from 'yaml';
import { resolvePath } from '../utils/paths';
import { logger } from '../core/logger';

const ConfigSchema = z.object({
    port: z.number().default(3000),
    api_key: z.string().optional(),
    log_level: z.enum(['DEBUG', 'INFO', 'WARN', 'ERROR']).default('INFO'),
    model_mappings: z.record(z.string(), z.string()).default({}),
    providers: z.object({
        qwen: z.object({
            enabled: z.boolean().default(true),
            auth_files: z.array(z.string()).default(['./oauth_creds.json']),
            rate_limit: z.object({
                requests_per_minute: z.number().default(60)
            }).optional()
        }).optional()
    })
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export const DEFAULT_CONFIG: AppConfig = ConfigSchema.parse({
    port: 3000,
    providers: {
        qwen: {
            enabled: true,
            auth_files: ['./oauth_creds.json']
        }
    }
});

export async function loadConfig(configPath: string): Promise<AppConfig> {
    const resolvedConfigPath = resolvePath(configPath);
    let rawConfig: any = {};

    if (await fs.pathExists(resolvedConfigPath)) {
        try {
            const file = await fs.readFile(resolvedConfigPath, 'utf8');
            rawConfig = yaml.parse(file);
            logger.info(`Loaded config from ${resolvedConfigPath}`);
        } catch (e) {
            logger.error(`Failed to parse config file at ${resolvedConfigPath}, using defaults.`, e);
        }
    } else {
        logger.warn(`Config file not found at ${resolvedConfigPath}, using default settings.`);
    }

    const config = ConfigSchema.parse(rawConfig);

    // Resolve all auth file paths
    if (config.providers.qwen) {
        config.providers.qwen.auth_files = config.providers.qwen.auth_files.map(resolvePath);
    }

    return config;
}