#!/usr/bin/env bash
# Fully seed the Singularity Docker box in dependency order: IAM users +
# capability, agent-runtime bindings, prompt-composer prompts, workgraph artifact
# templates, and the SDLC workflows (incl. the Copilot SDLC).
#
# Run AFTER the box is up (`docker compose up -d` or `bin/laptop-bridge.sh
# box-up-direct`) and iam-service / agent-runtime / workgraph-api are healthy.
#
# Auto-seeded on boot already (not repeated here): DBs/roles, IAM super-admin,
# agent-runtime role AgentTemplates (00000000-…d1..d8), workgraph artifact
# templates + demo workflows.
#
# Override knobs (env):
#   COMPOSE_FILES        compose -f flags (default: -f docker-compose.yml)
#   SEED_GOVERNANCE_MODE fail_open (default, no audit-gov) | fail_closed
#   SEED_PREFER_LAPTOP   true (default, bridge: laptop dials in) | false (direct HTTP mcp)
#   SEED_COPILOT_REPO_URL last-resort repo for capabilities with no linked repo
set -uo pipefail
cd "$(dirname "$0")/.."

CF="${COMPOSE_FILES:--f docker-compose.yml}"
GOV="${SEED_GOVERNANCE_MODE:-fail_open}"
PREFER_LAPTOP="${SEED_PREFER_LAPTOP:-true}"
dc() { docker compose $CF "$@"; }

composer_exec_service() {
  if dc ps -q platform-core >/dev/null 2>&1 && [ -n "$(dc ps -q platform-core 2>/dev/null)" ]; then
    echo platform-core
  else
    echo prompt-composer
  fi
}

sql() {  # $1 = db, $2 = file — tolerant so a re-run (already-seeded) keeps going
  echo "   • $2 → $1"
  dc exec -T at-postgres psql -v ON_ERROR_STOP=1 -U postgres -d "$1" < "$2" \
    || echo "     ⚠ errors (likely already seeded) — continuing"
}

echo "── 1/6  IAM: teams + default-demo capability (11111111…) + MCP server"
sql singularity_iam seed/00-iam.sql

echo "── 2/6  IAM: demo login users (user1..10 / Admin1234!) + per-user capabilities"
sql singularity_iam seed/04-demo-users.sql
sql singularity_iam seed/05-demo-user-capabilities.sql

echo "── 3/6  agent-runtime: capability + role bindings (role templates auto-seed on boot)"
sql singularity seed/01-agent-runtime.sql

echo "── 4/6  prompt-composer: governed role/stage prompts"
dc exec -T "$(composer_exec_service)" sh -c 'cd /app/apps/prompt-composer && npm run seed' || echo "   ⚠ composer seed failed — check logs"

echo "── 5/6  workgraph: artifact templates (idempotent)"
dc exec -T workgraph-api npx prisma db seed || true

echo "── 6/6  workgraph: SDLC workflows (workbench → main → copilot)"
dc exec -T workgraph-api npx tsx prisma/seed-sdlc-workbench.ts || echo "   ⚠ workbench seed failed"
dc exec -T workgraph-api npx tsx prisma/seed-sdlc-main.ts      || echo "   ⚠ main seed failed"
dc exec -T \
  -e SEED_GOVERNANCE_MODE="$GOV" \
  -e SEED_PREFER_LAPTOP="$PREFER_LAPTOP" \
  ${SEED_COPILOT_REPO_URL:+-e SEED_COPILOT_REPO_URL="$SEED_COPILOT_REPO_URL"} \
  workgraph-api npx tsx prisma/seed-sdlc-copilot.ts

echo
echo "✓ Seeded. Open  http://localhost:5180  and log in:"
echo "    bootstrap IAM account from ./singularity.sh config show   (super admin)"
echo "    user1@singularity.local / Admin1234!   (demo user)"
echo "  'feature' work items now route to the Copilot SDLC (governanceMode=$GOV, preferLaptop=$PREFER_LAPTOP)."
