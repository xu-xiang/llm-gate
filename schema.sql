-- 统计表：按天、按 Provider、按类型聚合
-- 极致节约行数：同一天同一个账号，只更新一行，而不是 insert 多行
CREATE TABLE IF NOT EXISTS usage_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,          -- YYYY-MM-DD
    provider_id TEXT NOT NULL,   -- e.g. ./oauth_creds_1.json
    kind TEXT NOT NULL,          -- 'chat' or 'search'
    count INTEGER DEFAULT 0,
    UNIQUE(date, provider_id, kind)
);

-- 全局监控表：只存最新的聚合值
CREATE TABLE IF NOT EXISTS global_monitor (
    key TEXT PRIMARY KEY,        -- 'uptime_start', 'total_requests', 'total_errors'
    value INTEGER DEFAULT 0
);

-- 按分钟聚合审计日志：低写入成本地记录访问结果和限流命中
CREATE TABLE IF NOT EXISTS request_audit_minute (
    minute_bucket TEXT NOT NULL, -- YYYY-MM-DDTHH:MM (Beijing)
    provider_id TEXT NOT NULL,
    kind TEXT NOT NULL,          -- 'chat' or 'search'
    outcome TEXT NOT NULL,       -- 'success' | 'limited:daily' | 'limited:rpm' | 'error:*'
    count INTEGER DEFAULT 0,
    PRIMARY KEY (minute_bucket, provider_id, kind, outcome)
);

-- Provider 注册表：稳定记录账号 ID 和别名，避免 KV list 的跨节点不一致
CREATE TABLE IF NOT EXISTS providers (
    id TEXT PRIMARY KEY,
    alias TEXT,
    updated_at INTEGER DEFAULT (unixepoch())
);

-- 初始化启动时间（如果不存在）
INSERT OR IGNORE INTO global_monitor (key, value) VALUES ('uptime_start', unixepoch());
