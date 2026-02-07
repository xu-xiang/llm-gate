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
            return qwenProvider.handleChatCompletion(c, body);
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
