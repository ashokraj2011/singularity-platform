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
#   SEED_EVENT_VERIFIER_ENABLED true (default) | false
#   SEED_EVENT_VERIFIER_SIMULATE true to create/start one sample WorkItem run
#   SEED_EVENT_VERIFIER_CAPABILITY_ID capability to bind (default: 11111111…)
#   SEED_EVENT_VERIFIER_LLM_ALIAS WorkGraph LLM connection alias (default: mock)
set -uo pipefail
cd "$(dirname "$0")/.."

CF="${COMPOSE_FILES:--f docker-compose.yml}"
GOV="${SEED_GOVERNANCE_MODE:-fail_open}"
PREFER_LAPTOP="${SEED_PREFER_LAPTOP:-true}"
dc() { docker compose $CF "$@"; }

# Track step failures so we fail fast instead of printing success on a partially
# seeded install. The seeds are idempotent (ON CONFLICT), so an error here is a
# real problem, not "already seeded".
fail=0

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
    || { echo "     ⚠ $2 failed (see errors above)"; fail=$((fail + 1)); }
}

echo "── 1/7  IAM: teams + default-demo capability (11111111…) + MCP server"
sql singularity_iam seed/00-iam.sql

echo "── 2/7  IAM: demo login users (user1..10 / Admin1234!) + per-user capabilities"
sql singularity_iam seed/04-demo-users.sql
sql singularity_iam seed/05-demo-user-capabilities.sql

echo "── 3/7  agent-runtime: capability + role bindings (role templates auto-seed on boot)"
sql singularity seed/01-agent-runtime.sql

echo "── 4/7  prompt-composer: governed role/stage prompts"
dc exec -T "$(composer_exec_service)" sh -c 'cd /app/apps/prompt-composer && npm run seed' || { echo "   ⚠ composer seed failed — check logs"; fail=$((fail + 1)); }

echo "── 5/7  workgraph: artifact templates (idempotent)"
dc exec -T workgraph-api npx prisma db seed || { echo "   ⚠ workgraph base/artifact-template seed failed"; fail=$((fail + 1)); }

echo "── 6/7  workgraph: SDLC workflows (workbench → main → copilot → parent wrappers)"
dc exec -T workgraph-api npx ts-node --transpile-only prisma/seed-sdlc-workbench.ts || { echo "   ⚠ workbench seed failed"; fail=$((fail + 1)); }
dc exec -T workgraph-api npx ts-node --transpile-only prisma/seed-sdlc-main.ts      || { echo "   ⚠ main seed failed"; fail=$((fail + 1)); }
dc exec -T \
  -e SEED_GOVERNANCE_MODE="$GOV" \
  -e SEED_PREFER_LAPTOP="$PREFER_LAPTOP" \
  ${SEED_COPILOT_REPO_URL:+-e SEED_COPILOT_REPO_URL="$SEED_COPILOT_REPO_URL"} \
  workgraph-api npx ts-node --transpile-only prisma/seed-sdlc-copilot.ts || { echo "   ⚠ copilot seed failed"; fail=$((fail + 1)); }
dc exec -T \
  -e SEED_GOVERNANCE_MODE="$GOV" \
  ${SEED_COPILOT_REPO_URL:+-e SEED_COPILOT_REPO_URL="$SEED_COPILOT_REPO_URL"} \
  workgraph-api npx ts-node --transpile-only prisma/seed-spec-handoff.ts || { echo "   ⚠ spec-handoff seed failed"; fail=$((fail + 1)); }
dc exec -T workgraph-api npx ts-node --transpile-only prisma/seed-workbench-parents.ts || { echo "   ⚠ workbench parent seed failed"; fail=$((fail + 1)); }

if [ "${SEED_EVENT_VERIFIER_ENABLED:-true}" != "false" ]; then
  echo "── 7/7  workgraph + agent-runtime: event Verifier workflow bootstrap"
  sim_arg=""
  [ "${SEED_EVENT_VERIFIER_SIMULATE:-false}" = "true" ] && sim_arg="--simulate"
  python3 bin/seed-event-verifier-demo.py --quiet $sim_arg \
    || { echo "   ⚠ event Verifier bootstrap failed — check IAM/workgraph/agent-runtime health"; fail=$((fail + 1)); }
else
  echo "── 7/7  event Verifier workflow bootstrap skipped (SEED_EVENT_VERIFIER_ENABLED=false)"
fi

echo
if [ "$fail" -gt 0 ]; then
  echo "✗ $fail seed step(s) failed — install is incomplete. Fix the errors above and re-run."
  exit 1
fi
echo "✓ Seeded. Open  http://localhost:5180  and log in:"
echo "    bootstrap IAM account from ./singularity.sh config show   (super admin)"
echo "    user1@singularity.local / Admin1234!   (demo user)"
echo "  'feature' work items now route to the Copilot SDLC (governanceMode=$GOV, preferLaptop=$PREFER_LAPTOP)."
echo "  '${SEED_EVENT_VERIFIER_EVENT_TYPE:-VERIFIER_DOCUMENT_SUBMITTED}' events route to the Verifier workflow when event Verifier bootstrap is enabled."
