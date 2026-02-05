import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger as honoLogger } from 'hono/logger';
import { AppConfig } from './config';
import { logger, LogLevel } from './core/logger';
import { MultiQwenProvider } from './providers/qwen/multiProvider';
import { createChatRouter } from './routes/chat';
import { createDashboardRouter } from './routes/dashboard';
import { createToolsRouter } from './routes/tools';
import { createAdminRouter } from './routes/admin';
import { quotaManager } from './core/quota';
import { IStorage } from './core/storage';

export async function createApp(config: AppConfig, storage: IStorage) {
    if (config.log_level) {
        logger.setLevel(LogLevel[config.log_level as keyof typeof LogLevel]);
    }

    const app = new Hono();
    app.use('*', honoLogger());
    app.use('*', cors());

    let qwenProvider: MultiQwenProvider | undefined;
    if (config.providers.qwen?.enabled) {
        qwenProvider = new MultiQwenProvider(
            storage, 
            config.providers.qwen.auth_files,
            config.qwen_oauth_client_id
        );
        await qwenProvider.initialize();
    }

    await quotaManager.init(storage);
    quotaManager.setLimits({
        chat: { daily: config.quota?.chat?.daily, rpm: config.quota?.chat?.rpm },
        search: { daily: config.quota?.search?.daily, rpm: config.quota?.search?.rpm }
    });

    // 1. 公共路由
    app.route('/', createDashboardRouter());
    app.get('/health', (c) => c.json({ status: 'ok', version: '1.0.0' }));

    // 2. 管理路由 (显式挂载)
    const key = (config.api_key || 'admin').trim();
    logger.info(`Admin UI mounting at /${key}/ui`);

    if (qwenProvider) {
        const adminApp = createAdminRouter(storage, qwenProvider, config.qwen_oauth_client_id);
        app.route(`/${key}`, adminApp);
        app.get(`/${key}`, (c) => c.redirect(`/${key}/ui`));
    }

    // 3. API 权限验证
    if (config.api_key) {
        app.use('/v1/*', async (c, next) => {
            const authHeader = c.req.header('Authorization');
            const providedToken = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null;
            if (providedToken === config.api_key) return await next();
            return c.json({ error: { message: 'Unauthorized' } }, 401);
        });
    }

    app.route('/v1/chat', createChatRouter(qwenProvider, config.model_mappings));
    app.route('/v1/tools', createToolsRouter(qwenProvider));

    app.onError((err, c) => {
        logger.error('App Error', err);
        return c.json({ error: 'Internal Server Error' }, 500);
    });

    return app;
}
