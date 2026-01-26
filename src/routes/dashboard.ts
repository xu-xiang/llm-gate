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
                providers: qwenProvider.getAllProviderStatus()
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
            grid-template-columns: 1fr 1fr;
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
        <div class="stat-line"><span class="label">TOTAL REQS:</span><span class="value" id="total-reqs">0</span></div>
        <div class="stat-line"><span class="label">SUCCESS:</span><span class="value" style="color:var(--text-color)" id="success-reqs">0</span></div>
        <div class="stat-line"><span class="label">ERRORS:</span><span class="value" style="color:var(--error-color)" id="error-reqs">0</span></div>
        <div class="stat-line"><span class="label">RATE LIMITS:</span><span class="value" id="ratelimit-reqs">0</span></div>
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
            document.getElementById('total-reqs').textContent = data.monitor.total;
            document.getElementById('success-reqs').textContent = data.monitor.success;
            document.getElementById('error-reqs').textContent = data.monitor.error;
            const rlElement = document.getElementById('ratelimit-reqs');
            rlElement.textContent = data.monitor.rateLimited;
            if (data.monitor.rateLimited > 0) rlElement.classList.add('blink-warn');

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
                    
                    const dailyUsed = p.quota ? p.quota.daily.used : 0;
                    const dailyLimit = p.quota ? p.quota.daily.limit : 2000;
                    const dailyPercent = p.quota ? p.quota.daily.percent : 0;
                    
                    const rpmUsed = p.quota ? p.quota.rpm.used : 0;
                    const rpmLimit = p.quota ? p.quota.rpm.limit : 60;
                    const rpmPercent = p.quota ? p.quota.rpm.percent : 0;
                    
                    row.innerHTML = '<td>' + prefix + p.id + '</td>' +
                                  '<td class="' + statusClass + '">' + p.status.toUpperCase() + '</td>' +
                                  '<td>' + p.errorCount + '</td>' +
                                  '<td>' + 
                                    '<div style="margin-bottom:4px">' +
                                        '<span style="font-size:9px;color:var(--dim-text)">RPM: </span>' +
                                        '<div style="width:60px;background:#222;height:6px;display:inline-block;margin-right:5px;border:1px solid #444">' +
                                            '<div style="width:' + rpmPercent + '%;background:#00ffff;height:100%"></div>' +
                                        '</div>' +
                                        '<span style="font-size:9px">' + rpmUsed + '/' + rpmLimit + '</span>' +
                                    '</div>' +
                                    '<div>' +
                                        '<span style="font-size:9px;color:var(--dim-text)">DAY: </span>' +
                                        '<div style="width:60px;background:#222;height:6px;display:inline-block;margin-right:5px;border:1px solid #444">' +
                                            '<div style="width:' + dailyPercent + '%;background:var(--text-color);height:100%"></div>' +
                                        '</div>' +
                                        '<span style="font-size:9px">' + dailyUsed + '/' + dailyLimit + '</span>' +
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
