import { createApp } from './app';
import { loadConfig } from './config';
import { logger } from './core/logger';

async function main() {
    const configPath = process.env.CONFIG_PATH || './gateway.yaml';
    const config = await loadConfig(configPath);

    const app = await createApp(config);

    app.listen(config.port, () => {
        logger.info(`LLM CLI Gateway is running on port ${config.port}`);
        logger.info(`Base URL: http://localhost:${config.port}/v1`);
    });
}

process.on('uncaughtException', (err) => {
    logger.error('Uncaught Exception', err);
});

process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled Rejection', reason);
});

main().catch(err => {
    logger.error('Failed to start application', err);
    process.exit(1);
});
