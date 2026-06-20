#!/usr/bin/env bash
# Trace spine smoke gate.
#
# Proves that one application trace_id reaches the governed runtime evidence
# ledger and verifies the live Context Fabric schema needed for profile-backed
# receipts. In full mode it mints a trace id and runs a tiny governed
# single-turn call first. In diagnose mode it only inspects an existing trace id.
#
# Usage:
#   ./bin/test-trace-spine.sh                    # run + inspect a new trace
#   ./bin/test-trace-spine.sh <trace_id>         # diagnose an existing trace
#   ./bin/test-trace-spine.sh --diagnose <id>    # same, explicit
#
# Requirements for full mode:
#   - context-api reachable at CONTEXT_FABRIC_URL, default http://localhost:8000
#   - audit-governance reachable at AUDIT_GOV_URL, default http://localhost:8500
#   - Docker at-postgres container for split Context Fabric/composer DB checks
#   - MCP is optional; if reachable, its trace-scoped resource views are checked

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

CONTEXT_FABRIC_URL="${CONTEXT_FABRIC_URL:-http://localhost:8000}"
MCP_URL="${MCP_URL:-http://localhost:7100}"
AUDIT_GOV_URL="${AUDIT_GOV_URL:-http://localhost:8500}"
MCP_BEARER="${MCP_BEARER_TOKEN:-${MCP_DEMO_BEARER_TOKEN:-demo-bearer-token-must-be-min-16-chars}}"
CONTEXT_FABRIC_SERVICE_TOKEN="${CONTEXT_FABRIC_SERVICE_TOKEN:-dev-context-fabric-service-token}"
CAP_IAM_UUID="${TRACE_SPINE_CAPABILITY_ID:-11111111-2222-3333-4444-555555555555}"
TENANT_ID="${TRACE_SPINE_TENANT_ID:-trace-spine-tenant}"

C_BLUE=$'\033[1;34m'; C_GREEN=$'\033[1;32m'; C_YELLOW=$'\033[1;33m'
C_RED=$'\033[1;31m'; C_DIM=$'\033[2m'; C_END=$'\033[0m'
info() { echo -e "${C_BLUE}▸${C_END} $*"; }
ok()   { echo -e "${C_GREEN}✓${C_END} $*"; }
warn() { echo -e "${C_YELLOW}⚠${C_END} $*"; }
err()  { echo -e "${C_RED}✗${C_END} $*" >&2; }
dim()  { echo -e "${C_DIM}$*${C_END}"; }

usage() {
  sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'
}

MODE="full"
TRACE_ID=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --diagnose) MODE="diagnose"; TRACE_ID="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    --*) err "unknown flag: $1"; usage >&2; exit 2 ;;
    *) TRACE_ID="$1"; MODE="diagnose"; shift ;;
  esac
done

require() {
  command -v "$1" >/dev/null 2>&1 || { err "missing binary: $1"; exit 1; }
}
require curl
require python3
require docker

uuid() {
  python3 - <<'PY'
import uuid
print(uuid.uuid4())
PY
}

if [[ -z "$TRACE_ID" ]]; then
  TRACE_ID="$(uuid)"
  MODE="full"
fi
FOREIGN_TRACE="$(uuid)"

json_count() {
  python3 -c 'import json,sys; d=json.load(sys.stdin); print(len((d.get("data") or {}).get("items") or []))'
}

http_code() {
  curl -sS -o /dev/null -w '%{http_code}' --max-time "${2:-5}" "$1" 2>/dev/null || true
}

docker_container_running() {
  docker ps --format '{{.Names}}' | grep -qx "$1"
}

psql_at_postgres() {
  local db="$1"
  local sql="$2"
  if ! docker_container_running singularity-at-postgres; then
    echo "0"
    return
  fi
  docker exec singularity-at-postgres psql -U postgres -d "$db" -tA -c "$sql" 2>/dev/null | tail -1 | tr -d '[:space:]'
}

mcp_count() {
  local endpoint="$1"
  local trace_id="$2"
  curl -sS "${MCP_URL%/}/mcp/resources/${endpoint}?trace_id=${trace_id}&limit=200" \
    -H "authorization: Bearer $MCP_BEARER" --max-time 8 2>/dev/null | json_count 2>/dev/null || echo "0"
}

audit_count() {
  local trace_id="$1"
  python3 - "$AUDIT_GOV_URL" "$trace_id" <<'PY' 2>/dev/null || echo "0"
import json
import sys
import urllib.request

base, trace_id = sys.argv[1].rstrip("/"), sys.argv[2]
body = json.dumps({"traceId": trace_id, "limit": 500}).encode()
req = urllib.request.Request(
    f"{base}/api/v1/audit/search",
    data=body,
    headers={"content-type": "application/json"},
)
with urllib.request.urlopen(req, timeout=8) as resp:
    data = json.loads(resp.read().decode())
items = data.get("items") or data.get("events") or []
print(len(items))
PY
}

preflight_full_mode() {
  local cf_health audit_health
  cf_health="$(http_code "${CONTEXT_FABRIC_URL%/}/health" 5)"
  if [[ "$cf_health" != "200" ]]; then
    err "context-api is not reachable at ${CONTEXT_FABRIC_URL%/}/health (HTTP ${cf_health:-000})"
    exit 1
  fi

  audit_health="$(http_code "${AUDIT_GOV_URL%/}/health" 5)"
  if [[ "$audit_health" != "200" ]]; then
    err "audit-governance is not reachable at ${AUDIT_GOV_URL%/}/health (HTTP ${audit_health:-000}). Start it with: ./singularity.sh up --profile audit"
    exit 1
  fi

  if ! docker_container_running singularity-at-postgres; then
    err "singularity-at-postgres is not running; cannot verify split Context Fabric/composer stores"
    exit 1
  fi
}

run_probe() {
  local tmp status http
  tmp="$(mktemp -t trace-spine.XXXXXX.json)"
  trap 'rm -f "$tmp"' RETURN
  info "POST /api/v1/execute-governed-single-turn with trace_id=$TRACE_ID"
  http="$(curl -sS -X POST "${CONTEXT_FABRIC_URL%/}/api/v1/execute-governed-single-turn" \
    -H 'content-type: application/json' \
    -H "x-service-token: $CONTEXT_FABRIC_SERVICE_TOKEN" \
    -H "x-singularity-trace-id: $TRACE_ID" \
    --max-time 90 \
    -o "$tmp" \
    -w '%{http_code}' \
    -d "{
      \"trace_id\": \"$TRACE_ID\",
      \"idempotency_key\": \"spine-test-$TRACE_ID\",
      \"run_context\": {
        \"trace_id\": \"$TRACE_ID\",
        \"workflow_instance_id\": \"spine-test-instance-$TRACE_ID\",
        \"workflow_node_id\": \"spine-test-node\",
        \"agent_run_id\": \"spine-test-run\",
        \"capability_id\": \"$CAP_IAM_UUID\",
        \"tenant_id\": \"$TENANT_ID\",
        \"user_id\": \"spine-test\"
      },
      \"system_prompt\": \"You are a spine probe. Reply with READY.\",
      \"task\": \"Say READY in one word.\",
      \"model_overrides\": {\"temperature\": 0.0, \"maxOutputTokens\": 20},
      \"limits\": {\"timeoutSec\": 45}
    }" || true)"
  status="$(python3 - "$tmp" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
    print(d.get("status") or d.get("detail") or d.get("error") or "?")
except Exception:
    print("?")
PY
)"
  echo "  cf /execute → HTTP $http status=$status"
  if [[ "$http" != "200" ]]; then
    err "Context Fabric probe failed; response body:"
    sed -n '1,20p' "$tmp" >&2
    exit 1
  fi
}

FAIL=0
CONTEXT_CALL_LOG=0
CONTEXT_EVENTS=0
COMPOSER_PROMPT_ASSEMBLY=0
MCP_LLM_CALLS=0
MCP_TOOL_INVOCATIONS=0
MCP_ARTIFACTS=0
AUDIT_GOV_EVENTS=0

record_count() {
  local key="$1"
  local value="$2"
  case "$key" in
    context.call_log) CONTEXT_CALL_LOG="$value" ;;
    context.events) CONTEXT_EVENTS="$value" ;;
    composer.PromptAssembly) COMPOSER_PROMPT_ASSEMBLY="$value" ;;
    mcp.llm_calls) MCP_LLM_CALLS="$value" ;;
    mcp.tool_invocations) MCP_TOOL_INVOCATIONS="$value" ;;
    mcp.artifacts) MCP_ARTIFACTS="$value" ;;
    audit-gov.audit_events) AUDIT_GOV_EVENTS="$value" ;;
  esac
  printf "  %-28s %s rows\n" "$key" "$value"
}

get_count() {
  case "$1" in
    context.call_log) echo "$CONTEXT_CALL_LOG" ;;
    context.events) echo "$CONTEXT_EVENTS" ;;
    composer.PromptAssembly) echo "$COMPOSER_PROMPT_ASSEMBLY" ;;
    mcp.llm_calls) echo "$MCP_LLM_CALLS" ;;
    mcp.tool_invocations) echo "$MCP_TOOL_INVOCATIONS" ;;
    mcp.artifacts) echo "$MCP_ARTIFACTS" ;;
    audit-gov.audit_events) echo "$AUDIT_GOV_EVENTS" ;;
    *) echo "0" ;;
  esac
}

if [[ "$MODE" == "full" ]]; then
  info "full mode: minted trace_id=$TRACE_ID"
  preflight_full_mode
  run_probe
else
  info "diagnose mode: trace_id=$TRACE_ID"
fi

sleep 2

info "row/resource counts for trace_id=$TRACE_ID"
record_count "context.call_log" \
  "$(psql_at_postgres singularity_context_fabric "SELECT count(*) FROM call_log WHERE trace_id = '$TRACE_ID';")"
record_count "context.events" \
  "$(psql_at_postgres singularity_context_fabric "SELECT count(*) FROM events WHERE trace_id = '$TRACE_ID';")"
record_count "composer.PromptAssembly" \
  "$(psql_at_postgres singularity_composer "SELECT count(*) FROM \"PromptAssembly\" WHERE \"traceId\" = '$TRACE_ID';")"

echo
info "Context Fabric profile evidence schema"
profile_evidence_columns="$(psql_at_postgres singularity_context_fabric "SELECT count(*) FROM information_schema.columns WHERE table_name = 'call_log' AND column_name IN ('profile_snapshot_hash', 'profile_provider_resolutions_json', 'profile_effective_capabilities_json');")"
if [[ "$profile_evidence_columns" == "3" ]]; then
  ok "call_log has profile snapshot/provider/effective-capability evidence columns"
else
  err "call_log is missing profile evidence column(s): found $profile_evidence_columns/3"
  FAIL=1
fi

if [[ "$(http_code "${MCP_URL%/}/health" 5)" == "200" ]]; then
  record_count "mcp.llm_calls" "$(mcp_count llm-calls "$TRACE_ID")"
  record_count "mcp.tool_invocations" "$(mcp_count tool-invocations "$TRACE_ID")"
  record_count "mcp.artifacts" "$(mcp_count artifacts "$TRACE_ID")"
else
  warn "MCP not reachable at $MCP_URL; skipping MCP resource counts"
  MCP_LLM_CALLS=0
  MCP_TOOL_INVOCATIONS=0
  MCP_ARTIFACTS=0
fi

if [[ "$(http_code "${AUDIT_GOV_URL%/}/health" 5)" == "200" ]]; then
  record_count "audit-gov.audit_events" "$(audit_count "$TRACE_ID")"
else
  warn "audit-gov not reachable at $AUDIT_GOV_URL; skipping audit-gov count"
  AUDIT_GOV_EVENTS=0
fi

echo
info "foreign-trace leak checks (uuid=$FOREIGN_TRACE)"
foreign_context_calls="$(psql_at_postgres singularity_context_fabric "SELECT count(*) FROM call_log WHERE trace_id = '$FOREIGN_TRACE';")"
if [[ "$foreign_context_calls" == "0" ]]; then ok "context.call_log leak-check: 0 rows"; else err "context.call_log returned $foreign_context_calls rows for unused trace"; FAIL=1; fi

if [[ "$(http_code "${MCP_URL%/}/health" 5)" == "200" ]]; then
  for endpoint in llm-calls tool-invocations artifacts; do
    n="$(mcp_count "$endpoint" "$FOREIGN_TRACE")"
    if [[ "$n" == "0" ]]; then ok "mcp.$endpoint leak-check: 0 rows"; else err "mcp.$endpoint returned $n rows for unused trace"; FAIL=1; fi
  done
fi

echo
info "spine completeness"
required=()
if [[ "$MODE" == "full" ]]; then
  required+=("audit-gov.audit_events")
elif [[ "$(get_count audit-gov.audit_events)" =~ ^[0-9]+$ && "$(get_count audit-gov.audit_events)" -gt 0 ]]; then
  required+=("audit-gov.audit_events")
else
  required+=("context.call_log")
fi

for key in "${required[@]}"; do
  n="$(get_count "$key")"
  if [[ "$n" =~ ^[0-9]+$ && "$n" -gt 0 ]]; then
    ok "$key has $n rows"
  else
    err "$key has 0 rows for trace_id=$TRACE_ID"
    FAIL=1
  fi
done

for key in "context.call_log" "context.events" "composer.PromptAssembly" "mcp.llm_calls" "mcp.tool_invocations" "mcp.artifacts"; do
  n="$(get_count "$key")"
  if [[ "$n" =~ ^[0-9]+$ && "$n" -gt 0 ]]; then ok "$key has $n rows"; else warn "$key has 0 rows (may be normal for this probe path)"; fi
done

echo
if [[ "$FAIL" -eq 0 ]]; then
  ok "TRACE SPINE OK for $TRACE_ID"
  dim "For distributed OTel proof, run with Jaeger/collector enabled and inspect the same traceparent-linked request tree."
  exit 0
fi

err "TRACE SPINE BROKEN for $TRACE_ID"
exit 1
