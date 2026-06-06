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
# Boots: iam, audit-gov, llm-gateway, agent/tool/runtime/composer, mcp-server,
# context-api, context-memory, formal-verifier, workgraph-api, agent-web,
# workgraph-web, blueprint-workbench, user-and-capability.
# Skips on purpose: metrics-ledger (M65: sunset in the singularity stack —
# savings analytics moved to audit-gov :8500), MinIO, portal.
#
# Context Fabric stores run on Postgres (DB: singularity_context_fabric) to
# match the Docker stack — see CONTEXT_FABRIC_DATABASE_URL below. The legacy
# SQLite fallback under context-fabric/data/ is no longer used by this script.

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

  # ── 0. Free our app ports FIRST ──────────────────────────────────────────
  # Kill any stale listeners on our service ports (a prior 'up' not 'down'ed, a
  # duplicate/Docker stack, or a hung dev server) so nothing later fails with
  # EADDRINUSE — and so killing services releases their DB connections before we
  # touch the databases. Storage ports (5432/5434/9000/9001) are EXCLUDED on
  # purpose: those are your Postgres/MinIO, not ours to kill.
  info "freeing our service ports…"
  for _p in 3000 3001 3002 3003 3004 5174 5175 5176 5180 7100 8000 8001 8002 8003 8010 8080 8100 8101 8500; do
    _pids=$(lsof -ti tcp:"$_p" -sTCP:LISTEN 2>/dev/null || true)
    if [ -n "$_pids" ]; then kill $_pids 2>/dev/null || true; sleep 0.2; kill -9 $_pids 2>/dev/null || true; fi
  done

  info "using Postgres at ${db_user}@${db_host}:${db_port}"

  # ── 1. Create databases + extensions ────────────────────────────────────
  info "creating databases (idempotent)…"
  PGPASSWORD="$db_pass" psql -h "$db_host" -p "$db_port" -U "$db_user" -d postgres <<SQL 2>&1 | grep -vE "already exists|NOTICE" || true
SELECT 'CREATE DATABASE singularity'          WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname='singularity')\gexec
SELECT 'CREATE DATABASE singularity_composer' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname='singularity_composer')\gexec
SELECT 'CREATE DATABASE workgraph'            WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname='workgraph')\gexec
SELECT 'CREATE DATABASE audit_governance'     WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname='audit_governance')\gexec
SELECT 'CREATE DATABASE singularity_iam'      WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname='singularity_iam')\gexec
SELECT 'CREATE DATABASE singularity_context_fabric' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname='singularity_context_fabric')\gexec
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

  # Context Fabric shared DB — context-memory stores pgvector embeddings; the
  # context-api call_log/events_store + memory + (legacy) metrics stores live
  # here too. Matches the Docker stack's CONTEXT_FABRIC_DATABASE_URL target.
  info "enabling pgvector + pgcrypto in 'singularity_context_fabric' (context-fabric stores)…"
  PGPASSWORD="$db_pass" psql -h "$db_host" -p "$db_port" -U "$db_user" -d singularity_context_fabric \
    -c "CREATE EXTENSION IF NOT EXISTS vector;" \
    -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;" 2>&1 | grep -vE "NOTICE" || \
    { err "Failed to install pgvector on singularity_context_fabric."; exit 1; }

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
# Context Fabric stores (call_log, events_store, context_memory) — Postgres,
# matching the Docker stack. The CF services read CONTEXT_FABRIC_DATABASE_URL.
export DATABASE_URL_CONTEXT_FABRIC="postgresql://${db_user}:${db_pass}@${db_host}:${db_port}/singularity_context_fabric"
export CONTEXT_FABRIC_DATABASE_URL="$DATABASE_URL_CONTEXT_FABRIC"
# Pin EACH CF store to Postgres explicitly (highest precedence in
# resolve_database_target). This guarantees the services never fall back to the
# SQLite default (/data/*.db) — a read-only path on macOS that crashes
# context-api at init_db with "OSError: Read-only file system: '/data'". Belt-
# and-suspenders alongside the per-boot CONTEXT_FABRIC_DATABASE_URL, and it also
# covers manual runs that just `source .env.local`.
export CALL_LOG_DATABASE_URL="$DATABASE_URL_CONTEXT_FABRIC"
export EVENTS_STORE_DATABASE_URL="$DATABASE_URL_CONTEXT_FABRIC"
export CONTEXT_MEMORY_DATABASE_URL="$DATABASE_URL_CONTEXT_FABRIC"
export METRICS_LEDGER_DATABASE_URL="$DATABASE_URL_CONTEXT_FABRIC"

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
export CONTEXT_MEMORY_URL="http://localhost:8002"
export FORMAL_VERIFIER_URL="http://localhost:8010"
export MCP_SERVER_URL="http://localhost:7100"
export MCP_BEARER_TOKEN="demo-bearer-token-must-be-min-16-chars"

export LLM_GATEWAY_URL="http://localhost:8001"
export LLM_PROVIDER_CONFIG_PATH="$ROOT/.singularity/llm-providers.json"
export LLM_MODEL_CATALOG_PATH="$ROOT/.singularity/mcp-models.json"
export WORKBENCH_DEFAULT_MODEL_ALIAS="mock"
EOF
  ok "wrote env to ${ENV_FILE}"
  # shellcheck source=/dev/null
  . "$ENV_FILE"

  # ── Python venv (PEP 668 / Homebrew-safe) ─────────────────────────────────
  # Modern Python (Homebrew/3.12+) marks the system env "externally managed",
  # so a system-wide `pip install` is refused. Create a repo-local .venv and
  # put it first on PATH so every python3/uvicorn below resolves to it. Deps
  # are PINNED where fresh resolution otherwise pulls versions the platform
  # never tested against:
  #   • greenlet            — async SQLAlchemy needs it; not auto-pulled on new Pythons
  #   • bcrypt==4.0.1       — passlib 1.7.x breaks on bcrypt 4.1+/5.x ("72 bytes")
  #   • sqlalchemy[asyncio] — pulls greenlet on supported Pythons
  VENV="$ROOT/.venv"
  if [ ! -x "$VENV/bin/python" ]; then
    info "creating python venv at .venv…"
    python3 -m venv "$VENV" || { err "venv create failed at $VENV (need python3 -m venv)"; exit 1; }
  fi
  export VIRTUAL_ENV="$VENV"; export PATH="$VENV/bin:$PATH"; hash -r 2>/dev/null || true
  if ! "$VENV/bin/python" -c "import fastapi, uvicorn, psycopg, asyncpg, greenlet, bcrypt, z3" 2>/dev/null; then
    info "installing python deps into .venv (iam + context-fabric)…"
    "$VENV/bin/python" -m pip install --quiet --upgrade pip >/dev/null 2>&1 || true
    "$VENV/bin/python" -m pip install --quiet -e singularity-iam-service \
      || warn "iam-service editable install had warnings — iam-service may not start"
    # z3-solver: formal-verifier imports `z3`. Without it that service crashes.
    "$VENV/bin/python" -m pip install --quiet \
        fastapi "uvicorn[standard]" httpx pydantic pydantic-settings "python-jose[cryptography]" \
        "sqlalchemy[asyncio]" greenlet aiosqlite "psycopg[binary]" pyjwt "bcrypt==4.0.1" passlib email-validator z3-solver \
      || warn "context-fabric pip install had warnings — context services may not start"
  fi

  mkdir -p "$ROOT/.singularity"
  if [ ! -f "$ROOT/.singularity/llm-providers.json" ]; then
    cat > "$ROOT/.singularity/llm-providers.json" <<'JSON'
{
  "defaultProvider": "mock",
  "defaultModel": "mock-fast",
  "allowedProviders": ["mock"],
  "providers": {
    "mock": {
      "enabled": true,
      "defaultModel": "mock-fast",
      "supportsTools": false,
      "costTier": "mock"
    }
  }
}
JSON
  fi
  if [ ! -f "$ROOT/.singularity/mcp-models.json" ]; then
    cat > "$ROOT/.singularity/mcp-models.json" <<'JSON'
[
  {
    "id": "mock",
    "label": "Mock offline",
    "provider": "mock",
    "model": "mock-fast",
    "default": true,
    "maxOutputTokens": 800,
    "supportsTools": false,
    "costTier": "mock"
  },
  {
    "id": "mock-fast",
    "label": "Mock — fast happy path",
    "provider": "mock",
    "model": "mock-fast",
    "default": false,
    "maxOutputTokens": 4000,
    "supportsTools": true,
    "costTier": "free"
  },
  {
    "id": "mock-fail-429",
    "label": "Mock chaos — 429 rate-limited",
    "provider": "mock",
    "model": "mock-fast",
    "default": false,
    "maxOutputTokens": 4000,
    "supportsTools": true,
    "costTier": "free"
  },
  {
    "id": "mock-fail-503",
    "label": "Mock chaos — 503 unavailable",
    "provider": "mock",
    "model": "mock-fast",
    "default": false,
    "maxOutputTokens": 4000,
    "supportsTools": true,
    "costTier": "free"
  },
  {
    "id": "mock-fail-529",
    "label": "Mock chaos — 529 overloaded",
    "provider": "mock",
    "model": "mock-fast",
    "default": false,
    "maxOutputTokens": 4000,
    "supportsTools": true,
    "costTier": "free"
  },
  {
    "id": "mock-fail-529-2",
    "label": "Mock chaos — first 2 calls 529 then happy",
    "provider": "mock",
    "model": "mock-fast",
    "default": false,
    "maxOutputTokens": 4000,
    "supportsTools": true,
    "costTier": "free"
  },
  {
    "id": "mock-timeout",
    "label": "Mock chaos — sleep past UPSTREAM_TIMEOUT_SEC",
    "provider": "mock",
    "model": "mock-fast",
    "default": false,
    "maxOutputTokens": 4000,
    "supportsTools": true,
    "costTier": "free"
  }
]
JSON
  fi

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
  ensure_install UserAndCapabillity       npm
  ensure_install singularity-portal       npm

  # Build the agent-and-tools workspace libraries (@agentandtools/shared, db,
  # tool-registry). The apps import them by their package "main" (dist/index.js),
  # so they MUST be compiled before `npm run dev`, or agent/tool/composer/web all
  # crash with: Cannot find module .../@agentandtools/shared/dist/index.js.
  if [ ! -f agent-and-tools/packages/shared/dist/index.js ]; then
    info "building agent-and-tools workspace libraries…"
    ( cd agent-and-tools && npm run build --if-present \
        --workspace=packages/shared --workspace=packages/db --workspace=packages/tool-registry >/dev/null 2>&1 ) \
      || warn "agent-and-tools library build had warnings — agent/tool/composer services may not start"
  fi

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

  info "seeding prompt-composer base prompt profiles…"
  ( cd agent-and-tools/apps/prompt-composer \
    && DATABASE_URL="$DATABASE_URL_COMPOSER" npm run seed >/dev/null 2>&1 ) \
    || warn "prompt-composer seed had warnings"

  info "generating composer's runtime-reader client (read-only against singularity)…"
  ( cd agent-and-tools/apps/prompt-composer \
    && DATABASE_URL_RUNTIME_READ="$DATABASE_URL_RUNTIME_READ" npx prisma generate --schema=prisma/runtime-read.prisma >/dev/null 2>&1 ) \
    || warn "prompt-composer runtime-reader generate had warnings"

  info "applying workgraph-api schema…"
  ( cd workgraph-studio/apps/api \
    && DATABASE_URL="$DATABASE_URL_WORKGRAPH" npx prisma db push --skip-generate >/dev/null 2>&1 \
    && DATABASE_URL="$DATABASE_URL_WORKGRAPH" npx prisma generate >/dev/null 2>&1 ) \
    || warn "workgraph schema push had warnings"

  # Seed workgraph demo data — agents, the SDLC + bug-fix workbench workflows,
  # sample workflows, routing policies, and a completed blueprint session with
  # artifacts (prisma/seed.ts → seed-demo-workflows.ts). Mirrors what Docker
  # seeds; without this the designer/workbench come up empty.
  info "seeding workgraph demo workflows + artifacts…"
  ( cd workgraph-studio/apps/api \
    && DATABASE_URL="$DATABASE_URL_WORKGRAPH" npm run prisma:seed >/dev/null 2>&1 ) \
    || warn "workgraph prisma:seed had warnings — run it manually: (cd workgraph-studio/apps/api && DATABASE_URL=\"$DATABASE_URL_WORKGRAPH\" npm run prisma:seed)"

  # ── 5. Python deps ─────────────────────────────────────────────────────────
  # Installed into .venv above (PEP 668-safe). Verify the import surface is
  # present so a failure here is loud rather than a mid-boot crash.
  if ! "$VENV/bin/python" -c "import fastapi, uvicorn, sqlalchemy, asyncpg, greenlet, bcrypt, jwt, psycopg" 2>/dev/null; then
    warn "some python deps are missing in .venv — iam/context services may not start (re-run 'up', or pip install into .venv)"
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

  boot audit-gov        "cd audit-governance-service  && DATABASE_URL=\"$DATABASE_URL_AUDIT_GOV\" PORT=8500 MCP_SERVER_URL=\"$MCP_SERVER_URL\" MCP_BEARER_TOKEN=\"$MCP_BEARER_TOKEN\" npm run dev"
  sleep 2
  boot llm-gateway      "cd context-fabric && LLM_PROVIDER_CONFIG_PATH=\"$LLM_PROVIDER_CONFIG_PATH\" LLM_MODEL_CATALOG_PATH=\"$LLM_MODEL_CATALOG_PATH\" ALLOW_CALLER_PROVIDER_OVERRIDE=false python3 -m uvicorn services.llm_gateway_service.app.main:app --host 0.0.0.0 --port 8001"
  sleep 1

  boot agent-service    "cd agent-and-tools/apps/agent-service   && PORT=3001 DATABASE_URL=\"$DATABASE_URL_AGENT_TOOLS\" IAM_SERVICE_URL=\"$IAM_SERVICE_URL\" AUDIT_GOV_URL=\"$AUDIT_GOV_URL\" MCP_SERVER_URL=\"$MCP_SERVER_URL\" MCP_BEARER_TOKEN=\"$MCP_BEARER_TOKEN\" JWT_SECRET=\"$JWT_SECRET\" npm run dev"
  boot tool-service     "cd agent-and-tools/apps/tool-service    && PORT=3002 DATABASE_URL=\"$DATABASE_URL_AGENT_TOOLS\" IAM_SERVICE_URL=\"$IAM_SERVICE_URL\" AUDIT_GOV_URL=\"$AUDIT_GOV_URL\" MCP_SERVER_URL=\"$MCP_SERVER_URL\" MCP_BEARER_TOKEN=\"$MCP_BEARER_TOKEN\" JWT_SECRET=\"$JWT_SECRET\" npm run dev"
  boot agent-runtime    "cd agent-and-tools/apps/agent-runtime   && PORT=3003 DATABASE_URL=\"$DATABASE_URL_AGENT_TOOLS\" IAM_SERVICE_URL=\"$IAM_SERVICE_URL\" AUDIT_GOV_URL=\"$AUDIT_GOV_URL\" MCP_SERVER_URL=\"$MCP_SERVER_URL\" MCP_BEARER_TOKEN=\"$MCP_BEARER_TOKEN\" JWT_SECRET=\"$JWT_SECRET\" npm run dev"
  boot prompt-composer  "cd agent-and-tools/apps/prompt-composer && PORT=3004 DATABASE_URL=\"$DATABASE_URL_COMPOSER\" DATABASE_URL_RUNTIME_READ=\"$DATABASE_URL_RUNTIME_READ\" AUDIT_GOV_URL=\"$AUDIT_GOV_URL\" MCP_SERVER_URL=\"$MCP_SERVER_URL\" MCP_BEARER_TOKEN=\"$MCP_BEARER_TOKEN\" CAPSULE_COMPILE_MODEL_ALIAS=mock JWT_SECRET=\"$JWT_SECRET\" npm run dev"

  boot mcp-server       "cd mcp-server && PORT=7100 MCP_BEARER_TOKEN=\"$MCP_BEARER_TOKEN\" LLM_GATEWAY_URL=\"$LLM_GATEWAY_URL\" MCP_COMMAND_EXECUTION_MODE=process MCP_LLM_PROVIDER_CONFIG_PATH=\"$LLM_PROVIDER_CONFIG_PATH\" MCP_LLM_MODEL_CATALOG_PATH=\"$LLM_MODEL_CATALOG_PATH\" AUDIT_GOV_URL=\"$AUDIT_GOV_URL\" npm run dev"
  # context-api / context-memory import `context_fabric_shared` (in
  # context-fabric/shared/) and the `services.` namespace — so run them from the
  # context-fabric root with shared on PYTHONPATH and a fully-qualified module
  # path, exactly like llm-gateway. (Booting from the service subdir is why they
  # were crashing with ModuleNotFoundError.)
  boot context-api      "cd context-fabric && PYTHONPATH=\"$ROOT/context-fabric/shared\" DATABASE_URL=\"$DATABASE_URL_AUDIT_GOV\" CONTEXT_FABRIC_DATABASE_URL=\"$CONTEXT_FABRIC_DATABASE_URL\" PORT=8000 IAM_BASE_URL=\"$IAM_BASE_URL\" AUDIT_GOV_URL=\"$AUDIT_GOV_URL\" CONTEXT_MEMORY_URL=\"$CONTEXT_MEMORY_URL\" MCP_SERVER_URL=\"$MCP_SERVER_URL\" MCP_BEARER_TOKEN=\"$MCP_BEARER_TOKEN\" python3 -m uvicorn services.context_api_service.app.main:app --host 0.0.0.0 --port 8000"
  boot context-memory   "cd context-fabric && PYTHONPATH=\"$ROOT/context-fabric/shared\" CONTEXT_FABRIC_DATABASE_URL=\"$CONTEXT_FABRIC_DATABASE_URL\" PORT=8002 IAM_BASE_URL=\"$IAM_BASE_URL\" AUDIT_GOV_URL=\"$AUDIT_GOV_URL\" python3 -m uvicorn services.context_memory_service.app.main:app --host 0.0.0.0 --port 8002"
  boot formal-verifier  "cd context-fabric/services/formal_verifier_service && PORT=8010 CONTEXT_FABRIC_DATABASE_URL=\"$CONTEXT_FABRIC_DATABASE_URL\" AUDIT_GOV_URL=\"$AUDIT_GOV_URL\" python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8010"
  sleep 3

  boot workgraph-api    "cd workgraph-studio/apps/api && PORT=8080 DATABASE_URL=\"$DATABASE_URL_WORKGRAPH\" JWT_SECRET=\"$JWT_SECRET\" AUTH_PROVIDER=iam IAM_BASE_URL=\"$IAM_BASE_URL\" AGENT_RUNTIME_URL=\"$AGENT_RUNTIME_URL\" TOOL_SERVICE_URL=\"$TOOL_SERVICE_URL\" AGENT_SERVICE_URL=\"$AGENT_SERVICE_URL\" PROMPT_COMPOSER_URL=\"$PROMPT_COMPOSER_URL\" CONTEXT_FABRIC_URL=\"$CONTEXT_FABRIC_URL\" CONTEXT_MEMORY_URL=\"$CONTEXT_MEMORY_URL\" FORMAL_VERIFIER_URL=\"$FORMAL_VERIFIER_URL\" MCP_SERVER_URL=\"$MCP_SERVER_URL\" MCP_BEARER_TOKEN=\"$MCP_BEARER_TOKEN\" WORKBENCH_DEFAULT_MODEL_ALIAS=mock AUDIT_GOV_URL=\"$AUDIT_GOV_URL\" npm run dev"

  # PORT=3000 forces Next.js to fail loudly on a port collision rather than
  # silently auto-bumping to 3001 (which would dodge the SPA proxy rewrites).
  boot agent-web        "cd agent-and-tools/web        && PORT=3000 IAM_BASE_URL=\"$IAM_BASE_URL\" AUDIT_GOV_URL=\"$AUDIT_GOV_URL\" MCP_SERVER_URL=\"$MCP_SERVER_URL\" MCP_BEARER_TOKEN=\"$MCP_BEARER_TOKEN\" AGENT_RUNTIME_URL=\"$AGENT_RUNTIME_URL\" TOOL_SERVICE_URL=\"$TOOL_SERVICE_URL\" AGENT_SERVICE_URL=\"$AGENT_SERVICE_URL\" PROMPT_COMPOSER_URL=\"$PROMPT_COMPOSER_URL\" npm run dev"
  boot workgraph-web    "cd workgraph-studio/apps/web  && VITE_API_BASE=http://localhost:8080 VITE_IAM_BASE_URL=\"$IAM_BASE_URL\" VITE_IAM_LOGIN_URL=http://localhost:5175/login VITE_AUTO_LOGIN=0 npm run dev -- --host 0.0.0.0 --port 5174"
  boot blueprint-workbench "cd workgraph-studio/apps/blueprint-workbench && npm run dev -- --host 0.0.0.0 --port 5176"
  # IAM admin SPA — hosts the capability-governance authoring UI (G7–G9).
  boot user-and-capability "cd UserAndCapabillity && VITE_IAM_BASE_URL=\"$IAM_BASE_URL\" npm run dev -- --host 0.0.0.0 --port 5175"
  # Unified operations/launcher portal (Vite; dev script binds 5180 itself).
  # VITE_LINK_* point the portal's app cards at the per-port bare-metal apps.
  # Without them the portal defaults to single-origin paths (/workflow, /workbench,
  # …) that only resolve behind the Docker edge-gateway — in bare-metal they bounce
  # back to the portal index.
  boot portal "cd singularity-portal && VITE_IAM_BASE_URL=\"$IAM_BASE_URL\" VITE_LINK_WORKGRAPH_DESIGNER=http://localhost:5174 VITE_LINK_BLUEPRINT_WORKBENCH=http://localhost:5176 VITE_LINK_AGENT_ADMIN=http://localhost:3000 VITE_LINK_IAM_ADMIN=http://localhost:5175 npm run dev -- --host 0.0.0.0"

  echo
  ok "all services booted — run '$0 smoke' in ~30s to verify, then open:"
  echo "    http://localhost:5174    (workgraph: runs, insights, designer)"
  echo "    http://localhost:5176    (blueprint workbench: staged agent loop)"
  echo "    http://localhost:5180    (portal: unified operations center + launcher)"
  echo "    http://localhost:5175    (user-and-capability: IAM admin + governance authoring)"
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
  for p in 3000 3001 3002 3003 3004 5174 5175 5176 5180 7100 8000 8002 8010 8080 8100 8101 8500; do
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
    "http://localhost:8002/health" \
    "http://localhost:8010/health" \
    "http://localhost:8080/health" \
    "http://localhost:3000/api/runtime/agents/templates?scope=common&limit=3" \
    "http://localhost:5174/" \
    "http://localhost:5175/" \
    "http://localhost:5176/" \
    "http://localhost:5180/" \
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
# ── reset-db ────────────────────────────────────────────────────────────────
# Drop every platform database for a clean slate. DESTRUCTIVE. Services holding
# a connection block a drop, so run 'down' first (DROP … WITH (FORCE) also
# terminates lingering sessions on PG 13+). Then 'up' recreates + reseeds.
cmd_reset_db() {
  local db_user="${1:?usage: $0 reset-db <db_user> [db_password] [db_host] [db_port]}"
  local db_pass="${2:-${PGPASSWORD:-postgres}}"
  local db_host="${3:-localhost}"
  local db_port="${4:-5432}"
  require psql
  warn "DROPPING all Singularity databases on ${db_user}@${db_host}:${db_port} — ALL DATA WILL BE LOST."
  local db
  for db in singularity singularity_composer workgraph audit_governance singularity_iam singularity_context_fabric; do
    if PGPASSWORD="$db_pass" psql -h "$db_host" -p "$db_port" -U "$db_user" -d postgres \
         -c "DROP DATABASE IF EXISTS \"$db\" WITH (FORCE);" >/dev/null 2>&1; then
      dim "  dropped $db"
    else
      warn "  could not drop $db — stop connected services first ('$0 down') and retry"
    fi
  done
  ok "databases dropped — run '$0 up <db_user>' to recreate fresh."
}

cmd="${1:-help}"
shift || true
case "$cmd" in
  up)       cmd_up "$@" ;;
  down)     cmd_down ;;
  reset-db) cmd_reset_db "$@" ;;
  smoke)    cmd_smoke ;;
  status)   cmd_status ;;
  logs)     cmd_logs "$@" ;;
  *)
    cat <<USAGE
Singularity bare-metal launcher.

  $0 up <db_user> [db_password] [db_host] [db_port]
                            create DBs, install deps, push schemas, seed,
                            boot all services. Idempotent.

  $0 reset-db <db_user> [db_password] [db_host] [db_port]
                            DROP all platform databases (clean slate). DESTRUCTIVE.
                            Run '$0 down' first, then '$0 up' to recreate fresh.

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
