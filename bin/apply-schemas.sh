#!/usr/bin/env bash
# M29 — one-shot schema applier for the docker-compose stack.
#
# Why this exists: Prisma's `db push` always drops tables not in the active
# schema. With agent-runtime + prompt-composer sharing one Postgres, neither
# container can safely push its own schema at startup — it'd silently drop
# the other service's tables on every restart.
#
# This script applies BOTH schemas in the correct order against the shared
# `singularity` DB. Run it once after `docker compose up -d` (and any time
# either Prisma schema changes). Subsequent container restarts don't need it.
#
# For bare-metal dev, `bin/bare-metal.sh up` calls this same logic inline —
# this script is the docker-stack equivalent.
#
# Usage:
#   ./bin/apply-schemas.sh

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

C_BLUE=$'\033[1;34m'; C_GREEN=$'\033[1;32m'; C_END=$'\033[0m'
info() { echo -e "${C_BLUE}▸${C_END} $*"; }
ok()   { echo -e "${C_GREEN}✓${C_END} $*"; }

# Wait for at-postgres to be reachable
info "waiting for at-postgres…"
for _ in $(seq 1 30); do
  docker exec singularity-at-postgres pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 1
done

# Stage 1: composer pushes first (it has fewer models — the prompt set).
# Anything in the DB not in composer's schema gets dropped here.
info "applying prompt-composer schema (stage 1)…"
docker exec singularity-prompt-composer sh -c \
  "cd /app/apps/prompt-composer && npx prisma db push --skip-generate --accept-data-loss" \
  2>&1 | tail -3

# Stage 2: agent-runtime pushes second. Re-adds its 13 tables that composer
# dropped (event_outbox, AgentExecution, etc.). Composer's 6 owned tables
# are also declared as mirrors in agent-runtime's schema, so they survive
# this push.
info "applying agent-runtime schema (stage 2)…"
docker exec singularity-agent-runtime sh -c \
  "cd /app/apps/agent-runtime && npx prisma db push --skip-generate --accept-data-loss" \
  2>&1 | tail -3

# Verify both sets of tables are present
info "verifying both sets of tables exist…"
COMPOSER_TBLS=$(docker exec singularity-at-postgres psql -U postgres -d singularity -tA -c \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='PromptAssembly';")
RUNTIME_TBLS=$(docker exec singularity-at-postgres psql -U postgres -d singularity -tA -c \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='event_outbox';")
if [ "$COMPOSER_TBLS" = "1" ] && [ "$RUNTIME_TBLS" = "1" ]; then
  ok "schemas applied — composer's PromptAssembly + agent-runtime's event_outbox both present"
else
  echo "✗ schema apply incomplete: composer.PromptAssembly=$COMPOSER_TBLS, runtime.event_outbox=$RUNTIME_TBLS"
  exit 1
fi

# Restart both services so their Prisma clients clear any cached "table missing" errors
info "restarting both services to clear any cached errors…"
docker compose restart agent-runtime prompt-composer 2>&1 | tail -3

ok "done."
echo
echo "  Next: probe /healthz/strict on each service to confirm invariants pass."
echo "    curl localhost:3003/healthz/strict | jq .data.checks"
echo "    curl localhost:3004/healthz/strict | jq .data.checks"
