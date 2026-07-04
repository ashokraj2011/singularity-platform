#!/usr/bin/env bash
# M30 — schema applier for the docker-compose stack.
#
# Two DBs, two pushes — they don't conflict because each pushes to its OWN
# Postgres database. No more mirror dance, no startup race.
#
#   agent-runtime  →  `singularity`            (its own owned tables)
#   prompt-composer →  `singularity_composer`  (its OWNED tables only)
#   composer also generates a READ-ONLY client for `singularity` so it can
#   read AgentTemplate / Capability / ToolGrant / DistilledMemory / etc.
#
# Run once after `docker compose up -d` and any time either Prisma schema
# changes. Subsequent container restarts don't need it.
#
# For bare-metal dev, `bin/bare-metal-apps.sh up` calls the same logic inline.
#
# Usage:
#   ./bin/apply-schemas.sh

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

C_BLUE=$'\033[1;34m'; C_GREEN=$'\033[1;32m'; C_END=$'\033[0m'
info() { echo -e "${C_BLUE}▸${C_END} $*"; }
ok()   { echo -e "${C_GREEN}✓${C_END} $*"; }

runtime_container() {
  if docker compose ps -q platform-core >/dev/null 2>&1 && [ -n "$(docker compose ps -q platform-core 2>/dev/null)" ]; then
    echo singularity-platform-core
  else
    echo singularity-agent-runtime
  fi
}

composer_container() {
  if docker compose ps -q platform-core >/dev/null 2>&1 && [ -n "$(docker compose ps -q platform-core 2>/dev/null)" ]; then
    echo singularity-platform-core
  else
    echo singularity-prompt-composer
  fi
}

info "waiting for at-postgres…"
for _ in $(seq 1 30); do
  docker exec singularity-at-postgres pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 1
done

# Ensure singularity_composer DB exists (init.sql creates it on virgin
# volumes, but existing volumes from pre-M30 won't have it).
info "ensuring singularity_composer DB exists…"
if ! docker exec singularity-at-postgres psql -U postgres -d postgres -tAc \
  "SELECT 1 FROM pg_database WHERE datname='singularity_composer'" | grep -qx "1"; then
  docker exec singularity-at-postgres createdb -U postgres singularity_composer
fi
docker exec singularity-at-postgres psql -U postgres -d singularity_composer -c \
  "CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pgcrypto;" \
  2>&1 | grep -v "NOTICE" | tail -3 || true

# Stage 1: agent-runtime pushes against `singularity`.
info "applying agent-runtime schema (DB: singularity)…"
docker exec "$(runtime_container)" sh -c \
  "cd /app/apps/agent-runtime && npx prisma db push --skip-generate --accept-data-loss" \
  2>&1 | tail -3

info "applying agent-runtime hardening migrations (partial indexes + archive reconciliation)…"
docker exec "$(runtime_container)" sh -c '
  set -e
  cd /app/apps/agent-runtime
  for migration_name in \
    20260702160000_capability_learning_status \
    20260703120000_capability_active_identity_unique \
    20260703123000_capability_knowledge_source_identity \
    20260703124500_capability_source_identity \
    20260703130000_capability_code_symbol_identity \
    20260703131500_agent_capability_binding_identity \
    20260703133000_agent_template_active_identity \
    20260703134500_capability_learning_candidate_identity \
    20260703140000_agent_skill_active_identity \
    20260703141000_agent_skill_source_identity \
    20260703142000_agent_template_skill_source_identity \
    20260703143000_capability_code_embedding_identity \
    20260704110000_capability_learning_worker_lock \
    20260704113000_capability_archive_reconcile
  do
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "prisma/migrations/${migration_name}/migration.sql"
  done
' 2>&1 | tail -8

info "applying agent-runtime post-push SQL (pgvector indexes + retrieval FTS)…"
docker exec "$(runtime_container)" sh -c \
  "cd /app/apps/agent-runtime && psql \"\$DATABASE_URL\" -v ON_ERROR_STOP=1 -q -f prisma/post-push.sql" \
  2>&1 | tail -3

# Stage 2: prompt-composer pushes its OWNED schema against `singularity_composer`.
# Its runtime-reader schema generates client only — no DDL on `singularity`.
info "applying prompt-composer OWNED schema (DB: singularity_composer)…"
docker exec "$(composer_container)" sh -c \
  "cd /app/apps/prompt-composer && DATABASE_URL=postgresql://postgres:singularity@at-postgres:5432/singularity_composer npx prisma db push --schema=prisma/schema.prisma --skip-generate --accept-data-loss" \
  2>&1 | tail -3

info "seeding prompt-composer base prompt profiles…"
docker exec "$(composer_container)" sh -c \
  "cd /app/apps/prompt-composer && DATABASE_URL=postgresql://postgres:singularity@at-postgres:5432/singularity_composer npm run seed" \
  2>&1 | tail -6

# Verify
info "verifying both DBs have their respective tables…"
SINGULARITY_TABLES=$(docker exec singularity-at-postgres psql -U postgres -d singularity -tA -c \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='AgentTemplate';")
COMPOSER_TABLES=$(docker exec singularity-at-postgres psql -U postgres -d singularity_composer -tA -c \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='PromptAssembly';")
if [ "$SINGULARITY_TABLES" = "1" ] && [ "$COMPOSER_TABLES" = "1" ]; then
  ok "M30 split healthy — agent-runtime tables on singularity, composer tables on singularity_composer"
else
  echo "✗ schema apply incomplete: singularity.AgentTemplate=$SINGULARITY_TABLES, singularity_composer.PromptAssembly=$COMPOSER_TABLES"
  exit 1
fi

# Restart both so any cached "table missing" errors clear.
if docker compose ps -q platform-core >/dev/null 2>&1 && [ -n "$(docker compose ps -q platform-core 2>/dev/null)" ]; then
  info "restarting platform-core to clear cached errors…"
  docker compose restart platform-core 2>&1 | tail -3
else
  info "restarting agent-runtime + prompt-composer to clear cached errors…"
  docker compose restart agent-runtime prompt-composer 2>&1 | tail -3
fi

ok "done."
echo
echo "  Next: probe /healthz/strict on both services to confirm invariants pass."
echo "    curl localhost:3003/healthz/strict | jq .data.checks"
echo "    curl localhost:3004/healthz/strict | jq .data.checks"
