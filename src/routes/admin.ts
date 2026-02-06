import { Hono } from 'hono';
import { IStorage } from '../core/storage';
import { MultiQwenProvider } from '../providers/qwen/multiProvider';
import { QwenAuthManager, generateCodeChallenge, generateCodeVerifier } from '../providers/qwen/auth';
import { monitor } from '../core/monitor';
import { logger } from '../core/logger';
import crypto from 'node:crypto';

export function createAdminRouter(storage: IStorage, qwenProvider: MultiQwenProvider, clientId: string, apiKey: string) {
    const app = new Hono();

    app.use('/api/*', async (c, next) => {
        const providedKey = c.req.header('X-Admin-Key');
        if (providedKey !== apiKey) return c.json({ error: 'Unauthorized' }, 401);
        await next();
    });

    app.get('/ui', (c) => {
        const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>LLM Gateway Console</title>
    <style>
        :root { --primary: #2563eb; --danger: #dc2626; --success: #16a34a; --bg: #f1f5f9; --card: #ffffff; --text: #0f172a; --border: #e2e8f0; --subtext: #64748b; }
        * { box-sizing: border-box; }
        body { font-family: system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--text); margin: 0; padding: 20px; }
        .container { max-width: 1000px; margin: 0 auto; }
        .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; border-bottom: 1px solid var(--border); padding-bottom: 16px; }
        .logo { font-size: 1.5rem; font-weight: 800; color: var(--primary); display: flex; align-items: center; gap: 8px; text-decoration: none; }
        .card { background: var(--card); border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); padding: 24px; margin-bottom: 24px; border: 1px solid var(--border); }
        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 24px; }
        .stat-item { background: var(--card); padding: 20px; border-radius: 12px; border: 1px solid var(--border); }
        .stat-label { font-size: 0.875rem; color: var(--subtext); margin-bottom: 4px; }
        .stat-value { font-size: 1.5rem; font-weight: 700; }
        table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
        th { text-align: left; padding: 12px; background: #f8fafc; color: var(--subtext); font-weight: 600; border-bottom: 1px solid var(--border); }
        td { padding: 12px; border-bottom: 1px solid var(--border); vertical-align: middle; }
        .badge { padding: 4px 8px; border-radius: 6px; font-size: 0.7rem; font-weight: 700; text-transform: uppercase; }
        .badge-active { background: #dcfce7; color: #166534; }
        .badge-error { background: #fee2e2; color: #991b1b; }
        .progress-bg { background: #e2e8f0; height: 6px; border-radius: 3px; overflow: hidden; width: 100px; margin-top: 4px; }
        .progress-fill { height: 100%; background: var(--primary); transition: width 0.3s; }
        .btn { display: inline-flex; align-items: center; padding: 6px 12px; border-radius: 6px; font-weight: 600; cursor: pointer; border: none; font-size: 0.8rem; transition: 0.2s; gap: 4px; }
        .btn-primary { background: var(--primary); color: white; }
        .btn-outline { background: white; color: var(--text); border: 1px solid var(--border); }
        .btn-danger { color: var(--danger); background: #fff1f2; }
        .modal { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(15, 23, 42, 0.6); backdrop-filter: blur(4px); align-items: center; justify-content: center; z-index: 100; opacity: 0; transition: opacity 0.2s; }
        .modal.show { opacity: 1; display: flex; }
        .modal-content { background: white; padding: 30px; border-radius: 12px; width: 400px; text-align: center; }
        .code-display { font-family: monospace; font-size: 2rem; background: #f1f5f9; padding: 15px; border-radius: 8px; margin: 20px 0; color: var(--primary); border: 2px dashed #cbd5e1; }
        #loginOverlay { display: none; position: fixed; inset: 0; background: var(--bg); z-index: 200; align-items: center; justify-content: center; }
    </style>
</head>
<body>
    <div id="loginOverlay"><div class="card" style="width:350px; text-align:center"><h3>🔐 Unlock Console</h3><input type="password" id="loginKey" placeholder="API_KEY" style="width:100%; padding:12px; margin:15px 0; border:1px solid var(--border); border-radius:6px"><button class="btn btn-primary" style="width:100%" onclick="doLogin()">Unlock</button></div></div>
    <div class="container" id="mainApp" style="display:none">
        <div class="header"><a href="#" class="logo"><span>⚡</span> LLM Gateway</a><div style="display:flex; gap:8px"><button class="btn btn-outline" onclick="loadData()">Refresh</button><button class="btn btn-primary" onclick="showAddModal()">+ Add Account</button><button class="btn btn-danger" onclick="logout()">Logout</button></div></div>
        <div class="stats-grid" id="stats-grid"></div>
        <div class="card"><h2>Provider Pool</h2><div style="overflow-x:auto"><table><thead><tr><th>Account</th><th>Status</th><th>Latency</th><th>Usage</th><th>RPM</th><th>Actions</th></tr></thead><tbody id="provider-list"></tbody></table></div></div>
    </div>
    <div id="authModal" class="modal"><div class="modal-content"><h3 id="modalTitle">Connect Account</h3><div id="step1"><input type="text" id="accountAlias" placeholder="Name..." style="width:100%; padding:10px; margin-bottom:15px; border:1px solid var(--border); border-radius:6px"><button class="btn btn-primary" style="width:100%" onclick="startAuthFlow()">Next</button></div><div id="step2" style="display:none"><p>1. Open <a id="authLink" href="#" target="_blank">Login Page ↗</a></p><div id="userCode" class="code-display"></div><p style="font-size:12px; color:var(--subtext)">Waiting for approval...</p></div><button class="btn btn-danger" style="width:100%; margin-top:10px" onclick="closeModal()">Cancel</button></div></div>
    <div id="renameModal" class="modal"><div class="modal-content"><h3>Rename Account</h3><input type="text" id="renameInput" style="width:100%; padding:10px; border:1px solid var(--border); border-radius:6px"><div style="display:flex; gap:10px; margin-top:20px"><button class="btn btn-outline" style="flex:1" onclick="closeRenameModal()">Cancel</button><button class="btn btn-primary" style="flex:1" id="renameBtn">Save</button></div></div></div>
<script>
    let pollInterval; const getStoredKey = () => localStorage.getItem('llm_gate_key');
    const authHeaders = () => ({ 'X-Admin-Key': getStoredKey(), 'Content-Type': 'application/json' });
    async function apiFetch(path, options = {}) {
        const res = await fetch('/admin' + path, { ...options, headers: { ...authHeaders(), ...options.headers } });
        if (res.status === 401) { showLogin(); throw new Error('Unauthorized'); } return res;
    }
    function showLogin() { document.getElementById('loginOverlay').style.display='flex'; document.getElementById('mainApp').style.display='none'; }
    function doLogin() { const k=document.getElementById('loginKey').value; if(!k) return; localStorage.setItem('llm_gate_key', k); document.getElementById('loginOverlay').style.display='none'; document.getElementById('mainApp').style.display='block'; loadData(); }
    function logout() { localStorage.removeItem('llm_gate_key'); location.reload(); }
    async function loadData() {
        try {
            const res = await apiFetch('/api/stats'); const data = await res.json();
            const m = data.monitor; const active = data.qwen.providers.filter(p => p.status === 'active').length;
            document.getElementById('stats-grid').innerHTML = \`
                <div class="stat-item"><div class="stat-label">Uptime</div><div class="stat-value">\${Math.floor(m.uptime/3600)}h \${Math.floor(m.uptime%3600/60)}m</div></div>
                <div class="stat-item"><div class="stat-label">Requests</div><div class="stat-value">\${(m.chat.total+m.search.total).toLocaleString()}</div></div>
                <div class="stat-item"><div class="stat-label">Active Pool</div><div class="stat-value" style="color:var(--success)">\${active}/\${data.qwen.providers.length}</div></div>\`;
            document.getElementById('provider-list').innerHTML = data.qwen.providers.map(p => {
                const daily = p.quota?.chat?.daily || {used:0, limit:2000, percent:0}; const rpm = p.quota?.chat?.rpm || {used:0, limit:60, percent:0};
                const alias = p.alias || 'Unnamed'; const rawId = p.id;
                return \`<tr>
                    <td><div style="font-weight:700" class="alias-text">\${alias} <span onclick="openRename('\${rawId.replace(/'/g, "\\\\'")}', '\${alias.replace(/'/g, "\\\\'")}')" style="cursor:pointer;opacity:0.5">✏️</span></div><div style="font-size:10px;color:var(--subtext);font-family:monospace">\${p.id}</div></td>
                    <td><span class="badge badge-\${p.status}">\${p.status}</span></td>
                    <td>\${p.lastLatency ? p.lastLatency+'ms' : '-'}</td>
                    <td><div style="font-size:9px">\${daily.used}/\${daily.limit}</div><div class="progress-bg"><div class="progress-fill" style="width:\${daily.percent}%"></div></div></td>
                    <td><div style="font-size:9px">\${rpm.used}/\${rpm.limit}</div><div class="progress-bg"><div class="progress-fill" style="width:\${rpm.percent}%"></div></div></td>
                    <td><div style="display:flex;gap:4px">
                        \${p.status==='error'?\`<button class="btn btn-outline btn-sm" onclick="showReAuthModal('\${rawId.replace(/'/g, "\\\\'")}', '\${alias.replace(/'/g, "\\\\'")}')">Login</button>\`:''}
                        <button class="btn btn-danger btn-sm" onclick="deleteProvider('\${rawId.replace(/'/g, "\\\\'")}')">Del</button>
                    </div></td>
                </tr>\`;
            }).join('');
        } catch (e) { if(e.message !== 'Unauthorized') console.error(e); }
    }
    function showModal(id) { const m=document.getElementById(id); m.style.display='flex'; setTimeout(()=>m.classList.add('show'),10); }
    function hideModal(id) { const m=document.getElementById(id); m.classList.remove('show'); setTimeout(()=>m.style.display='none',200); }
    function showAddModal() { currentAuthId=null; document.getElementById('step1').style.display='block'; document.getElementById('step2').style.display='none'; showModal('authModal'); }
    async function startAuthFlow() {
        const alias = currentAuthId ? null : (document.getElementById('accountAlias').value || 'New Account');
        const res = await apiFetch('/api/auth/start', { method: 'POST' }); const data = await res.json();
        document.getElementById('step1').style.display='none'; document.getElementById('step2').style.display='block';
        document.getElementById('authLink').href = data.verification_uri_complete; document.getElementById('userCode').textContent = data.user_code;
        if(pollInterval) clearInterval(pollInterval); pollInterval = setInterval(() => checkAuth(data.device_code, alias), 3000);
    }
    async function checkAuth(deviceCode, alias) {
        const res = await apiFetch('/api/auth/poll', { method: 'POST', body: JSON.stringify({ device_code: deviceCode, target_id: currentAuthId, alias }) });
        const data = await res.json(); if (data.status === 'success') { closeModal(); loadData(); }
    }
    function showReAuthModal(id, alias) { currentAuthId = id; startAuthFlow(); showModal('authModal'); }
    function openRename(id, alias) { document.getElementById('renameInput').value = alias; showModal('renameModal'); document.getElementById('renameBtn').onclick = () => submitRename(id); }
    async function submitRename(id) {
        await apiFetch('/api/providers/alias?id=' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ alias: document.getElementById('renameInput').value }) });
        closeRenameModal(); loadData();
    }
    async function deleteProvider(id) { if(confirm('Delete?')) { await apiFetch('/api/providers?id=' + encodeURIComponent(id), { method: 'DELETE' }); loadData(); } }
    function closeModal() { if(pollInterval) clearInterval(pollInterval); hideModal('authModal'); }
    function closeRenameModal() { hideModal('renameModal'); }
    if (getStoredKey()) { document.getElementById('mainApp').style.display='block'; loadData(); setInterval(loadData, 3000); } else { showLogin(); }
</script></body></html>`;
        return c.html(html);
    });

    // 3. API 接口 (已更新为异步)
    app.get('/api/stats', async (c) => {
        const stats = await monitor.getStats();
        const providers = await qwenProvider.getAllProviderStatus();
        return c.json({
            monitor: stats,
            qwen: { currentIndex: qwenProvider.getCurrentIndex(), providers: providers }
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
            await qwenProvider.addProvider(saveId);
            return c.json({ status: 'success', id: saveId });
        } catch (e: any) { return c.json({ status: 'error', message: e.message }); }
    });

    app.patch('/api/providers/alias', async (c) => {
        const id = c.req.query('id') || '';
        if (!id) return c.json({ error: 'Missing id' }, 400);
        const { alias } = await c.req.json();
        const data = await storage.get(id);
        if (data) {
            data.alias = alias;
            await storage.set(id, data);
            await qwenProvider.addProvider(id);
        }
        return c.json({ success: true });
    });

    app.delete('/api/providers', async (c) => {
        const id = c.req.query('id') || '';
        if (!id) return c.json({ error: 'Missing id' }, 400);
        await storage.delete(id);
        await qwenProvider.removeProvider(id);
        return c.json({ success: true });
    });

    return app;
}
