#!/usr/bin/env bash
# bin/doctor.sh — bare-metal preflight doctor.
#
# One pass over the known bare-metal gap classes so you see ALL remaining issues
# at once instead of discovering them one click at a time:
#   1. Services      — every port up + responding
#   2. Cross-app env — the .env.local keys that make split-origin links/auth work
#   3. Seeds         — baseline agent templates, demo users, SDLC + demo workflows,
#                      audit risk_level column
#   4. Auth          — IAM local login works (what every app's session depends on)
#
# Each failure prints a remediation hint. `--fix` applies the SAFE ones
# (append missing .env.local keys). Seed/service fixes are printed, not run.
#
#   bin/doctor.sh           # report
#   bin/doctor.sh --fix     # report + append any missing .env.local keys
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT"
FIX=0; [ "${1:-}" = "--fix" ] && FIX=1

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

http_code(){ curl -s -o /dev/null -w "%{http_code}" --max-time 4 "$1" 2>/dev/null || echo 000; }
psql_q(){ psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$1" -tAc "$2" 2>/dev/null | tr -d '[:space:]'; }
db_up(){ psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$1" -tAc 'select 1' >/dev/null 2>&1; }

printf "${C_B}Singularity bare-metal doctor${C_E}  (pg=%s@%s:%s, fix=%s)\n" "$PG_USER" "$PG_HOST" "$PG_PORT" "$FIX"

# ── 1. Services ──────────────────────────────────────────────────────────────
section "1. Services"
for s in \
  "IAM|http://localhost:8100/api/v1/health" \
  "workgraph-api|http://localhost:8080/health" \
  "agent-runtime|http://localhost:3003/health" \
  "context-fabric|http://localhost:8000/health" \
  "llm-gateway|http://localhost:8001/health" \
  "mcp-server|http://localhost:7100/health" \
  "audit-gov|http://localhost:8500/health" \
  "agent-web|http://localhost:3000/" \
  "workgraph-web|http://localhost:5174/" \
  "iam-admin|http://localhost:5175/" \
  "blueprint-workbench|http://localhost:5176/" \
  "portal|http://localhost:5180/"; do
  name="${s%%|*}"; url="${s##*|}"; code=$(http_code "$url")
  if [ "$code" = "000" ]; then fail "$name down ($url)" "start: bin/setup.sh --yes   ·   logs: bin/bare-metal.sh logs $name"
  else pass "$name up ($code)"; fi
done

# ── 2. Cross-app env (.env.local) ────────────────────────────────────────────
section "2. Cross-app env (.env.local)"
ensure_kv(){ # relpath  KEY=VALUE
  local rel="$1" kv="$2" key="${2%%=*}" f="$ROOT/$1"
  if [ -f "$f" ] && grep -q "^${key}=" "$f"; then pass "$rel · $key"
  elif [ "$FIX" = "1" ]; then mkdir -p "$(dirname "$f")"; printf '%s\n' "$kv" >> "$f"; pass "$rel · $key ${C_Y}(added)${C_E}"
  else fail "$rel missing $key" "echo '$kv' >> $rel   (or re-run bin/setup.sh)"; fi
}
for app in singularity-portal UserAndCapabillity workgraph-studio/apps/web workgraph-studio/apps/blueprint-workbench; do
  ensure_kv "$app/.env.local" "VITE_IAM_BASE_URL=http://localhost:8100/api/v1"
  ensure_kv "$app/.env.local" "VITE_BLUEPRINT_WORKBENCH_URL=http://localhost:5176"
  ensure_kv "$app/.env.local" "VITE_LINK_BLUEPRINT_WORKBENCH=http://localhost:5176"
  ensure_kv "$app/.env.local" "VITE_LINK_OPERATIONS_PORTAL=http://localhost:5180/operations"
  ensure_kv "$app/.env.local" "VITE_LINK_IAM_ADMIN=http://localhost:5175"
done
ensure_kv "workgraph-studio/apps/blueprint-workbench/.env.local" "VITE_PSEUDO_IAM_LOGIN_URL=http://localhost:8100/api/v1/auth/local/login"
ensure_kv "agent-and-tools/web/.env.local" "NEXT_PUBLIC_LINK_WORKGRAPH_DESIGNER=http://localhost:5174"
ensure_kv "agent-and-tools/web/.env.local" "NEXT_PUBLIC_LINK_BLUEPRINT_WORKBENCH=http://localhost:5176"
ensure_kv "agent-and-tools/web/.env.local" "NEXT_PUBLIC_LINK_IAM_ADMIN=http://localhost:5175"
[ "$FIX" = "1" ] && warn "env keys were appended" "restart the affected dev servers (Vite reads .env.local only at startup): bin/bare-metal.sh down && bin/setup.sh --yes"

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
  n=$(psql_q workgraph "select count(*) from workflow_templates where name='SDLC Delivery'")
  [ "${n:-0}" -ge 1 ] && pass "SDLC Delivery workflow" \
    || fail "SDLC Delivery workflow missing" "(cd workgraph-studio/apps/api && SEED_CAPABILITY_ID=11111111-2222-3333-4444-555555555555 SEED_TEAM_ID=50000000-0000-0000-0000-000000000001 DATABASE_URL=$wg_url npx ts-node --transpile-only prisma/seed-sdlc-workbench.ts && SEED_CAPABILITY_ID=11111111-2222-3333-4444-555555555555 SEED_TEAM_ID=50000000-0000-0000-0000-000000000001 DATABASE_URL=$wg_url npx ts-node --transpile-only prisma/seed-sdlc-main.ts)"
  d=$(psql_q workgraph "select count(*) from workflow_templates")
  [ "${d:-0}" -ge 4 ] && pass "demo workflows present ($d total)" || warn "few workflows ($d)" "(cd workgraph-studio/apps/api && DATABASE_URL=$wg_url npm run prisma:seed)"
else fail "cannot reach DB 'workgraph'" "Postgres / creds"; fi

if db_up audit_governance; then
  c=$(psql_q audit_governance "select count(*) from information_schema.columns where column_name='risk_level'")
  [ "${c:-0}" -ge 1 ] && pass "audit risk_level column" || fail "audit risk_level missing (migrations not applied)" "$seed_apply"
else fail "cannot reach DB 'audit_governance'" "Postgres / creds"; fi

# ── 4. Auth ──────────────────────────────────────────────────────────────────
section "4. Auth"
tok=$(curl -s --max-time 6 -X POST http://localhost:8100/api/v1/auth/local/login \
  -H 'content-type: application/json' \
  -d '{"email":"admin@singularity.local","password":"Admin1234!"}' 2>/dev/null \
  | python3 -c 'import sys,json;print(json.load(sys.stdin).get("access_token",""))' 2>/dev/null)
[ -n "$tok" ] && pass "IAM local login works (admin)" \
  || fail "IAM local login failed" "is IAM (:8100) up? admin@singularity.local / Admin1234! — check logs/iam-service.log"

# ── summary ──────────────────────────────────────────────────────────────────
printf "\n${C_B}Summary${C_E}  ${C_G}%d ok${C_E}  ${C_Y}%d warn${C_E}  ${C_R}%d fail${C_E}\n" "$PASS" "$WARN" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  printf "Run the ${C_R}↳${C_E} commands above, or ${C_B}bin/doctor.sh --fix${C_E} for env keys, then re-run.\n"
  exit 1
fi
printf "${C_G}All preflight checks passed.${C_E}\n"
