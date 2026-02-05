import { Hono } from 'hono';
import { LLMProvider } from '../providers/base';

export function createToolsRouter(qwenProvider?: LLMProvider) {
    const app = new Hono();

    app.post('/web_search', async (c) => {
        if (qwenProvider) {
            return qwenProvider.handleWebSearch(c);
        }

        return c.json({
            error: {
                message: "Web search tool not available",
                type: 'invalid_request_error'
            }
        }, 404);
    });

    return app;
}