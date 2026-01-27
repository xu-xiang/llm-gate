import express, { Request, Response } from 'express';
import { LLMProvider } from '../providers/base';
import { logger } from '../core/logger';

export function createToolsRouter(qwenProvider?: LLMProvider) {
    const router = express.Router();

    router.post('/web_search', async (req: Request, res: Response) => {
        if (qwenProvider) {
            return qwenProvider.handleWebSearch(req, res);
        }

        res.status(404).json({
            error: {
                message: "Web search tool not available",
                type: 'invalid_request_error'
            }
        });
    });

    return router;
}
