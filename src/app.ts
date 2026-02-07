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
import { D1Database } from '@cloudflare/workers-types';
import { providerRegistry } from './core/providerRegistry';
import { ProviderRouter } from './providers/router';
import { isQwenModel } from './providers/qwen/matcher';

export async function createApp(config: AppConfig, storage: IStorage, db?: D1Database) {
    if (config.log_level) {
        logger.setLevel(LogLevel[config.log_level as keyof typeof LogLevel]);
    }

    const app = new Hono();
    app.use('*', honoLogger());
    app.use('*', cors());

    // 默认开启 Qwen Provider，支持零配置启动
    const qwenEnabled = config.providers.qwen?.enabled ?? true;
    const authFiles = config.providers.qwen?.auth_files ?? [];
    
    let qwenProvider: MultiQwenProvider | undefined;
    const providerRouter = new ProviderRouter();
    await providerRegistry.init(db);
    if (qwenEnabled) {
        logger.info("Initializing Qwen Provider pool...");
        qwenProvider = new MultiQwenProvider(
            storage, 
            authFiles,
            config.qwen_oauth_client_id,
            providerRegistry
        );
        await qwenProvider.initialize();
        providerRouter.registerChatProvider({
            name: 'qwen',
            matchesModel: isQwenModel,
            handleChatCompletion: (c, payload) => qwenProvider!.handleChatCompletion(c, payload)
        });
        providerRouter.registerSearchProvider({
            name: 'qwen',
            handleWebSearch: (c, payload) => qwenProvider!.handleWebSearch(c, payload)
        });
    }

    if (!quotaManager.isReady()) {
        await quotaManager.init(storage);
    }
    quotaManager.setLimits({
        chat: { daily: config.quota?.chat?.daily, rpm: config.quota?.chat?.rpm },
        search: { daily: config.quota?.search?.daily, rpm: config.quota?.search?.rpm }
    });
    quotaManager.setAuditOptions({
        success: config.audit?.success_logs
    });

    // 1. 公共路由 (根路径健康检查)
    app.route('/', createDashboardRouter());
    app.get('/health', (c) => c.json({ status: 'ok', version: '1.0.0' }));

    // 2. 管理路由 (固定路径 /admin)
    // 注意：我们将 adminApp 挂载到 /admin，其内部路由如 /ui 会自动变成 /admin/ui
    const adminApp = createAdminRouter(storage, qwenProvider, config.qwen_oauth_client_id, config.api_key, providerRegistry);
    app.route('/admin', adminApp);
    
    // 快捷重定向：访问 /ui 自动跳转到 /admin/ui
    app.get('/ui', (c) => c.redirect('/admin/ui'));
    
    logger.info(`Admin Console registered at /admin/ui (Shortcut: /ui)`);

    // 3. 业务 API 鉴权 (针对 /v1 路径)
    if (config.api_key) {
        app.use('/v1/*', async (c, next) => {
            const authHeader = c.req.header('Authorization');
            const providedToken = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null;
            if (providedToken === config.api_key) return await next();
            return c.json({ error: { message: 'Unauthorized' } }, 401);
        });
    }

    // 4. 业务路由挂载
    app.route('/v1/chat', createChatRouter(providerRouter, config.model_mappings));
    app.route('/v1/tools', createToolsRouter(providerRouter));

    app.onError((err, c) => {
        logger.error('App Fatal Error', err);
        return c.json({ error: 'Internal Server Error', message: err.message }, 500);
    });

    return app;
}
