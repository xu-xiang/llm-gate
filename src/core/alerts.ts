import { D1Database, KVNamespace } from '@cloudflare/workers-types';
import { logger } from './logger';
import { getBeijingDate } from './time';

type WebhookType = 'dingtalk' | 'feishu';

type EventState = {
    active: boolean;
    fingerprint?: string;
};

type AlertState = {
    events: Record<string, EventState>;
};

const ALERT_STATE_KEY = 'alert_state_v1';

function parseIntSafe(v: string | undefined, fallback: number) {
    if (!v) return fallback;
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : fallback;
}

function nowIso() {
    return new Date().toISOString();
}

function toLocalTimeString() {
    return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}

function detectWebhookType(url: string, override?: string): WebhookType | null {
    if (override === 'dingtalk' || override === 'feishu') return override;
    if (url.includes('oapi.dingtalk.com')) return 'dingtalk';
    if (url.includes('open.feishu.cn')) return 'feishu';
    return null;
}

function buildTitle(level: 'ALERT' | 'RECOVERY', topic: string) {
    return `[${level}] ${topic}`;
}

async function sendWebhook(url: string, type: WebhookType, title: string, lines: string[]) {
    const bodyText = lines.join('\n');
    let payload: any;

    if (type === 'dingtalk') {
        payload = {
            msgtype: 'markdown',
            markdown: {
                title,
                text: `### ${title}\n\n${lines.map((l) => `- ${l}`).join('\n')}`
            }
        };
    } else {
        payload = {
            msg_type: 'text',
            content: {
                text: `${title}\n${bodyText}`
            }
        };
    }

    const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    if (!resp.ok) {
        const txt = await resp.text().catch(() => '');
        throw new Error(`Webhook HTTP ${resp.status}: ${txt}`);
    }
}

async function loadState(kv: KVNamespace): Promise<AlertState> {
    const s = await kv.get(ALERT_STATE_KEY, 'json');
    if (!s || typeof s !== 'object') return { events: {} };
    return s as AlertState;
}

async function saveState(kv: KVNamespace, state: AlertState) {
    await kv.put(ALERT_STATE_KEY, JSON.stringify(state));
}

async function evaluateAuthExpiredProviders(db: D1Database): Promise<string[]> {
    // "彻底失效"定义：
    // 最近30分钟内该账号出现 auth_expired，且同窗口内无 success。
    const rows = await db.prepare(
        `
        SELECT provider_id,
               SUM(CASE WHEN outcome = 'error:auth_expired' THEN count ELSE 0 END) AS expired_cnt,
               SUM(CASE WHEN outcome = 'success' THEN count ELSE 0 END) AS success_cnt
        FROM request_audit_minute
        WHERE minute_bucket >= strftime('%Y-%m-%dT%H:%M', datetime('now', '+8 hours', '-30 minutes'))
          AND kind = 'chat'
        GROUP BY provider_id
        `
    ).all();

    const bad: string[] = [];
    for (const r of rows.results as any[]) {
        const expired = Number(r.expired_cnt || 0);
        const success = Number(r.success_cnt || 0);
        if (expired > 0 && success === 0) bad.push(String(r.provider_id));
    }
    return bad.sort();
}

async function evaluateGlobalQuota(db: D1Database, chatDailyLimitPerAccount: number) {
    const datePrefix = `${getBeijingDate()}%`;
    const totalRow = await db.prepare(
        `
        SELECT SUM(count) AS total
        FROM request_audit_minute
        WHERE minute_bucket LIKE ?1
          AND kind = 'chat'
        `
    ).bind(datePrefix).first<any>();
    const providerCountRow = await db.prepare(`SELECT COUNT(*) AS c FROM providers`).first<any>();

    const total = Number(totalRow?.total || 0);
    const providerCount = Math.max(1, Number(providerCountRow?.c || 0));
    const limit = providerCount * chatDailyLimitPerAccount;
    const percent = limit > 0 ? (total / limit) * 100 : 0;
    return { total, providerCount, limit, percent };
}

function fingerprint(ids: string[]) {
    return ids.join(',');
}

export async function runBusinessAlerts(env: {
    AUTH_STORE: KVNamespace;
    DB: D1Database;
    CHAT_DAILY_LIMIT?: string;
    ALERT_ENABLED?: string;
    ALERT_WEBHOOK_URL?: string;
    ALERT_WEBHOOK_TYPE?: string;
    ALERT_QUOTA_THRESHOLD_PERCENT?: string;
}) {
    if (env.ALERT_ENABLED !== 'true') return;
    const webhookUrl = env.ALERT_WEBHOOK_URL || '';
    if (!webhookUrl) return;

    const webhookType = detectWebhookType(webhookUrl, env.ALERT_WEBHOOK_TYPE);
    if (!webhookType) {
        logger.warn('[Alert] Unsupported webhook type');
        return;
    }

    const threshold = parseIntSafe(env.ALERT_QUOTA_THRESHOLD_PERCENT, 80);
    const recoveryThreshold = Math.max(1, threshold - 5);
    const chatDailyLimitPerAccount = parseIntSafe(env.CHAT_DAILY_LIMIT, 2000);
    const state = await loadState(env.AUTH_STORE);

    const badProviders = await evaluateAuthExpiredProviders(env.DB);
    const quota = await evaluateGlobalQuota(env.DB, chatDailyLimitPerAccount);
    const now = nowIso();
    const localTime = toLocalTimeString();

    // Event 1: account auth expired (persistent in last window)
    const authKey = 'provider_auth_expired';
    const authNowActive = badProviders.length > 0;
    const authFp = fingerprint(badProviders);
    const authPrev = state.events[authKey] || { active: false };
    if (authNowActive && (!authPrev.active || authPrev.fingerprint !== authFp)) {
        await sendWebhook(
            webhookUrl,
            webhookType,
            buildTitle('ALERT', 'Qwen账号认证失效'),
            [
                `时间: ${localTime}`,
                `UTC: ${now}`,
                `失效账号数: ${badProviders.length}`,
                `账号: ${badProviders.join(', ')}`,
                '建议: 在管理后台删除并重新OAuth登录这些账号。'
            ]
        );
    } else if (!authNowActive && authPrev.active) {
        await sendWebhook(
            webhookUrl,
            webhookType,
            buildTitle('RECOVERY', 'Qwen账号认证恢复'),
            [
                `时间: ${localTime}`,
                `UTC: ${now}`,
                '状态: 最近窗口内未检测到认证失效账号。'
            ]
        );
    }
    state.events[authKey] = { active: authNowActive, fingerprint: authFp };

    // Event 2: global daily quota threshold
    const quotaKey = 'global_quota_80';
    const quotaNowActive = quota.percent >= threshold;
    const quotaPrev = state.events[quotaKey] || { active: false };
    if (quotaNowActive && !quotaPrev.active) {
        await sendWebhook(
            webhookUrl,
            webhookType,
            buildTitle('ALERT', '网关整体日额度达到阈值'),
            [
                `时间: ${localTime}`,
                `UTC: ${now}`,
                `当前占用: ${quota.total}/${quota.limit} (${quota.percent.toFixed(1)}%)`,
                `账号数: ${quota.providerCount}`,
                `单账号日限额: ${chatDailyLimitPerAccount}`,
                `阈值: ${threshold}%`
            ]
        );
    } else if (!quotaNowActive && quotaPrev.active && quota.percent < recoveryThreshold) {
        await sendWebhook(
            webhookUrl,
            webhookType,
            buildTitle('RECOVERY', '网关整体日额度恢复'),
            [
                `时间: ${localTime}`,
                `UTC: ${now}`,
                `当前占用: ${quota.total}/${quota.limit} (${quota.percent.toFixed(1)}%)`,
                `恢复阈值: < ${recoveryThreshold}%`
            ]
        );
    }
    state.events[quotaKey] = { active: quotaNowActive };

    await saveState(env.AUTH_STORE, state);
}
