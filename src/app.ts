import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger as honoLogger } from 'hono/logger';
import { AppConfig } from './config';
import { logger, LogLevel } from './core/logger';
import { MultiQwenProvider } from './providers/qwen/multiProvider';
import { createChatRouter } from './routes/chat';
import { createDashboardRouter } from './routes/dashboard';
import { createToolsRouter } from './routes/tools';
import { createAdminRouter } from './routes/admin'; // Import
import { quotaManager } from './core/quota';
import { IStorage } from './core/storage';

export async function createApp(config: AppConfig, storage: IStorage) {
    // Set log level
    if (config.log_level) {
        logger.setLevel(LogLevel[config.log_level as keyof typeof LogLevel]);
    }

    const app = new Hono();
    
    // Middlewares
    app.use('*', honoLogger());
    app.use('*', cors());

    // Initialize Providers
    let qwenProvider: MultiQwenProvider | undefined;
    if (config.providers.qwen?.enabled) {
        logger.info("Initializing Qwen Provider with KV storage...");
        qwenProvider = new MultiQwenProvider(
            storage, 
            config.providers.qwen.auth_files,
            config.qwen_oauth_client_id
        );
        // Note: In Workers, we might want to initialize on demand or use ctx.waitUntil
        // but for now we follow the existing pattern.
        await qwenProvider.initialize();
    }

    // Initialize Quota Manager
    await quotaManager.init(storage);
    quotaManager.setLimits({
        chat: {
            daily: config.quota?.chat?.daily,
            rpm: config.quota?.chat?.rpm
        },
        search: {
            daily: config.quota?.search?.daily,
            rpm: config.quota?.search?.rpm
        }
    });

    // Routes - Public
    app.route('/', createDashboardRouter());
    app.get('/health', (c) => c.json({ status: 'ok', version: '1.0.0' }));

    // Routes - Admin (Protected by Path Path)
    // Access via: https://your-gateway.com/<API_KEY>/ui
    if (qwenProvider) {
        const adminPath = `/${config.api_key || 'admin'}`;
        logger.info(`Mounting Admin UI at ${adminPath}/ui`);
        app.route(adminPath, createAdminRouter(storage, qwenProvider, config.qwen_oauth_client_id));
    }

    // API Key Auth Middleware for /v1 routes
    const apiKey = config.api_key;
    if (apiKey) {
        app.use('/v1/*', async (c, next) => {
            const authHeader = c.req.header('Authorization');
            const providedToken = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null;

            if (providedToken === apiKey) {
                return await next();
            }

            logger.warn(`Unauthorized access attempt`);
            return c.json({
                error: {
                    message: 'Unauthorized: Invalid or missing API Key.',
                    type: 'authentication_error'
                }
            }, 401);
        });
    }

    // Routes - Protected
    app.route('/v1/chat', createChatRouter(qwenProvider, config.model_mappings));
    app.route('/v1/tools', createToolsRouter(qwenProvider));

    // Error Handler
    app.onError((err, c) => {
        logger.error('Unhandled Hono Error', err);
        return c.json({ error: 'Internal Server Error', message: err.message }, 500);
    });

    return app;
}