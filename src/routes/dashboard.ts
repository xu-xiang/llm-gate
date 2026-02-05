import { Hono } from 'hono';

export function createDashboardRouter() {
    const app = new Hono();

    app.get('/', (c) => {
        return c.json({
            status: 'ok',
            service: 'LLM Gateway',
            version: '1.0.0'
        });
    });

    app.get('/health', (c) => c.json({ status: 'ok' }));

    return app;
}