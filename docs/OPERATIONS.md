# Operations Runbook

## Deploy
```bash
npm install
npx tsc --noEmit
npm run deploy
```

## Required Bindings
- KV: `AUTH_STORE`
- D1: `DB`

## Required Vars
- `API_KEY`

## Recommended Vars
- `CHAT_DAILY_LIMIT`
- `CHAT_RPM_LIMIT`
- `AUDIT_SUCCESS_LOG` (`false` by default)
- `PROVIDER_SCAN_SECONDS` (`60` by default)
- `PROVIDER_FULL_KV_SCAN_MINUTES` (`30` by default)

## Health Checks
- Worker health: `GET /health`
- Admin stats: `GET /admin/api/stats` with `X-Admin-Key`
- Chat probe:
```bash
curl -k -X POST 'https://<domain>/v1/chat/completions' \
  -H 'Authorization: Bearer <API_KEY>' \
  -H 'Content-Type: application/json' \
  --data '{"model":"coder-model","messages":[{"role":"user","content":"ping"}]}'
```

## Common Incidents

### 1) `No Qwen providers configured`
- Check KV keys for `qwen_creds_*.json`
- Re-login from `/admin/ui`
- Check `providers` table in D1

### 2) `All providers quota exceeded`
- Means upstream returned `insufficient_quota`
- Re-auth with another account, or wait for upstream quota reset

### 3) Usage/RPM not updating
- Check D1 migration status and `request_audit_minute` rows
- Verify minute bucket in Beijing time (`UTC+8`)

## Cost Guardrails (Free Tier Friendly)
- Minute-level aggregation with upsert (no per-request raw logs)
- `AUDIT_SUCCESS_LOG=false` hides success rows from UI list
- D1 writes only persist minute aggregate (`request_audit_minute`) per request path
- Provider pool uses D1 registry-first refresh, not high-frequency KV full scan
- OAuth credentials are cached in-memory for 5s per isolate to reduce KV read QPS
