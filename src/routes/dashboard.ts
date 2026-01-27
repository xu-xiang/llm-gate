import express from 'express';
import { MultiQwenProvider } from '../providers/qwen/multiProvider';
import { monitor } from '../core/monitor';

export function createDashboardRouter(qwenProvider?: MultiQwenProvider) {
    const router = express.Router();

    router.get('/api/status', (req, res) => {
        res.json({
            monitor: monitor.getStats(),
            qwen: qwenProvider ? {
                currentIndex: qwenProvider.getCurrentIndex(),
                providers: qwenProvider.getAllProviderStatus().map(p => ({
                    ...p,
                    path: undefined
                }))
            } : null
        });
    });

    router.get('/', (req, res) => {
        const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>LLM-GATEWAY TERMINAL</title>
    <style>
        :root {
            --bg-color: #0a0a0a;
            --text-color: #00ff00;
            --dim-text: #008800;
            --error-color: #ff0000;
            --warn-color: #ffff00;
            --font-family: 'Courier New', Courier, monospace;
        }

        body {
            background-color: var(--bg-color);
            color: var(--text-color);
            font-family: var(--font-family);
            margin: 0;
            padding: 20px;
            display: flex;
            flex-direction: column;
            height: 100vh;
            box-sizing: border-box;
            overflow: hidden;
        }

        .ascii-art {
            white-space: pre;
            font-size: 10px;
            line-height: 1.2;
            margin-bottom: 20px;
            text-shadow: 0 0 5px var(--text-color);
        }

        .grid {
            display: grid;
            grid-template-columns: 0.75fr 1.25fr;
            gap: 20px;
            flex: 1;
        }

        .panel {
            border: 1px solid var(--dim-text);
            padding: 15px;
            position: relative;
        }

        .panel::before {
            content: attr(data-title);
            position: absolute;
            top: -10px;
            left: 10px;
            background: var(--bg-color);
            padding: 0 5px;
            font-size: 12px;
            color: var(--dim-text);
        }

        .stat-line {
            margin: 5px 0;
            display: flex;
            justify-content: space-between;
        }

        .label { color: var(--dim-text); }
        .value { font-weight: bold; }

        table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 10px;
            font-size: 14px;
        }

        th {
            text-align: left;
            border-bottom: 1px solid var(--dim-text);
            color: var(--dim-text);
            padding: 5px;
        }

        td {
            padding: 5px;
            vertical-align: top;
        }

        .status-active { color: var(--text-color); }
        .status-error { color: var(--error-color); }
        .status-init { color: var(--warn-color); }

        #log-container {
            grid-column: span 2;
            overflow-y: auto;
            max-height: 200px;
            font-size: 12px;
            background: #050505;
            padding: 10px;
            border: 1px solid var(--dim-text);
        }

        .log-entry { margin: 2px 0; border-left: 2px solid var(--dim-text); padding-left: 5px; }

        .cursor {
            display: inline-block;
            width: 10px;
            height: 18px;
            background: var(--text-color);
            animation: blink 1s infinite;
            vertical-align: middle;
        }

        @keyframes blink {
            0%, 49% { opacity: 1; }
            50%, 100% { opacity: 0; }
        }

        .footer {
            margin-top: 20px;
            font-size: 12px;
            color: var(--dim-text);
        }

        .blink-warn { animation: blink-warn-anim 0.5s infinite; }
        @keyframes blink-warn-anim {
            0% { color: var(--warn-color); }
            50% { color: transparent; }
        }
    </style>
</head>
<body>

<div class="ascii-art">
 _      _      __  __        _____         _______ ______        __ __ __   __
| |    | |    |  \/  |      / ____|    /\|__   __|  ____|  /\   \ \ \ \ \ / /
| |    | |    | \  / |     | |  __    /  \  | |  | |__    /  \   \ \ \ \ \ / 
| |    | |    | |\/| |     | | |_ |  / /\ \ | |  |  __|  / /\ \   > > > > \  
| |____| |____| |  | |     | |__| | / ____ \| |  | |____/ ____ \ / / / / / / 
|______|______|_|  |_|      \_____|/_/    \_\_|  |______/_/    \_\_/_/_/_/ /  
                                                                             
</div>

<div class="grid">
    <div class="panel" data-title="SYSTEM STATUS">
        <div class="stat-line"><span class="label">UPTIME:</span><span class="value" id="uptime">0s</span></div>
        <div class="stat-line"><span class="label">CHAT TOTAL:</span><span class="value" id="chat-total-reqs">0</span></div>
        <div class="stat-line"><span class="label">CHAT SUCCESS:</span><span class="value" style="color:var(--text-color)" id="chat-success-reqs">0</span></div>
        <div class="stat-line"><span class="label">CHAT ERRORS:</span><span class="value" style="color:var(--error-color)" id="chat-error-reqs">0</span></div>
        <div class="stat-line"><span class="label">CHAT RL:</span><span class="value" id="chat-ratelimit-reqs">0</span></div>
        <div class="stat-line" style="margin-top:8px"><span class="label">SEARCH TOTAL:</span><span class="value" id="search-total-reqs">0</span></div>
        <div class="stat-line"><span class="label">SEARCH SUCCESS:</span><span class="value" style="color:var(--text-color)" id="search-success-reqs">0</span></div>
        <div class="stat-line"><span class="label">SEARCH ERRORS:</span><span class="value" style="color:var(--error-color)" id="search-error-reqs">0</span></div>
    </div>

    <div class="panel" data-title="PROVIDER POOL (QWEN)">
        <table>
            <thead>
                <tr>
                    <th>ID</th>
                    <th>STATUS</th>
                    <th>ERRS</th>
                    <th>DAILY QUOTA</th>
                    <th>LATENCY</th>
                    <th>LAST ERROR</th>
                </tr>
            </thead>
            <tbody id="provider-table">
                <!-- Data injected here -->
            </tbody>
        </table>
    </div>

    <div id="log-container">
        <div class="log-entry">Terminal initialized. Connecting to gateway API...</div>
    </div>
</div>

<div class="footer">
    <span>SYSTEM READY > </span><span id="last-update"></span><span class="cursor"></span>
</div>

<script>
    const logContainer = document.getElementById('log-container');
    function addLog(msg, color = 'var(--text-color)') {
        const div = document.createElement('div');
        div.className = 'log-entry';
        div.style.color = color;
        div.textContent = '[' + new Date().toLocaleTimeString() + '] ' + msg;
        logContainer.appendChild(div);
        logContainer.scrollTop = logContainer.scrollHeight;
        if (logContainer.children.length > 50) logContainer.removeChild(logContainer.firstChild);
    }

    async function updateStats() {
        try {
            const res = await fetch('/api/status');
            const data = await res.json();

            // Update System Stats
            document.getElementById('uptime').textContent = data.monitor.uptime + 's';
            document.getElementById('chat-total-reqs').textContent = data.monitor.chat.total;
            document.getElementById('chat-success-reqs').textContent = data.monitor.chat.success;
            document.getElementById('chat-error-reqs').textContent = data.monitor.chat.error;
            const rlElement = document.getElementById('chat-ratelimit-reqs');
            rlElement.textContent = data.monitor.chat.rateLimited;
            if (data.monitor.chat.rateLimited > 0) rlElement.classList.add('blink-warn');
            document.getElementById('search-total-reqs').textContent = data.monitor.search.total;
            document.getElementById('search-success-reqs').textContent = data.monitor.search.success;
            document.getElementById('search-error-reqs').textContent = data.monitor.search.error;

            // Update Provider Table
            const tbody = document.getElementById('provider-table');
            tbody.innerHTML = '';
            if (data.qwen && data.qwen.providers) {
                data.qwen.providers.forEach((p, index) => {
                    const row = document.createElement('tr');
                    const isCurrent = index === data.qwen.currentIndex;
                    const statusClass = 'status-' + p.status;
                    const prefix = isCurrent ? '> ' : '';
                    const lastErr = p.lastError ? p.lastError : '-';
                    
                    const chatDailyUsed = p.quota ? p.quota.chat.daily.used : 0;
                    const chatDailyLimit = p.quota ? p.quota.chat.daily.limit : 2000;
                    const chatDailyPercent = p.quota ? p.quota.chat.daily.percent : 0;
                    
                    const chatRpmUsed = p.quota ? p.quota.chat.rpm.used : 0;
                    const chatRpmLimit = p.quota ? p.quota.chat.rpm.limit : 60;
                    const chatRpmPercent = p.quota ? p.quota.chat.rpm.percent : 0;

                    const searchDailyUsed = p.quota ? p.quota.search.daily.used : 0;
                    const searchDailyLimit = p.quota ? p.quota.search.daily.limit : 0;
                    const searchDailyPercent = p.quota ? p.quota.search.daily.percent : 0;
                    
                    const searchRpmUsed = p.quota ? p.quota.search.rpm.used : 0;
                    const searchRpmLimit = p.quota ? p.quota.search.rpm.limit : 0;
                    const searchRpmPercent = p.quota ? p.quota.search.rpm.percent : 0;

                    const chatDailyLimitLabel = chatDailyLimit > 0 ? chatDailyLimit : '∞';
                    const chatRpmLimitLabel = chatRpmLimit > 0 ? chatRpmLimit : '∞';
                    const searchDailyLimitLabel = searchDailyLimit > 0 ? searchDailyLimit : '∞';
                    const searchRpmLimitLabel = searchRpmLimit > 0 ? searchRpmLimit : '∞';
                    
                    row.innerHTML = '<td>' + prefix + p.id + '</td>' +
                                  '<td class="' + statusClass + '">' + p.status.toUpperCase() + '</td>' +
                                  '<td>' + p.errorCount + '</td>' +
                                  '<td>' + 
                                    '<div style="margin-bottom:4px">' +
                                        '<span style="font-size:9px;color:var(--dim-text)">CHAT RPM: </span>' +
                                        '<div style="width:60px;background:#222;height:6px;display:inline-block;margin-right:5px;border:1px solid #444">' +
                                            '<div style="width:' + chatRpmPercent + '%;background:#00ffff;height:100%"></div>' +
                                        '</div>' +
                                        '<span style="font-size:9px">' + chatRpmUsed + '/' + chatRpmLimitLabel + '</span>' +
                                    '</div>' +
                                    '<div>' +
                                        '<span style="font-size:9px;color:var(--dim-text)">CHAT DAY: </span>' +
                                        '<div style="width:60px;background:#222;height:6px;display:inline-block;margin-right:5px;border:1px solid #444">' +
                                            '<div style="width:' + chatDailyPercent + '%;background:var(--text-color);height:100%"></div>' +
                                        '</div>' +
                                        '<span style="font-size:9px">' + chatDailyUsed + '/' + chatDailyLimitLabel + '</span>' +
                                    '</div>' +
                                    '<div style="margin-top:6px">' +
                                        '<span style="font-size:9px;color:var(--dim-text)">SEARCH RPM: </span>' +
                                        '<div style="width:60px;background:#222;height:6px;display:inline-block;margin-right:5px;border:1px solid #444">' +
                                            '<div style="width:' + searchRpmPercent + '%;background:#ffb300;height:100%"></div>' +
                                        '</div>' +
                                        '<span style="font-size:9px">' + searchRpmUsed + '/' + searchRpmLimitLabel + '</span>' +
                                    '</div>' +
                                    '<div>' +
                                        '<span style="font-size:9px;color:var(--dim-text)">SEARCH DAY: </span>' +
                                        '<div style="width:60px;background:#222;height:6px;display:inline-block;margin-right:5px;border:1px solid #444">' +
                                            '<div style="width:' + searchDailyPercent + '%;background:#ffd54f;height:100%"></div>' +
                                        '</div>' +
                                        '<span style="font-size:9px">' + searchDailyUsed + '/' + searchDailyLimitLabel + '</span>' +
                                    '</div>' +
                                  '</td>' +
                                  '<td>' + (p.lastLatency ? p.lastLatency + 'ms' : '-') + '</td>' +
                                  '<td style="font-size:11px;color:var(--error-color)">' + lastErr + '</td>';
                    tbody.appendChild(row);
                });
            }

            document.getElementById('last-update').textContent = 'LAST_SYNC: ' + new Date().toLocaleTimeString();

        } catch (e) {
            addLog('Sync error: ' + e.message, 'var(--error-color)');
        }
    }

    setInterval(updateStats, 2000);
    updateStats();
    addLog('System monitoring active.');
</script>
</body>
</html>
        `;
        res.send(html);
    });

    return router;
}
