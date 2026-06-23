#!/usr/bin/env bash
# bin/doctor.sh — bare-metal preflight doctor.
#
# One pass over the known bare-metal gap classes so you see ALL remaining issues
# at once instead of discovering them one click at a time:
#   1. Services      — every port up + responding
#   2. Platform env — the .env.local keys that keep Platform Web links same-origin
#   3. Seeds         — baseline agent templates, demo users, SDLC + demo workflows,
#                      audit risk_level column
#   4. Auth          — IAM local login works (what every app's session depends on)
#
# Each failure prints a remediation hint. `--fix` applies the SAFE ones
# (append missing .env.local keys). Seed/service fixes are printed, not run.
#
#   bin/doctor.sh           # report
#   BOX_ONLY=1 bin/doctor.sh # report with local llm-gateway/MCP treated as remote
#   bin/doctor.sh --fix     # report + append any missing .env.local keys
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT"
FIX=0; [ "${1:-}" = "--fix" ] && FIX=1
[ "${BOX_ONLY:-}" = "1" ] || BOX_ONLY=""

C_G=$'\033[32m'; C_Y=$'\033[33m'; C_R=$'\033[31m'; C_B=$'\033[1m'; C_E=$'\033[0m'
PASS=0; WARN=0; FAIL=0
pass(){ printf "  ${C_G}✔${C_E} %s\n" "$1"; PASS=$((PASS+1)); }
warn(){ printf "  ${C_Y}▲${C_E} %s\n      ${C_Y}↳${C_E} %s\n" "$1" "$2"; WARN=$((WARN+1)); }
fail(){ printf "  ${C_R}✘${C_E} %s\n      ${C_R}↳${C_E} %s\n" "$1" "$2"; FAIL=$((FAIL+1)); }
section(){ printf "\n${C_B}%s${C_E}\n" "$1"; }

CONF="$ROOT/.singularity/setup.conf"; [ -f "$CONF" ] && . "$CONF"
PG_USER="${PG_USER:-${USER:-postgres}}"; PG_PASS="${PG_PASS:-postgres}"
PG_HOST="${PG_HOST:-localhost}"; PG_PORT="${PG_PORT:-5432}"
export PGPASSWORD="$PG_PASS"

http_code(){
  local code
  if command -v curl >/dev/null 2>&1; then
    code="$(curl -s -o /dev/null -w "%{http_code}" --max-time 4 "$1" 2>/dev/null || true)"
  else
    code="$(python3 - "$1" <<'PY' 2>/dev/null || true
import sys
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

try:
    res = urlopen(Request(sys.argv[1]), timeout=4)
    print(res.status)
except HTTPError as exc:
    print(exc.code)
except (OSError, URLError, TimeoutError):
    print("000")
PY
)"
  fi
  code="${code:-000}"
  printf '%s' "${code: -3}"
}
http_get(){
  if command -v curl >/dev/null 2>&1; then
    curl -s --max-time "${2:-6}" "$1" 2>/dev/null || true
  else
    python3 - "$1" "${2:-6}" <<'PY' 2>/dev/null || true
import sys
from urllib.request import Request, urlopen

try:
    with urlopen(Request(sys.argv[1]), timeout=float(sys.argv[2])) as res:
        sys.stdout.write(res.read().decode("utf-8", "replace"))
except Exception:
    pass
PY
  fi
}
http_post_json(){
  local url="$1" body="$2" timeout="${3:-6}"
  if command -v curl >/dev/null 2>&1; then
    curl -s --max-time "$timeout" -X POST "$url" -H 'content-type: application/json' -d "$body" 2>/dev/null || true
  else
    python3 - "$url" "$timeout" "$body" <<'PY' 2>/dev/null || true
import sys
from urllib.request import Request, urlopen

try:
    req = Request(sys.argv[1], data=sys.argv[3].encode("utf-8"), headers={"content-type": "application/json"}, method="POST")
    with urlopen(req, timeout=float(sys.argv[2])) as res:
        sys.stdout.write(res.read().decode("utf-8", "replace"))
except Exception:
    pass
PY
  fi
}
psql_q(){ psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$1" -tAc "$2" 2>/dev/null | tr -d '[:space:]'; }
psql_rows(){ psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$1" -tAc "$2" 2>/dev/null | sed '/^[[:space:]]*$/d'; }
db_up(){ psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$1" -tAc 'select 1' >/dev/null 2>&1; }

printf "${C_B}Singularity bare-metal doctor${C_E}  (pg=%s@%s:%s, fix=%s)\n" "$PG_USER" "$PG_HOST" "$PG_PORT" "$FIX"

# ── 1. Services ──────────────────────────────────────────────────────────────
section "1. Services"
services=(
  "IAM|http://localhost:8100/api/v1/health" \
  "workgraph-api|http://localhost:8080/health" \
  "agent-service|http://localhost:3001/health" \
  "tool-service|http://localhost:3002/health" \
  "agent-runtime|http://localhost:3003/health" \
  "prompt-composer|http://localhost:3004/health" \
  "audit-gov|http://localhost:8500/health" \
  "context-fabric|http://localhost:8000/health" \
  "platform-web|http://localhost:5180/" \
  "platform-agents|http://localhost:5180/agents/studio" \
  "platform-workflows|http://localhost:5180/workflows" \
  "platform-workbench|http://localhost:5180/workbench" \
  "platform-foundry|http://localhost:5180/foundry" \
  "platform-identity|http://localhost:5180/identity"
)
for s in "${services[@]}"; do
  name="${s%%|*}"; url="${s##*|}"; code=$(http_code "$url")
  if [ "$code" = "000" ]; then fail "$name down ($url)" "start: bin/setup.sh --yes   ·   logs: bin/bare-metal-apps.sh logs $name"
  else pass "$name up ($code)"; fi
done
runtime_services=(
  "llm-gateway|http://localhost:8001/health"
  "mcp-server|http://localhost:7100/health"
)
if [ -n "$BOX_ONLY" ]; then
  warn "local runtime checks skipped" "BOX_ONLY=1 assumes llm-gateway and MCP run on a laptop or remote endpoint"
else
  for s in "${runtime_services[@]}"; do
    name="${s%%|*}"; url="${s##*|}"; code=$(http_code "$url")
    if [ "$code" = "000" ]; then warn "$name not running locally" "optional/remote-capable runtime; start locally with bin/bare-metal-runtime.sh up"
    else pass "$name up ($code)"; fi
  done
fi
runtime_status=$(http_get http://localhost:5180/api/runtime-infrastructure 6)
runtime_summary=$(printf '%s' "$runtime_status" | python3 -c 'import json,sys
try:
  data=json.load(sys.stdin)
  s=data.get("summary",{})
  print("%s/%s optional healthy" % (s.get("optionalHealthy",0), s.get("optionalConfigured",0)))
  sys.exit(0 if s.get("requiredHealthy") else 2)
except Exception:
  print("")
  sys.exit(1)' 2>/dev/null)
case "$?" in
  0) pass "platform runtime registry ($runtime_summary)" ;;
  2) fail "platform runtime registry reports required service unhealthy" "open http://localhost:5180/operations/readiness" ;;
  *) warn "platform runtime registry unavailable" "open http://localhost:5180/operations/readiness after platform-web is running" ;;
esac

# ── 2. Platform Web env (.env.local) ─────────────────────────────────────────
section "2. Platform Web env (.env.local)"
ensure_kv(){ # relpath  KEY=VALUE
  local rel="$1" kv="$2" key="${2%%=*}" f="$ROOT/$1"
  if [ -f "$f" ] && grep -q "^${key}=${kv#*=}$" "$f"; then
    pass "$rel · $key"
  elif [ "$FIX" = "1" ]; then
    mkdir -p "$(dirname "$f")"; touch "$f"
    if grep -q "^${key}=" "$f"; then
      tmp="${f}.tmp.$$"
      sed "s#^${key}=.*#${kv}#" "$f" > "$tmp" && mv "$tmp" "$f"
      pass "$rel · $key ${C_Y}(updated)${C_E}"
    else
      printf '%s\n' "$kv" >> "$f"
      pass "$rel · $key ${C_Y}(added)${C_E}"
    fi
  else
    fail "$rel missing or stale $key" "set '$kv' in $rel   (or run bin/doctor.sh --fix)"
  fi
}
ensure_kv "agent-and-tools/web/.env.local" "NEXT_PUBLIC_LINK_WORKGRAPH_DESIGNER=/workflows"
ensure_kv "agent-and-tools/web/.env.local" "NEXT_PUBLIC_LINK_BLUEPRINT_WORKBENCH=/workbench"
ensure_kv "agent-and-tools/web/.env.local" "NEXT_PUBLIC_LINK_IAM_ADMIN=/identity"
ensure_kv "agent-and-tools/web/.env.local" "NEXT_PUBLIC_LINK_OPERATIONS_PORTAL=/operations"
ensure_kv "agent-and-tools/web/.env.local" "NEXT_PUBLIC_WORKGRAPH_WEB_URL=/workflows"
[ "$FIX" = "1" ] && warn "env keys were appended" "restart Platform Web: bin/bare-metal-apps.sh down && bin/setup.sh --yes"

# ── 3. Seeds ─────────────────────────────────────────────────────────────────
section "3. Seeds"
seed_apply="seed/apply.sh $PG_USER $PG_PASS $PG_HOST $PG_PORT"
ar_url="postgresql://$PG_USER:$PG_PASS@$PG_HOST:$PG_PORT/singularity"
wg_url="postgresql://$PG_USER:$PG_PASS@$PG_HOST:$PG_PORT/workgraph"

if db_up singularity_iam; then
  n=$(psql_q singularity_iam "select count(*) from iam.users where email like 'user%@singularity.local'")
  [ "${n:-0}" -ge 1 ] && pass "IAM demo users ($n)" || fail "IAM demo users missing" "$seed_apply"
else fail "cannot reach DB 'singularity_iam'" "is Postgres up + creds in .singularity/setup.conf correct?"; fi

if db_up singularity; then
  n=$(psql_q singularity 'select count(*) from "AgentTemplate" where "capabilityId" is null')
  [ "${n:-0}" -ge 8 ] && pass "agent baseline templates ($n)" \
    || fail "agent baseline templates ($n/8)" "(cd agent-and-tools/apps/agent-runtime && DATABASE_URL=$ar_url npm run prisma:seed)"
else fail "cannot reach DB 'singularity'" "Postgres / creds"; fi

if db_up workgraph; then
  wg_seed_fix="(cd workgraph-studio/apps/api && DATABASE_URL=$wg_url npm run prisma:seed && SEED_CAPABILITY_ID=11111111-2222-3333-4444-555555555555 SEED_TEAM_ID=50000000-0000-0000-0000-000000000001 DATABASE_URL=$wg_url npx ts-node --transpile-only prisma/seed-sdlc-workbench.ts && SEED_CAPABILITY_ID=11111111-2222-3333-4444-555555555555 SEED_TEAM_ID=50000000-0000-0000-0000-000000000001 DATABASE_URL=$wg_url npx ts-node --transpile-only prisma/seed-sdlc-main.ts && SEED_CAPABILITY_ID=11111111-2222-3333-4444-555555555555 SEED_TEAM_ID=50000000-0000-0000-0000-000000000001 DATABASE_URL=$wg_url npx ts-node --transpile-only prisma/seed-sdlc-copilot.ts && DATABASE_URL=$wg_url npx ts-node --transpile-only prisma/seed-workbench-parents.ts)"
  missing_workflows=$(psql_rows workgraph "with expected(name, profile, type_key) as (values
    ('SDLC — Capability Implementation (Workbench)', 'workbench', 'SDLC'),
    ('Bug Fix (Workbench)', 'workbench', 'BUGFIX'),
    ('Approval Pipeline', 'main', 'GENERAL'),
    ('Branching Review', 'main', 'GENERAL'),
    ('Epic → Story (Parent → Child)', 'main', 'GENERAL'),
    ('SDLC implementation loop', 'workbench', 'SDLC'),
    ('SDLC Delivery', 'main', 'SDLC'),
    ('SDLC (Copilot CLI)', 'main', 'SDLC')
  )
  select e.name
  from expected e
  left join workflow_templates w
    on w.name=e.name and w.profile=e.profile and w.\"workflowTypeKey\"=e.type_key and w.\"archivedAt\" is null
  where w.id is null
  order by e.name")
  [ -z "$missing_workflows" ] && pass "SDLC + demo workflow templates seeded (8/8)" \
    || fail "missing workflow seed(s): $(printf '%s' "$missing_workflows" | paste -sd ', ' -)" "$wg_seed_fix"

  missing_routes=$(psql_rows workgraph "with expected(id, work_item, type_key) as (values
    ('34000000-0000-0000-0000-000000000001', 'feature', 'SDLC'),
    ('34000000-0000-0000-0000-000000000002', 'bug', 'BUGFIX'),
    ('34000000-0000-0000-0000-0000000000a0', 'feature', 'SDLC'),
    ('3b400000-0000-0000-0000-0000000000c0', 'feature', 'SDLC')
  )
  select e.id
  from expected e
  left join work_item_routing_policies p
    on p.id=e.id and p.\"workItemTypeKey\"=e.work_item and p.\"workflowTypeKey\"=e.type_key and p.\"isActive\"=true
  left join workflow_templates w on w.id=p.\"workflowId\" and w.profile='main'
  where p.id is null or w.id is null
  order by e.id")
  [ -z "$missing_routes" ] && pass "work-item routing policies point at runnable main workflows" \
    || fail "missing/unrunnable routing policy seed(s): $(printf '%s' "$missing_routes" | paste -sd ', ' -)" "$wg_seed_fix"

  missing_defs=$(psql_rows workgraph "select w.name
  from workflow_templates w
  join workflow_design_nodes n on n.\"workflowId\"=w.id and n.\"nodeType\"='WORKBENCH_TASK'
  where w.name in ('SDLC — Capability Implementation (Workbench)', 'Bug Fix (Workbench)', 'SDLC implementation loop')
    and not exists (select 1 from workbench_definitions d where d.\"workflowNodeId\"=n.id)
  order by w.name")
  [ -z "$missing_defs" ] && pass "workbench workflow definitions linked to WORKBENCH_TASK nodes" \
    || fail "missing WorkbenchDefinition row(s): $(printf '%s' "$missing_defs" | paste -sd ', ' -)" "$wg_seed_fix"

  missing_parents=$(psql_rows workgraph "select wb.name
  from workflow_templates wb
  where wb.profile='workbench' and wb.\"archivedAt\" is null
    and not exists (
      select 1
      from workflow_design_nodes call
      join workflow_templates parent on parent.id=call.\"workflowId\" and parent.profile='main' and parent.\"archivedAt\" is null
      where call.\"nodeType\"='CALL_WORKFLOW'
        and (
          call.config #>> '{workflowId}' = wb.id
          or call.config #>> '{templateId}' = wb.id
          or call.config #>> '{standard,templateId}' = wb.id
        )
    )
  order by wb.name")
  [ -z "$missing_parents" ] && pass "workbench workflows have main-profile parent entry points" \
    || fail "workbench workflow(s) without a main parent: $(printf '%s' "$missing_parents" | paste -sd ', ' -)" "$wg_seed_fix"

  orphan_defs=$(psql_q workgraph "select count(*)
  from workbench_definitions d
  where not exists (select 1 from workflow_design_nodes dn where dn.id=d.\"workflowNodeId\")
    and not exists (select 1 from workflow_nodes rn where rn.id=d.\"workflowNodeId\")")
  [ "${orphan_defs:-0}" -eq 0 ] && pass "no orphan WorkbenchDefinition rows" \
    || fail "orphan WorkbenchDefinition rows ($orphan_defs)" "$wg_seed_fix"

  d=$(psql_q workgraph "select count(*) from workflow_templates")
  [ "${d:-0}" -ge 8 ] && pass "workflow catalog populated ($d total)" || warn "few workflows ($d)" "$wg_seed_fix"
else fail "cannot reach DB 'workgraph'" "Postgres / creds"; fi

if db_up audit_governance; then
  c=$(psql_q audit_governance "select count(*) from information_schema.columns where column_name='risk_level'")
  [ "${c:-0}" -ge 1 ] && pass "audit risk_level column" || fail "audit risk_level missing (migrations not applied)" "$seed_apply"
else fail "cannot reach DB 'audit_governance'" "Postgres / creds"; fi

# ── 4. Auth ──────────────────────────────────────────────────────────────────
section "4. Auth"
login_payload=$(python3 - <<'PY'
import json
from pathlib import Path

try:
    identity = json.loads(Path(".singularity/config.local.json").read_text()).get("identity", {})
except Exception:
    identity = {}
print(json.dumps({
    "email": identity.get("bootstrapEmail") or "admin@singularity.local",
    "password": identity.get("bootstrapPassword") or "Admin1234!",
}))
PY
)
login_email=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["email"])' <<< "$login_payload")
tok=$(http_post_json http://localhost:8100/api/v1/auth/local/login "$login_payload" 6 \
  | python3 -c 'import sys,json;print(json.load(sys.stdin).get("access_token",""))' 2>/dev/null)
[ -n "$tok" ] && pass "IAM local login works ($login_email)" \
  || fail "IAM local login failed" "is IAM (:8100) up? check .singularity/config.local.json and logs/iam-service.log"

# ── 5. LLM (gateway → provider actually callable) ────────────────────────────
section "5. LLM"
if [ -n "$BOX_ONLY" ]; then
  warn "gateway completion skipped" "BOX_ONLY=1: verify the laptop/remote gateway from that runtime host"
elif [ "$(http_code http://localhost:8001/health)" = "000" ]; then
  warn "gateway completion skipped" "llm-gateway is optional/remote-capable and is not running locally"
else
  model_alias="${LLM_PROBE_MODEL_ALIAS:-}"
  if [ -z "$model_alias" ]; then
    model_alias=$(python3 - <<'PY'
import json
from pathlib import Path

root = Path(".")
for env_path in [root / ".env", root / "mcp-server/.env", root / "agent-and-tools/.env"]:
    if not env_path.exists():
        continue
    for raw in env_path.read_text().splitlines():
        if not raw.strip() or raw.lstrip().startswith("#") or "=" not in raw:
            continue
        key, value = raw.split("=", 1)
        key = key.strip().removeprefix("export ").strip()
        value = value.strip().strip("\"'")
        if key in {"MCP_LLM_MODEL", "LLM_MODEL"} and value:
            print(value)
            raise SystemExit(0)

for model_path in [root / ".singularity/mcp-models.json", root / ".singularity/llm-models.json"]:
    if not model_path.exists():
        continue
    try:
        rows = json.loads(model_path.read_text())
    except Exception:
        continue
    if isinstance(rows, list):
        default = next((row for row in rows if isinstance(row, dict) and row.get("default")), None)
        if default and default.get("id"):
            print(default["id"])
            raise SystemExit(0)
        first = next((row for row in rows if isinstance(row, dict) and row.get("id")), None)
        if first:
            print(first["id"])
            raise SystemExit(0)

print("mock-fast")
PY
)
  fi
  llm_payload=$(MODEL_ALIAS="$model_alias" python3 - <<'PY'
import json
import os
print(json.dumps({
    "model_alias": os.environ.get("MODEL_ALIAS", "mock-fast"),
    "messages": [{"role": "user", "content": "ping"}],
    "max_output_tokens": 5,
}))
PY
)
  llm=$(http_post_json http://localhost:8001/v1/chat/completions "$llm_payload" 30)
  if echo "$llm" | grep -q 'model_not_supported\|not supported'; then
    fail "gateway model not callable: $model_alias" \
      "set LLM_PROBE_MODEL_ALIAS to a working alias or update .env/.singularity/llm-models.json, then restart the gateway"
  elif echo "$llm" | grep -qE '"content"'; then
    pass "gateway completion works (model: $(printf '%s' "$llm" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("model","?"))' 2>/dev/null))"
  else
    warn "gateway LLM check inconclusive" "$(printf '%s' "$llm" | head -c 140)"
  fi
fi

# ── summary ──────────────────────────────────────────────────────────────────
printf "\n${C_B}Summary${C_E}  ${C_G}%d ok${C_E}  ${C_Y}%d warn${C_E}  ${C_R}%d fail${C_E}\n" "$PASS" "$WARN" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  printf "Run the ${C_R}↳${C_E} commands above, or ${C_B}bin/doctor.sh --fix${C_E} for env keys, then re-run.\n"
  exit 1
fi
printf "${C_G}All preflight checks passed.${C_E}\n"
