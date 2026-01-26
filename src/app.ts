import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import { AppConfig } from './config';
import { logger, LogLevel } from './core/logger';
import { MultiQwenProvider } from './providers/qwen/multiProvider';
import { createChatRouter } from './routes/chat';
import { createDashboardRouter } from './routes/dashboard';

export async function createApp(config: AppConfig) {
    // Set log level
    if (config.log_level) {
        logger.setLevel(LogLevel[config.log_level as keyof typeof LogLevel]);
    }

    // Handle API Key
    const apiKey = config.api_key || crypto.randomBytes(16).toString('hex');
    if (!config.api_key) {
        console.log('\n==================================================');
        console.log('🛡️  SECURITY WARNING: No API Key configured.');
        console.log('🔑 Generated temporary Master Token:');
        console.log(`   ${apiKey}`);
        console.log('==================================================\n');
    }

    const app = express();
    app.use(cors());
    app.use(express.json());

    // Initialize Providers
    let qwenProvider: MultiQwenProvider | undefined;
    if (config.providers.qwen?.enabled) {
        logger.info("Initializing Qwen Provider...");
        qwenProvider = new MultiQwenProvider(config.providers.qwen.auth_files);
        await qwenProvider.initialize();
    }

    // Routes - Public
    app.use('/', createDashboardRouter(qwenProvider));
    app.get('/health', (_req, res) => res.json({ status: 'ok', version: '1.0.0' }));

    // Auth Middleware for /v1 routes
    app.use('/v1', (req, res, next) => {
        const authHeader = req.headers.authorization;
        const providedToken = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null;

        if (providedToken === apiKey) {
            return next();
        }

        logger.warn(`Unauthorized access attempt from ${req.ip}`);
        res.status(401).json({
            error: {
                message: 'Unauthorized: Invalid or missing API Key. Use "Authorization: Bearer <token>"',
                type: 'authentication_error'
            }
        });
    });

    // Routes - Protected
    app.use('/v1/chat', createChatRouter(qwenProvider, config.model_mappings));

    // Global Error Handler
    app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        logger.error('Unhandled Express Error', err);
        res.status(500).json({ error: 'Internal Server Error' });
    });

    return app;
}

