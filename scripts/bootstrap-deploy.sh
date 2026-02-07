#!/usr/bin/env bash
set -euo pipefail

# One-command bootstrap + deploy for Cloudflare Workers.
# Officially aligned with Wrangler/KV/D1 workflow:
# - ensure auth (`wrangler whoami`)
# - ensure KV namespace and D1 database
# - update wrangler.toml bindings
# - optionally set API_KEY secret
# - deploy and verify /health

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WRANGLER_FILE="${ROOT_DIR}/wrangler.toml"

if ! command -v npx >/dev/null 2>&1; then
  echo "[ERROR] npx not found. Install Node.js first."
  exit 1
fi

if [[ ! -f "${WRANGLER_FILE}" ]]; then
  echo "[ERROR] wrangler.toml not found at ${WRANGLER_FILE}"
  exit 1
fi

echo "[1/7] Checking Cloudflare authentication..."
npx wrangler whoami >/dev/null

worker_name="${WORKER_NAME:-$(sed -n 's/^name = "\(.*\)"/\1/p' "${WRANGLER_FILE}" | head -1)}"
if [[ -z "${worker_name}" ]]; then
  echo "[ERROR] Failed to resolve worker name from wrangler.toml"
  exit 1
fi

kv_namespace_name="${KV_NAMESPACE_NAME:-${worker_name}-auth-store}"
d1_database_name="${D1_DATABASE_NAME:-${worker_name}-db}"
d1_location="${D1_LOCATION:-}"

extract_toml_value() {
  local key="$1"
  sed -n "s/^${key} = \"\\(.*\\)\"/\\1/p" "${WRANGLER_FILE}" | head -1
}

is_placeholder() {
  local v="$1"
  [[ -z "${v}" || "${v}" == "REPLACE_WITH_KV_NAMESPACE_ID" || "${v}" == "REPLACE_WITH_D1_DATABASE_ID" ]]
}

kv_id="${AUTH_STORE_ID:-$(extract_toml_value "id")}"
d1_id="${DB_ID:-$(extract_toml_value "database_id")}"
existing_d1_name="$(extract_toml_value "database_name")"

echo "[2/7] Resolving KV binding..."
if is_placeholder "${kv_id}"; then
  echo "  Creating KV namespace: ${kv_namespace_name}"
  kv_create_out="$(npx wrangler kv namespace create "${kv_namespace_name}" 2>&1)"
  kv_id="$(printf '%s\n' "${kv_create_out}" | grep -Eo 'id = "[^"]+"' | head -1 | sed -E 's/id = "([^"]+)"/\1/')"
  if [[ -z "${kv_id}" ]]; then
    echo "[ERROR] Failed to parse KV namespace id."
    printf '%s\n' "${kv_create_out}"
    exit 1
  fi
  echo "  KV created: ${kv_id}"
else
  echo "  Reusing KV id from config/env: ${kv_id}"
fi

echo "[3/7] Resolving D1 binding..."
if is_placeholder "${d1_id}"; then
  echo "  Creating D1 database: ${d1_database_name}"
  if [[ -n "${d1_location}" ]]; then
    d1_create_out="$(npx wrangler d1 create "${d1_database_name}" --location "${d1_location}" 2>&1)"
  else
    d1_create_out="$(npx wrangler d1 create "${d1_database_name}" 2>&1)"
  fi
  d1_id="$(printf '%s\n' "${d1_create_out}" | grep -Eo 'database_id = "[^"]+"' | head -1 | sed -E 's/database_id = "([^"]+)"/\1/')"
  if [[ -z "${d1_id}" ]]; then
    echo "[ERROR] Failed to parse D1 database id."
    printf '%s\n' "${d1_create_out}"
    exit 1
  fi
  echo "  D1 created: ${d1_id}"
else
  echo "  Reusing D1 id from config/env: ${d1_id}"
  if [[ -n "${existing_d1_name}" ]]; then
    d1_database_name="${existing_d1_name}"
  fi
fi

echo "[4/7] Updating wrangler.toml bindings..."
tmp_file="$(mktemp)"
sed -E "s/^id = \".*\"/id = \"${kv_id}\"/" "${WRANGLER_FILE}" \
  | sed -E "s/^database_name = \".*\"/database_name = \"${d1_database_name}\"/" \
  | sed -E "s/^database_id = \".*\"/database_id = \"${d1_id}\"/" > "${tmp_file}"
mv "${tmp_file}" "${WRANGLER_FILE}"

echo "[5/7] Setting secrets..."
if [[ "${SKIP_SECRET:-0}" == "1" ]]; then
  echo "  SKIP_SECRET=1 set; skipping secret writes."
else
  if [[ -n "${API_KEY:-}" ]]; then
    printf '%s' "${API_KEY}" | npx wrangler secret put API_KEY >/dev/null
    echo "  API_KEY secret updated."
  else
    echo "  API_KEY not provided; keeping existing API_KEY secret."
  fi

  if [[ -n "${QWEN_CREDS_JSON_FILE:-}" ]]; then
    if [[ ! -f "${QWEN_CREDS_JSON_FILE}" ]]; then
      echo "[ERROR] QWEN_CREDS_JSON_FILE not found: ${QWEN_CREDS_JSON_FILE}"
      exit 1
    fi
    cat "${QWEN_CREDS_JSON_FILE}" | npx wrangler secret put QWEN_CREDS_JSON >/dev/null
    echo "  QWEN_CREDS_JSON secret updated from file."
  fi
fi

if [[ "${SKIP_DEPLOY:-0}" == "1" ]]; then
  echo "[6/7] SKIP_DEPLOY=1 set; skip deploy."
  echo "[7/7] Done (bootstrap only)."
  exit 0
fi

echo "[6/7] Deploying Worker..."
deploy_out="$(npx wrangler deploy 2>&1)"
printf '%s\n' "${deploy_out}"

worker_url="$(printf '%s\n' "${deploy_out}" | grep -Eo 'https://[^ ]+workers.dev' | head -1)"
if [[ -z "${worker_url}" ]]; then
  worker_url="${HEALTH_BASE_URL:-}"
fi

echo "[7/7] Health check..."
if [[ -n "${worker_url}" ]]; then
  curl -fsS "${worker_url}/health" >/dev/null
  echo "  Health OK: ${worker_url}/health"
else
  echo "  No workers.dev URL parsed. Set HEALTH_BASE_URL to enable automatic check."
fi

echo "Done."
