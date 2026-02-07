import { Hono } from 'hono';
import { IStorage } from '../core/storage';
import { MultiQwenProvider } from '../providers/qwen/multiProvider';
import { QwenAuthManager, generateCodeChallenge, generateCodeVerifier } from '../providers/qwen/auth';
import { monitor } from '../core/monitor';
import { logger } from '../core/logger';
import { quotaManager } from '../core/quota';
import crypto from 'node:crypto';
import { ProviderRegistry } from '../core/providerRegistry';
import { renderAdminPage } from './admin_ui';

export function createAdminRouter(
    storage: IStorage,
    qwenProvider: MultiQwenProvider | undefined,
    clientId: string,
    apiKey: string,
    registry?: ProviderRegistry,
    options?: { providerFullKvScanMinutes?: number }
) {
    const app = new Hono();

    app.use('/api/*', async (c, next) => {
        const providedKey = c.req.header('X-Admin-Key');
        if (providedKey !== apiKey) return c.json({ error: 'Unauthorized' }, 401);
        await next();
    });

    app.get('/ui', (c) => {
        return c.html(renderAdminPage());
    });

    // 3. API 接口 (已更新为异步)
    app.get('/api/stats', async (c) => {
        const stats = await monitor.getStats();
        const providers = qwenProvider ? await qwenProvider.getAllProviderStatus() : [];
        const audit = await quotaManager.getRecentAudit(30);
        const totalRequests = (stats.chat.total || 0) + (stats.search.total || 0);
        const fullKvScanMinutes = Math.max(0, options?.providerFullKvScanMinutes ?? 0);
        const estimatedKvListReadsPerDay = fullKvScanMinutes > 0
            ? Math.ceil((24 * 60) / fullKvScanMinutes) * 4
            : 0;
        const estimatedKvReadsToday = totalRequests + estimatedKvListReadsPerDay;
        const estimatedD1WritesToday = totalRequests;
        return c.json({
            monitor: stats,
            qwen: { currentIndex: qwenProvider?.getCurrentIndex() ?? 0, providers: providers },
            audit,
            budget: {
                requestsToday: totalRequests,
                estimatedKvReadsToday,
                estimatedKvListReadsPerDay,
                estimatedD1WritesToday,
                notes: [
                    'Estimated values, used for free-tier risk hinting.',
                    'KV reads dominated by auth credential checks.',
                    fullKvScanMinutes > 0
                        ? 'Periodic full KV scan is enabled.'
                        : 'Periodic full KV scan is disabled; full scans happen on management actions or manual trigger.',
                    'D1 writes are mainly minute-audit upserts (roughly one write per request).'
                ]
            }
        });
    });

    app.post('/api/auth/start', async (c) => {
        const verifier = generateCodeVerifier();
        const challenge = generateCodeChallenge(verifier);
        const tempAuth = new QwenAuthManager(storage, 'temp', clientId);
        const authData = await tempAuth.startDeviceAuth(challenge);
        await storage.set(`pending_${authData.device_code}`, { verifier }, { expirationTtl: 600 });
        return c.json(authData);
    });

    app.post('/api/auth/poll', async (c) => {
        const { device_code, target_id, alias } = await c.req.json();
        const pending = await storage.get(`pending_${device_code}`);
        if (!pending) return c.json({ status: 'pending' });
        const tempAuth = new QwenAuthManager(storage, 'temp', clientId);
        try {
            const result = await tempAuth.exchangeDeviceCode(device_code, pending.verifier);
            if (result === 'pending') return c.json({ status: 'pending' });
            if (alias) result.alias = alias;
            else if (target_id) { const old = await storage.get(target_id); if (old && old.alias) result.alias = old.alias; }
            const saveId = target_id || `qwen_creds_${crypto.randomUUID().substring(0, 8)}.json`;
            await storage.set(saveId, result);
            await storage.delete(`pending_${device_code}`);
            await registry?.upsertProvider(saveId, result.alias);
            await qwenProvider?.addProvider(saveId);
            await qwenProvider?.manualRescan('full');
            return c.json({ status: 'success', id: saveId });
        } catch (e: any) { return c.json({ status: 'error', message: e.message }); }
    });

    app.patch('/api/providers/alias', async (c) => {
        const id = c.req.query('id') || '';
        if (!id) return c.json({ error: 'Missing id' }, 400);
        const { alias } = await c.req.json();
        const altId = id.startsWith('./') ? id.substring(2) : `./${id}`;
        const data = (await storage.get(id)) || (await storage.get(altId));
        if (data) {
            data.alias = alias;
            await storage.set(id, data);
            await storage.delete(altId);
            await registry?.setAlias(id, alias);
            await qwenProvider?.addProvider(id);
            await qwenProvider?.manualRescan('full');
        }
        return c.json({ success: true });
    });

    app.delete('/api/providers', async (c) => {
        const id = c.req.query('id') || '';
        if (!id) return c.json({ error: 'Missing id' }, 400);
        await storage.delete(id);
        if (id.startsWith('./')) await storage.delete(id.substring(2));
        else await storage.delete(`./${id}`);
        await registry?.removeProvider(id);
        await qwenProvider?.removeProvider(id);
        await qwenProvider?.manualRescan('full');
        return c.json({ success: true });
    });

    app.post('/api/providers/rescan', async (c) => {
        const mode = c.req.query('mode') === 'light' ? 'light' : 'full';
        await qwenProvider?.manualRescan(mode);
        return c.json({ success: true });
    });

    return app;
}
