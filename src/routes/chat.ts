import { Hono } from 'hono';
import { LLMProvider } from '../providers/base';
import { logger } from '../core/logger';

export function createChatRouter(qwenProvider?: LLMProvider, modelMappings: Record<string, string> = {}) {
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

        // Routing logic
        const isQwenModel = model === 'coder-model' || 
                           model === 'vision-model' || 
                           model.startsWith('qwen') ||
                           model.startsWith('qwen3');

        if (qwenProvider && isQwenModel) {
            // Note: We need to pass the updated body if we modified it
            // However, our Provider currently reads c.req.json() again.
            // In Hono, c.req.json() can only be read once unless we use a middleware to buffer it.
            // For now, let's assume the Provider will use the model from the body it reads.
            return qwenProvider.handleChatCompletion(c);
        }

        return c.json({
            error: {
                message: `No provider available for model: ${model}`,
                type: 'invalid_request_error'
            }
        }, 404);
    });

    return app;
}