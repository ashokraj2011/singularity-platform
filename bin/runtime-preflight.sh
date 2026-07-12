#!/usr/bin/env bash
# Runtime dial-in preflight for a laptop/desktop MCP + LLM runtime.
# It validates configuration without printing secret values.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

for env_file in .env.laptop .env.local; do
  if [ -f "$env_file" ]; then
    set -a
    # shellcheck source=/dev/null
    . "$env_file"
    set +a
  fi
done

RUNTIME_BRIDGE_URL="${RUNTIME_BRIDGE_URL:-${LAPTOP_BRIDGE_URL:-ws://localhost:8000/api/runtime-bridge/connect}}"
RUNTIME_TOKEN_FILE="${RUNTIME_TOKEN_FILE:-${DEVICE_TOKEN_FILE:-$ROOT/.singularity/laptop-device-token}}"
MCP_SERVER_URL="${MCP_SERVER_URL:-http://localhost:7100}"
LLM_GATEWAY_URL="${LLM_GATEWAY_URL:-http://localhost:8001}"
RUNTIME_TENANT_ID="${RUNTIME_TENANT_ID:-${TENANT_ID:-default}}"
RUNTIME_USER_ID="${RUNTIME_USER_ID:-${BRIDGE_USER_ID:-}}"
RUNTIME_ID="${RUNTIME_ID:-${DEVICE_ID:-}}"

ok_count=0
warn_count=0
fail_count=0

check_required() {
  local key="$1"
  if [ -n "${!key:-}" ]; then
    printf '  [OK]   %-28s set\n' "$key"
    ok_count=$((ok_count + 1))
  else
    printf '  [FAIL] %-28s missing\n' "$key"
    fail_count=$((fail_count + 1))
  fi
}

check_optional() {
  local key="$1"
  if [ -n "${!key:-}" ]; then
    printf '  [OK]   %-28s set\n' "$key"
    ok_count=$((ok_count + 1))
  else
    printf '  [OPT]  %-28s optional\n' "$key"
    warn_count=$((warn_count + 1))
  fi
}

echo "Runtime dial-in preflight"
echo "workspace: ${RUNTIME_WORKSPACE:-${MCP_SANDBOX_ROOT:-<unset>}}"
echo
echo "Required identity and bridge configuration:"
check_required RUNTIME_ID
check_required RUNTIME_USER_ID
check_required RUNTIME_TENANT_ID
check_required RUNTIME_BRIDGE_URL
check_required RUNTIME_TOKEN_FILE

echo
echo "Runtime dependencies:"
check_required MCP_SERVER_URL
check_required LLM_GATEWAY_URL
check_optional GITHUB_TOKEN
check_optional OPENAI_API_KEY
check_optional ANTHROPIC_API_KEY
check_optional COPILOT_TOKEN

if [ -n "${RUNTIME_TOKEN_FILE:-}" ] && [ -f "$RUNTIME_TOKEN_FILE" ]; then
  token="$(tr -d '[:space:]' < "$RUNTIME_TOKEN_FILE")"
  if [[ "$token" == *.*.* ]]; then
    token_payload="${token#*.}"
    token_payload="${token_payload%%.*}"
    if payload_json="$(TOKEN_PAYLOAD="$token_payload" node - <<'NODE'
const token = process.env.TOKEN_PAYLOAD || '';
const padded = token.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - token.length % 4) % 4);
try { process.stdout.write(Buffer.from(padded, 'base64').toString('utf8')); } catch { process.exit(1); }
NODE
    )" && printf '%s' "$payload_json" | node -e 'const fs=require("fs"); const p=JSON.parse(fs.readFileSync(0,"utf8")); if (p.kind !== "runtime" && p.kind !== "device") process.exit(2); if (p.exp && p.exp <= Math.floor(Date.now()/1000)) process.exit(3);' 2>/dev/null; then
      echo "  [OK] runtime JWT shape and expiry valid"
      ok_count=$((ok_count + 1))
    else
      echo "  [FAIL] runtime token is malformed, expired, or not a runtime/device token"
      fail_count=$((fail_count + 1))
    fi
  else
    echo "  [FAIL] runtime token file does not contain a JWT"
    fail_count=$((fail_count + 1))
  fi
elif [ -n "${RUNTIME_TOKEN_FILE:-}" ]; then
  echo "  [FAIL] runtime token file not found: $RUNTIME_TOKEN_FILE"
  fail_count=$((fail_count + 1))
fi

for endpoint in "${CONTEXT_FABRIC_HEALTH_URL:-http://localhost:8000/health}" "${LLM_GATEWAY_URL:-http://localhost:8001}/health"; do
  if curl -fsS --max-time 4 "$endpoint" >/dev/null 2>&1; then
    echo "  [OK] reachable $endpoint"
    ok_count=$((ok_count + 1))
  else
    echo "  [WARN] unavailable $endpoint"
    warn_count=$((warn_count + 1))
  fi
done

if [ -n "${RUNTIME_WORKSPACE:-${MCP_SANDBOX_ROOT:-}}" ]; then
  workspace="${RUNTIME_WORKSPACE:-${MCP_SANDBOX_ROOT:-}}"
  if [ -d "$workspace" ] && [ -r "$workspace" ] && [ -w "$workspace" ]; then
    echo "  [OK] workspace readable and writable"
    ok_count=$((ok_count + 1))
  else
    echo "  [FAIL] workspace must exist and be readable/writable: $workspace"
    fail_count=$((fail_count + 1))
  fi
else
  echo "  [WARN] RUNTIME_WORKSPACE/MCP_SANDBOX_ROOT is not set"
  warn_count=$((warn_count + 1))
fi

echo
printf 'summary: %s passed, %s warnings, %s failures\n' "$ok_count" "$warn_count" "$fail_count"
if [ "$fail_count" -gt 0 ]; then
  echo "Fix required values, then run: bin/laptop-bridge.sh mcp"
  exit 1
fi
echo "Ready for runtime dial-in. The MCP process should dial Context Fabric; do not expose its bearer token in browser config."
