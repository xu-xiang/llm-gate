import { Hono } from 'hono';
import { logger } from '../core/logger';
import { ProviderRouter } from '../providers/router';

export function createChatRouter(providerRouter: ProviderRouter, modelMappings: Record<string, string> = {}) {
    const app = new Hono();

    app.post('/completions', async (c) => {
        const body = await c.req.json();
        let { model } = body;
        const originalModel = model;

        // Apply mappings
        if (modelMappings[model]) {
            model = modelMappings[model];
            body.model = model; // Rewrite for upstream
            logger.info(`Mapping model: ${originalModel} -> ${model}`);
        }

        logger.debug(`Received request for model: ${model}`);
        return providerRouter.handleChat(c, body);
    });

    return app;
}
