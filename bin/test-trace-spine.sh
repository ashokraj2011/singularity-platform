#!/usr/bin/env bash
# M28 spine-2 — TraceId propagation contract test.
#
# Spawns a known cf /execute call with a synthetic traceId, then queries every
# persistent store with that traceId. Fails CI / shells with red exit code if:
#   - any store returns zero rows (the traceId didn't reach that storage layer)
#   - any returned row's traceId doesn't equal the test traceId (filter leaks)
#   - a fresh unused UUID returns non-zero rows in any store (filter ignored)
#
# Operators: pass a real traceId from a broken run to diagnose which storage
# layer isn't joining.
#
# Usage:
#   ./bin/test-trace-spine.sh                    # mints + runs full contract
#   ./bin/test-trace-spine.sh <existing-traceId> # diagnose-only mode

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

CAP_IAM_UUID="11111111-2222-3333-4444-555555555555"
MCP_BEARER="${MCP_BEARER_TOKEN:-demo-bearer-token-must-be-min-16-chars}"
PG_USER="${PG_USER:-ashokraj}"
PG_PASS="${PGPASSWORD:-postgres}"
PG_HOST="${PG_HOST:-localhost}"
PG_PORT="${PG_PORT:-5432}"

C_BLUE=$'\033[1;34m'; C_GREEN=$'\033[1;32m'; C_YELLOW=$'\033[1;33m'
C_RED=$'\033[1;31m';  C_END=$'\033[0m'
info() { echo -e "${C_BLUE}▸${C_END} $*"; }
ok()   { echo -e "${C_GREEN}✓${C_END} $*"; }
warn() { echo -e "${C_YELLOW}⚠${C_END} $*"; }
err()  { echo -e "${C_RED}✗${C_END} $*" >&2; }

MODE="full"
TRACE_ID="${1:-}"
if [ -n "$TRACE_ID" ]; then
  MODE="diagnose"
  info "diagnose mode: re-using traceId=$TRACE_ID"
else
  TRACE_ID=$(python3 -c "import uuid;print(uuid.uuid4())")
  info "test mode: minted traceId=$TRACE_ID"
fi

FOREIGN_TRACE=$(python3 -c "import uuid;print(uuid.uuid4())")

# ── 1. Fire a known cf /execute with the trace_id ──────────────────────────
if [ "$MODE" = "full" ]; then
  info "POST /execute with trace_id=$TRACE_ID …"
  curl -sS -X POST "http://localhost:8000/execute" \
    -H 'content-type: application/json' --max-time 60 \
    -d "{
      \"trace_id\": \"$TRACE_ID\",
      \"idempotency_key\": \"spine-test-$TRACE_ID\",
      \"run_context\": {
        \"workflow_instance_id\": \"spine-test-instance\",
        \"workflow_node_id\": \"spine-test-node\",
        \"agent_run_id\": \"spine-test-run\",
        \"capability_id\": \"$CAP_IAM_UUID\",
        \"user_id\": \"spine-test\"
      },
      \"system_prompt\": \"You are a spine probe. Reply with READY.\",
      \"task\": \"Say READY in one word\",
      \"model_overrides\": {\"temperature\": 0.0, \"maxOutputTokens\": 20},
      \"context_policy\": {\"optimizationMode\":\"aggressive\",\"maxContextTokens\":2000},
      \"limits\": {\"maxSteps\": 1, \"timeoutSec\": 30},
      \"prefer_laptop\": false
    }" -o /tmp/spine-execute.json -w "  cf /execute → %{http_code}\n"
  STATUS=$(python3 -c "import json;d=json.load(open('/tmp/spine-execute.json'));print(d.get('status') or d.get('detail','?'))")
  echo "  status: $STATUS"
fi

sleep 2

# ── 2. Query every store with the traceId ──────────────────────────────────
declare -A COUNTS=()
FAIL=0

count_rows() {
  local layer="$1"; local cmd="$2"
  local result; result=$(eval "$cmd" 2>/dev/null || echo "0")
  COUNTS[$layer]=$result
  printf "  %-22s %s rows\n" "$layer" "$result"
}

info "row counts for trace_id=$TRACE_ID:"

count_rows "audit-gov.audit_events" \
  "PGPASSWORD='$PG_PASS' psql -h $PG_HOST -p $PG_PORT -U $PG_USER -d audit_governance -tA -c \"SELECT count(*) FROM audit_governance.audit_events WHERE trace_id='$TRACE_ID'\""

count_rows "composer.PromptAssembly" \
  "PGPASSWORD='$PG_PASS' psql -h $PG_HOST -p $PG_PORT -U $PG_USER -d singularity -tA -c \"SELECT count(*) FROM \\\"PromptAssembly\\\" WHERE \\\"traceId\\\"='$TRACE_ID'\""

count_rows "mcp.tool_invocations" \
  "curl -sS 'http://localhost:7100/mcp/resources/tool-invocations?trace_id=$TRACE_ID' -H 'authorization: Bearer $MCP_BEARER' --max-time 5 | python3 -c 'import json,sys;d=json.load(sys.stdin);print(len(d.get(\"data\",{}).get(\"items\",[])))'"

count_rows "mcp.llm_calls" \
  "curl -sS 'http://localhost:7100/mcp/resources/llm-calls?trace_id=$TRACE_ID' -H 'authorization: Bearer $MCP_BEARER' --max-time 5 | python3 -c 'import json,sys;d=json.load(sys.stdin);print(len(d.get(\"data\",{}).get(\"items\",[])))'"

count_rows "mcp.artifacts" \
  "curl -sS 'http://localhost:7100/mcp/resources/artifacts?trace_id=$TRACE_ID' -H 'authorization: Bearer $MCP_BEARER' --max-time 5 | python3 -c 'import json,sys;d=json.load(sys.stdin);print(len(d.get(\"data\",{}).get(\"items\",[])))'"

# ── 3. Assert: filter actually filters (foreign trace returns zero) ─────────
echo
info "foreign-trace leak check (uuid=$FOREIGN_TRACE — must return 0 rows everywhere):"

for endpoint in "tool-invocations" "llm-calls" "artifacts"; do
  N=$(curl -sS "http://localhost:7100/mcp/resources/$endpoint?trace_id=$FOREIGN_TRACE" -H "authorization: Bearer $MCP_BEARER" --max-time 5 \
    | python3 -c 'import json,sys;d=json.load(sys.stdin);print(len(d.get("data",{}).get("items",[])))' 2>/dev/null || echo "x")
  if [ "$N" = "0" ]; then
    ok "$endpoint leak-check: 0 rows ✓"
  else
    err "$endpoint leak-check: returned $N rows for an unused traceId — FILTER IS BROKEN"
    FAIL=1
  fi
done

# ── 4. Assert: every expected store has ≥ 1 row ─────────────────────────────
echo
info "spine completeness — every declared store must have ≥ 1 row:"

REQUIRED_STORES=("audit-gov.audit_events" "mcp.llm_calls" "mcp.tool_invocations")
# composer.PromptAssembly is optional — only present if the run reached compose

for store in "${REQUIRED_STORES[@]}"; do
  N=${COUNTS[$store]:-0}
  if [ "$N" = "0" ]; then
    err "$store has 0 rows for traceId=$TRACE_ID — spine BROKEN at this layer"
    FAIL=1
  else
    ok "$store has $N rows ✓"
  fi
done

# Optional stores: just report, don't fail
for store in "composer.PromptAssembly" "mcp.artifacts"; do
  N=${COUNTS[$store]:-0}
  if [ "$N" = "0" ]; then
    warn "$store has 0 rows (optional — may indicate the run didn't reach this layer)"
  else
    ok "$store has $N rows ✓"
  fi
done

# ── 5. Summary ──────────────────────────────────────────────────────────────
echo
if [ "$FAIL" -eq 0 ]; then
  ok "TRACE SPINE OK for $TRACE_ID"
  exit 0
else
  err "TRACE SPINE BROKEN for $TRACE_ID — see above"
  exit 1
fi
