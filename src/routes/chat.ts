import express, { Request, Response } from 'express';
import { LLMProvider } from '../providers/base';
import { logger } from '../core/logger';

export function createChatRouter(qwenProvider?: LLMProvider, modelMappings: Record<string, string> = {}) {
    const router = express.Router();

    router.post('/completions', async (req: Request, res: Response) => {
        let { model } = req.body;
        const originalModel = model;

        // Apply mappings
        if (modelMappings[model]) {
            model = modelMappings[model];
            req.body.model = model; // Rewrite for upstream
            logger.info(`Mapping model: ${originalModel} -> ${model}`);
        }

        logger.debug(`Received request for model: ${model}`);

        // Routing logic
        const isQwenModel = model === 'coder-model' || 
                           model === 'vision-model' || 
                           model.startsWith('qwen') ||
                           model.startsWith('qwen3');

        if (qwenProvider && isQwenModel) {
            return qwenProvider.handleChatCompletion(req, res);
        }

        // Future: Extend other providers here
        // if (geminiProvider && model.startsWith('gemini')) {
        //     return geminiProvider.handleChatCompletion(req, res);
        // }
        
        res.status(404).json({
            error: {
                message: `No provider available for model: ${model}`,
                type: 'invalid_request_error'
            }
        });
    });

    return router;
}
