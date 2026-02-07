import { Hono } from 'hono';
import { ProviderRouter } from '../providers/router';

export function createToolsRouter(providerRouter: ProviderRouter) {
    const app = new Hono();

    app.post('/web_search', async (c) => {
        const body = await c.req.json();
        return providerRouter.handleSearch(c, body);
    });

    return app;
}
