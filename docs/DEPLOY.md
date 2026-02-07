# Deployment Guide (Cloudflare)

This project ships with a one-command bootstrap workflow:

```bash
API_KEY='your-strong-key' npm run deploy:bootstrap
```

## What The Script Does

File: `scripts/bootstrap-deploy.sh`

1. Runs `wrangler whoami` to ensure CLI auth is ready.
2. Ensures KV namespace for `AUTH_STORE`.
3. Ensures D1 database for `DB`.
4. Writes resolved IDs back into `wrangler.toml`.
5. Writes `API_KEY` as Worker secret (if provided).
6. Deploys Worker.
7. Calls `/health` on the deployed workers.dev URL.

## Optional Environment Variables

- `API_KEY`: required for first setup; updates Worker secret `API_KEY`.
- `WORKER_NAME`: override Worker name.
- `KV_NAMESPACE_NAME`: override KV namespace name.
- `D1_DATABASE_NAME`: override D1 database name.
- `D1_LOCATION`: optional D1 primary location hint (`wnam`, `enam`, `weur`, etc).
- `AUTH_STORE_ID`: force existing KV namespace ID (skip creation).
- `DB_ID`: force existing D1 database ID (skip creation).
- `QWEN_CREDS_JSON_FILE`: optional path to seed credential JSON via secret `QWEN_CREDS_JSON`.
- `SKIP_SECRET=1`: skip secret writes.
- `SKIP_DEPLOY=1`: only bootstrap resources and config, skip deploy.
- `HEALTH_BASE_URL`: fallback base URL for health check if workers.dev URL cannot be parsed.

## Recommended Production Flow

1. `API_KEY='...' npm run deploy:bootstrap`
2. Open `/ui`, complete OAuth once.
3. Keep Admin auto refresh OFF by default.
4. Run periodic checks:
   - `curl https://<domain>/health`
   - `wrangler tail --status error`

## Notes

- This repo intentionally does not use GitHub Actions deployment.
- Runtime migrations are auto-applied by the Worker on cold start.
