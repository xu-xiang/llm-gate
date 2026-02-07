# llm-gate Architecture

## Runtime
- Platform: Cloudflare Workers
- HTTP framework: Hono
- Storage:
  - Cloudflare KV (`AUTH_STORE`) for OAuth credentials
  - Cloudflare D1 (`DB`) for usage/audit/provider registry

## Main Layers
- `src/index.ts`
  - Worker entrypoint
  - D1 auto migration
  - KV seeding (`QWEN_CREDS_JSON`)
- `src/app.ts`
  - App bootstrap and route mounting
  - Quota and provider initialization
- `src/routes/`
  - `/v1/chat/*`: OpenAI-compatible inference API
  - `/v1/tools/*`: auxiliary tool endpoints
  - `/admin/*`: admin UI and account operations
- `src/providers/qwen/`
  - OAuth token lifecycle
  - Multi-account routing/failover
  - Upstream request adaptation
- `src/core/`
  - `quota.ts`: daily + RPM accounting and audit aggregation
  - `providerRegistry.ts`: stable provider ID/alias persistence
  - `storage.ts`: KV abstraction + distributed lock
  - `monitor.ts`: global counters and uptime

## Data Model (D1)
- `usage_stats(date, provider_id, kind, count)`
- `request_audit_minute(minute_bucket, provider_id, kind, outcome, count)`
- `global_monitor(key, value)`
- `providers(id, alias, updated_at)`

## Request Flow (Chat)
1. API key auth (`/v1/*`)
2. Model routing in `routes/chat.ts`
3. `MultiQwenProvider` chooses available account
4. `QwenProvider` ensures credentials and calls upstream
5. `QuotaManager` writes daily + minute aggregates
6. Admin UI reads D1 aggregates for usage/audit

