#!/usr/bin/env bash
# Bare-metal launcher — runs the Singularity demo path against a single
# Postgres instance, no Docker.
#
# Usage:
#   bin/bare-metal.sh up   <db_user> [db_password] [db_host] [db_port]
#   bin/bare-metal.sh down
#   bin/bare-metal.sh smoke
#   bin/bare-metal.sh status
#   bin/bare-metal.sh logs <service>
#
# Defaults (when args/env unset):
#   db_password : value of $PGPASSWORD env, else 'postgres'
#   db_host     : 'localhost'
#   db_port     : '5432'
#
# Skips on purpose: llm-gateway, context-memory, metrics-ledger, MinIO,
# portal, user-and-capability. The demo path (IAM login → Agent Studio →
# workflow designer/runtime → insights → audit) only needs the services this
# script boots.

set -e

# ── Paths ──────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

LOG_DIR="$ROOT/logs"
PID_FILE="$ROOT/.pids"
ENV_FILE="$ROOT/.env.local"

# ── Colours + helpers ──────────────────────────────────────────────────────
C_BLUE=$'\033[1;34m'; C_GREEN=$'\033[1;32m'; C_YELLOW=$'\033[1;33m'
C_RED=$'\033[1;31m';  C_DIM=$'\033[2m';      C_END=$'\033[0m'
info()  { echo -e "${C_BLUE}▸${C_END} $*"; }
ok()    { echo -e "${C_GREEN}✓${C_END} $*"; }
warn()  { echo -e "${C_YELLOW}⚠${C_END} $*"; }
err()   { echo -e "${C_RED}✗${C_END} $*" >&2; }
dim()   { echo -e "${C_DIM}$*${C_END}"; }

require() {
  command -v "$1" >/dev/null 2>&1 || { err "missing binary: $1"; exit 1; }
}

wait_http() {
  local name="$1"
  local url="$2"
  local tries="${3:-30}"
  local code
  for _ in $(seq 1 "$tries"); do
    code=$(curl -s -o /dev/null -w "%{http_code}" "$url" --max-time 2 || true)
    if [ "$code" = "200" ] || [ "$code" = "204" ]; then
      ok "$name is ready"
      return 0
    fi
    sleep 1
  done
  err "$name did not become ready at $url"
  return 1
}

# ── Subcommands ────────────────────────────────────────────────────────────

cmd_up() {
  local db_user="${1:?usage: $0 up <db_user> [db_password] [db_host] [db_port]}"
  local db_pass="${2:-${PGPASSWORD:-postgres}}"
  local db_host="${3:-localhost}"
  local db_port="${4:-5432}"

  require psql
  require node
  require npm
  require python3
  command -v pnpm >/dev/null 2>&1 || warn "pnpm not found — workgraph install will fail; install with 'npm i -g pnpm'"

  info "using Postgres at ${db_user}@${db_host}:${db_port}"

  # ── 1. Create databases + extensions ────────────────────────────────────
  info "creating databases (idempotent)…"
  PGPASSWORD="$db_pass" psql -h "$db_host" -p "$db_port" -U "$db_user" -d postgres <<SQL 2>&1 | grep -vE "already exists|NOTICE" || true
SELECT 'CREATE DATABASE singularity'          WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname='singularity')\gexec
SELECT 'CREATE DATABASE singularity_composer' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname='singularity_composer')\gexec
SELECT 'CREATE DATABASE workgraph'            WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname='workgraph')\gexec
SELECT 'CREATE DATABASE audit_governance'     WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname='audit_governance')\gexec
SELECT 'CREATE DATABASE singularity_iam'      WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname='singularity_iam')\gexec
SQL

  info "enabling pgvector + pgcrypto in 'singularity' (agent-runtime + tool-service)…"
  PGPASSWORD="$db_pass" psql -h "$db_host" -p "$db_port" -U "$db_user" -d singularity \
    -c "CREATE EXTENSION IF NOT EXISTS vector;" \
    -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;" 2>&1 | grep -vE "NOTICE" || \
    { err "Failed to install pgvector. Install it on your Postgres (e.g. 'brew install pgvector') and retry."; exit 1; }

  # M30 — prompt-composer's own DB. Decoupled from agent-runtime so
  # cross-service prisma db push fights are structurally impossible.
  info "enabling pgvector + pgcrypto in 'singularity_composer' (prompt-composer)…"
  PGPASSWORD="$db_pass" psql -h "$db_host" -p "$db_port" -U "$db_user" -d singularity_composer \
    -c "CREATE EXTENSION IF NOT EXISTS vector;" \
    -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;" 2>&1 | grep -vE "NOTICE" || \
    { err "Failed to install pgvector on singularity_composer."; exit 1; }

  info "enabling pgcrypto in 'singularity_iam'…"
  PGPASSWORD="$db_pass" psql -h "$db_host" -p "$db_port" -U "$db_user" -d singularity_iam \
    -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;" 2>&1 | grep -vE "NOTICE" || true

  info "enabling pgcrypto in 'audit_governance'…"
  PGPASSWORD="$db_pass" psql -h "$db_host" -p "$db_port" -U "$db_user" -d audit_governance \
    -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;" 2>&1 | grep -vE "NOTICE" || true

  info "applying audit-governance schema…"
  PGPASSWORD="$db_pass" psql -h "$db_host" -p "$db_port" -U "$db_user" -d audit_governance \
    -f audit-governance-service/db/init.sql >/dev/null 2>&1 || \
    warn "audit_governance schema may already exist — continuing"

  # ── 2. Write env file ────────────────────────────────────────────────────
  cat > "$ENV_FILE" <<EOF
# Auto-generated by bin/bare-metal.sh — re-run 'up' to refresh.
export PG_HOST="$db_host"
export PG_PORT="$db_port"
export PG_USER="$db_user"
export PG_PASS="$db_pass"

export DATABASE_URL_AGENT_TOOLS="postgresql://${db_user}:${db_pass}@${db_host}:${db_port}/singularity"
# M30 — composer owns this DB; agent-runtime data is read via DATABASE_URL_RUNTIME_READ (= AGENT_TOOLS)
export DATABASE_URL_COMPOSER="postgresql://${db_user}:${db_pass}@${db_host}:${db_port}/singularity_composer"
export DATABASE_URL_RUNTIME_READ="$DATABASE_URL_AGENT_TOOLS"
export DATABASE_URL_WORKGRAPH="postgresql://${db_user}:${db_pass}@${db_host}:${db_port}/workgraph"
export DATABASE_URL_AUDIT_GOV="postgresql://${db_user}:${db_pass}@${db_host}:${db_port}/audit_governance"

export JWT_SECRET="dev-secret-change-in-prod-min-32-chars!!"
export AUTH_PROVIDER="iam"
export IAM_BASE_URL="http://localhost:8100/api/v1"
export IAM_SERVICE_URL="http://localhost:8100"

export AUDIT_GOV_URL="http://localhost:8500"
export PROMPT_COMPOSER_URL="http://localhost:3004"
export AGENT_RUNTIME_URL="http://localhost:3003"
export TOOL_SERVICE_URL="http://localhost:3002"
export AGENT_SERVICE_URL="http://localhost:3001"
export CONTEXT_FABRIC_URL="http://localhost:8000"
export MCP_SERVER_URL="http://localhost:7100"
export MCP_BEARER_TOKEN="demo-bearer-token-must-be-min-16-chars"

export LLM_PROVIDER="mock"
export LLM_MODEL="mock-fast"
EOF
  ok "wrote env to ${ENV_FILE}"
  # shellcheck source=/dev/null
  . "$ENV_FILE"

  # ── 3. Install dependencies (only if missing) ────────────────────────────
  ensure_install() {
    local dir="$1"
    local mgr="${2:-npm}"
    if [ ! -d "$dir/node_modules" ]; then
      info "installing $dir via $mgr…"
      ( cd "$dir" && $mgr install >/dev/null 2>&1 ) || { err "$mgr install failed in $dir"; exit 1; }
    fi
  }
  ensure_install agent-and-tools          npm
  ensure_install agent-and-tools/web      npm
  ensure_install workgraph-studio         pnpm
  ensure_install audit-governance-service npm
  ensure_install mcp-server               npm

  # ── 4. Push schemas + seed ────────────────────────────────────────────────
  info "applying agent-runtime schema…"
  ( cd agent-and-tools/apps/agent-runtime \
    && DATABASE_URL="$DATABASE_URL_AGENT_TOOLS" npx prisma db push --skip-generate >/dev/null 2>&1 \
    && DATABASE_URL="$DATABASE_URL_AGENT_TOOLS" npx prisma generate >/dev/null 2>&1 ) \
    || warn "agent-runtime schema push had warnings"

  # M30 — composer's OWNED tables live on `singularity_composer`. Push
  # composer's schema against that DB. The runtime-reader client only needs
  # `prisma generate` (no DDL on agent-runtime's DB).
  info "applying prompt-composer schema (DB: singularity_composer)…"
  ( cd agent-and-tools/apps/prompt-composer \
    && DATABASE_URL="$DATABASE_URL_COMPOSER" npx prisma db push --schema=prisma/schema.prisma --skip-generate >/dev/null 2>&1 \
    && DATABASE_URL="$DATABASE_URL_COMPOSER" npx prisma generate --schema=prisma/schema.prisma >/dev/null 2>&1 ) \
    || warn "prompt-composer owned schema push had warnings"

  info "generating composer's runtime-reader client (read-only against singularity)…"
  ( cd agent-and-tools/apps/prompt-composer \
    && DATABASE_URL_RUNTIME_READ="$DATABASE_URL_RUNTIME_READ" npx prisma generate --schema=prisma/runtime-read.prisma >/dev/null 2>&1 ) \
    || warn "prompt-composer runtime-reader generate had warnings"

  info "applying workgraph-api schema…"
  ( cd workgraph-studio/apps/api \
    && DATABASE_URL="$DATABASE_URL_WORKGRAPH" npx prisma db push --skip-generate >/dev/null 2>&1 \
    && DATABASE_URL="$DATABASE_URL_WORKGRAPH" npx prisma generate >/dev/null 2>&1 ) \
    || warn "workgraph schema push had warnings"

  # ── 5. Python deps (best-effort) ──────────────────────────────────────────
  if command -v pip >/dev/null 2>&1; then
    info "checking python deps for IAM…"
    python3 -c "import fastapi, uvicorn, sqlalchemy, asyncpg, jwt" 2>/dev/null || \
      python3 -m pip install --quiet -e singularity-iam-service || \
        warn "pip install failed — iam-service may not start"

    info "checking python deps for context-api…"
    python3 -c "import fastapi, uvicorn, httpx" 2>/dev/null || \
      python3 -m pip install --quiet fastapi uvicorn httpx pydantic-settings \
                          "python-jose[cryptography]" sqlalchemy aiosqlite \
        || warn "pip install failed — context-api may not start"
  else
    warn "pip not found — Python services will only work if deps are already installed"
  fi

  # ── 6. Boot ───────────────────────────────────────────────────────────────
  mkdir -p "$LOG_DIR"
  : > "$PID_FILE"

  boot() {
    local name="$1"; shift
    local cmd="$*"
    ( bash -c "$cmd" >> "$LOG_DIR/${name}.log" 2>&1 & echo $! >> "$PID_FILE" )
    sleep 0.3
    local pid
    pid=$(tail -n 1 "$PID_FILE")
    ok "${name} (PID ${pid})  → tail -f logs/${name}.log"
  }

  info "booting services…"
  boot iam-service      "cd singularity-iam-service  && DATABASE_URL=\"postgresql+asyncpg://${db_user}:${db_pass}@${db_host}:${db_port}/singularity_iam\" JWT_SECRET=\"$JWT_SECRET\" JWT_EXPIRE_MINUTES=720 LOCAL_SUPER_ADMIN_EMAIL=admin@singularity.local LOCAL_SUPER_ADMIN_PASSWORD=Admin1234! CORS_ORIGINS='[\"http://localhost:3000\",\"http://localhost:5174\",\"http://localhost:5175\",\"http://localhost:5176\",\"http://localhost:5180\"]' python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8100"
  wait_http iam-service "http://localhost:8100/api/v1/health" 45

  info "applying SQL seed data…"
  ( "$ROOT/seed/apply.sh" "$db_user" "$db_pass" "$db_host" "$db_port" >/dev/null 2>&1 ) \
    || warn "seed/apply.sh had warnings — run it manually: seed/apply.sh $db_user"

  boot audit-gov        "cd audit-governance-service  && DATABASE_URL=\"$DATABASE_URL_AUDIT_GOV\" PORT=8500 npm run dev"
  sleep 2

  boot agent-service    "cd agent-and-tools/apps/agent-service   && PORT=3001 DATABASE_URL=\"$DATABASE_URL_AGENT_TOOLS\" IAM_SERVICE_URL=\"$IAM_SERVICE_URL\" AUDIT_GOV_URL=\"$AUDIT_GOV_URL\" JWT_SECRET=\"$JWT_SECRET\" npm run dev"
  boot tool-service     "cd agent-and-tools/apps/tool-service    && PORT=3002 DATABASE_URL=\"$DATABASE_URL_AGENT_TOOLS\" IAM_SERVICE_URL=\"$IAM_SERVICE_URL\" AUDIT_GOV_URL=\"$AUDIT_GOV_URL\" JWT_SECRET=\"$JWT_SECRET\" npm run dev"
  boot agent-runtime    "cd agent-and-tools/apps/agent-runtime   && PORT=3003 DATABASE_URL=\"$DATABASE_URL_AGENT_TOOLS\" IAM_SERVICE_URL=\"$IAM_SERVICE_URL\" AUDIT_GOV_URL=\"$AUDIT_GOV_URL\" JWT_SECRET=\"$JWT_SECRET\" npm run dev"
  boot prompt-composer  "cd agent-and-tools/apps/prompt-composer && PORT=3004 DATABASE_URL=\"$DATABASE_URL_COMPOSER\" DATABASE_URL_RUNTIME_READ=\"$DATABASE_URL_RUNTIME_READ\" AUDIT_GOV_URL=\"$AUDIT_GOV_URL\" JWT_SECRET=\"$JWT_SECRET\" npm run dev"

  boot mcp-server       "cd mcp-server && PORT=7100 MCP_BEARER_TOKEN=\"$MCP_BEARER_TOKEN\" LLM_PROVIDER=mock LLM_MODEL=mock-fast AUDIT_GOV_URL=\"$AUDIT_GOV_URL\" npm run dev"
  boot context-api      "cd context-fabric/services/context_api_service && DATABASE_URL=\"$DATABASE_URL_AUDIT_GOV\" PORT=8000 IAM_BASE_URL=\"$IAM_BASE_URL\" AUDIT_GOV_URL=\"$AUDIT_GOV_URL\" MCP_SERVER_URL=\"$MCP_SERVER_URL\" MCP_BEARER_TOKEN=\"$MCP_BEARER_TOKEN\" python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8000"
  sleep 3

  boot workgraph-api    "cd workgraph-studio/apps/api && PORT=8080 DATABASE_URL=\"$DATABASE_URL_WORKGRAPH\" JWT_SECRET=\"$JWT_SECRET\" AUTH_PROVIDER=iam IAM_BASE_URL=\"$IAM_BASE_URL\" AGENT_RUNTIME_URL=\"$AGENT_RUNTIME_URL\" TOOL_SERVICE_URL=\"$TOOL_SERVICE_URL\" AGENT_SERVICE_URL=\"$AGENT_SERVICE_URL\" PROMPT_COMPOSER_URL=\"$PROMPT_COMPOSER_URL\" CONTEXT_FABRIC_URL=\"$CONTEXT_FABRIC_URL\" AUDIT_GOV_URL=\"$AUDIT_GOV_URL\" npm run dev"

  # PORT=3000 forces Next.js to fail loudly on a port collision rather than
  # silently auto-bumping to 3001 (which would dodge the SPA proxy rewrites).
  boot agent-web        "cd agent-and-tools/web        && PORT=3000 IAM_BASE_URL=\"$IAM_BASE_URL\" AUDIT_GOV_URL=\"$AUDIT_GOV_URL\" AGENT_RUNTIME_URL=\"$AGENT_RUNTIME_URL\" TOOL_SERVICE_URL=\"$TOOL_SERVICE_URL\" AGENT_SERVICE_URL=\"$AGENT_SERVICE_URL\" PROMPT_COMPOSER_URL=\"$PROMPT_COMPOSER_URL\" npm run dev"
  boot workgraph-web    "cd workgraph-studio/apps/web  && VITE_API_BASE=http://localhost:8080 VITE_IAM_BASE_URL=\"$IAM_BASE_URL\" VITE_IAM_LOGIN_URL=http://localhost:5175/login VITE_AUTO_LOGIN=0 npm run dev -- --host 0.0.0.0 --port 5174"
  boot blueprint-workbench "cd workgraph-studio/apps/blueprint-workbench && npm run dev -- --host 0.0.0.0 --port 5176"

  echo
  ok "all services booted — run '$0 smoke' in ~30s to verify, then open:"
  echo "    http://localhost:5174    (workgraph: runs, insights, designer)"
  echo "    http://localhost:5176    (blueprint workbench: staged agent loop)"
  echo "    http://localhost:3000    (agent-web: Agent Studio, /audit, /cost)"
  echo "    http://localhost:8100    (real IAM API; admin@singularity.local / Admin1234!)"
  echo
  dim "stop everything:   $0 down"
  dim "tail any service:  tail -f logs/<name>.log"
}

cmd_down() {
  if [ ! -f "$PID_FILE" ]; then
    warn "no $PID_FILE found — nothing to stop"
    return 0
  fi
  info "stopping services…"
  while read -r pid; do
    [ -z "$pid" ] && continue
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null && dim "  killed $pid"
    fi
  done < "$PID_FILE"
  # Hard sweep — anything still hogging our ports gets terminated.
  for p in 3000 3001 3002 3003 3004 5174 5176 7100 8000 8080 8100 8101 8500; do
    pids=$(lsof -ti :"$p" 2>/dev/null || true)
    [ -n "$pids" ] && kill $pids 2>/dev/null && dim "  freed port $p"
  done
  rm -f "$PID_FILE"
  ok "stack down."
}

cmd_smoke() {
  local fail=0
  for url in \
    "http://localhost:8100/api/v1/health" \
    "http://localhost:8500/health" \
    "http://localhost:7100/health" \
    "http://localhost:8000/health" \
    "http://localhost:8080/health" \
    "http://localhost:3000/api/runtime/agents/templates?scope=common&limit=3" \
    "http://localhost:5174/" \
    "http://localhost:5176/" \
  ; do
    code=$(curl -s -o /dev/null -w "%{http_code}" "$url" --max-time 3)
    if [ "$code" = "200" ] || [ "$code" = "304" ]; then
      printf "  ${C_GREEN}%s${C_END}  %s\n" "$code" "$url"
    else
      printf "  ${C_RED}%s${C_END}  %s\n" "$code" "$url"
      fail=$((fail + 1))
    fi
  done
  echo
  if [ "$fail" = "0" ]; then ok "all healthy."; else err "$fail endpoint(s) failing — check logs/"; exit 1; fi
}

cmd_status() {
  if [ ! -f "$PID_FILE" ]; then
    warn "no PIDs recorded; run '$0 up <db_user>'"
    return 0
  fi
  printf "%-18s %-8s %s\n" "SERVICE" "PID" "STATE"
  while read -r pid; do
    [ -z "$pid" ] && continue
    if kill -0 "$pid" 2>/dev/null; then state="${C_GREEN}running${C_END}"; else state="${C_RED}exited${C_END}"; fi
    cmd=$(ps -p "$pid" -o command= 2>/dev/null | head -c 80)
    printf "%-18s %-8s %b\n" "$(basename "$(echo "$cmd" | awk '{print $NF}')" .ts)" "$pid" "$state"
  done < "$PID_FILE"
}

cmd_logs() {
  local svc="${1:?usage: $0 logs <service> — try one of: $(ls "$LOG_DIR" 2>/dev/null | sed 's/.log//' | tr '\n' ' ')}"
  tail -f "$LOG_DIR/${svc}.log"
}

# ── Dispatch ───────────────────────────────────────────────────────────────
cmd="${1:-help}"
shift || true
case "$cmd" in
  up)     cmd_up "$@" ;;
  down)   cmd_down ;;
  smoke)  cmd_smoke ;;
  status) cmd_status ;;
  logs)   cmd_logs "$@" ;;
  *)
    cat <<USAGE
Singularity bare-metal launcher.

  $0 up <db_user> [db_password] [db_host] [db_port]
                            create DBs, install deps, push schemas, seed,
                            boot all services. Idempotent.

  $0 smoke                  curl every /health endpoint — green when healthy.
  $0 status                 list running PIDs.
  $0 logs <service>         tail one service's log (e.g. workgraph-api).
  $0 down                   kill every booted process + free our ports.

Defaults: db_password from \$PGPASSWORD env (else 'postgres'),
          db_host=localhost, db_port=5432.
USAGE
    exit 1
    ;;
esac
