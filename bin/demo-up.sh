#!/usr/bin/env bash
# Demo launcher — brings up the FULL stack ready for the demo.
#
# Wraps bin/bare-metal.sh (core stack) + the three pieces it skips:
#   - portal (5180) — the main entry SPA
#   - UserAndCapabillity (5175) — IAM admin SPA
#   - Blueprint Workbench (5176) now comes from bare-metal.sh with Workgraph
#   - pseudo-iam (8101) — for `singularity-mcp login` demo
#
# Also fixes the things bare-metal.sh doesn't do by default:
#   - mcp-server pointed at /tmp/todoapp-demo with real OpenAI (gpt-4.1)
#   - context-api re-launched with IAM bootstrap creds + writable SQLite paths
#   - audit-gov schema applied (idempotent)
#   - default-demo MCP server registered in IAM (idempotent)
#   - todoapp-demo cloned/refreshed at /tmp/todoapp-demo with git user configured
#   - portal .env.local pinned to the seeded IAM capability_id
#
# Usage:
#   ./bin/demo-up.sh
#   ./bin/demo-up.sh down        # stop everything (via bin/demo-down.sh)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

if [ "${1:-}" = "down" ]; then
  exec "$SCRIPT_DIR/demo-down.sh"
fi

LOG_DIR="$ROOT/logs"
SANDBOX="/tmp/todoapp-demo"
TODOAPP_REPO="https://github.com/ashokraj2011/todoapp"
CAP_IAM_UUID="11111111-2222-3333-4444-555555555555"   # seeded IAM "default-demo"
MCP_BEARER="demo-bearer-token-must-be-min-16-chars"

C_BLUE=$'\033[1;34m'; C_GREEN=$'\033[1;32m'; C_YELLOW=$'\033[1;33m'
C_RED=$'\033[1;31m';  C_DIM=$'\033[2m';      C_END=$'\033[0m'
info()  { echo -e "${C_BLUE}▸${C_END} $*"; }
ok()    { echo -e "${C_GREEN}✓${C_END} $*"; }
warn()  { echo -e "${C_YELLOW}⚠${C_END} $*"; }
err()   { echo -e "${C_RED}✗${C_END} $*" >&2; }
dim()   { echo -e "${C_DIM}$*${C_END}"; }

mkdir -p "$LOG_DIR"

# ── 1. Prereqs ─────────────────────────────────────────────────────────────
require() { command -v "$1" >/dev/null 2>&1 || { err "missing binary: $1"; exit 1; }; }
require node; require npm; require psql; require git; require python3; require curl
command -v pnpm >/dev/null 2>&1 || warn "pnpm not found — workgraph install will fail; install with 'npm i -g pnpm'"

# Homebrew Postgres must be running on 5432
if ! pg_isready -h localhost -p 5432 >/dev/null 2>&1; then
  warn "Postgres not reachable at localhost:5432 — trying to start brew postgresql@14…"
  brew services start postgresql@14 >/dev/null 2>&1 || true
  sleep 2
fi
pg_isready -h localhost -p 5432 >/dev/null 2>&1 || { err "Postgres still not reachable. Start it manually."; exit 1; }
ok "Postgres on 5432 is up"

# OpenAI key for real LLM responses (Event Horizon + AGENT_TASK)
OPENAI_KEY="${OPENAI_API_KEY:-}"
if [ -z "$OPENAI_KEY" ] && [ -f ~/.zshrc ]; then
  OPENAI_KEY=$(grep "^export OPENAI_API_KEY" ~/.zshrc 2>/dev/null | head -1 | sed -E 's/^export OPENAI_API_KEY="?([^"]+)"?$/\1/')
fi
if [ -z "$OPENAI_KEY" ]; then
  warn "OPENAI_API_KEY not found — Event Horizon chat will fall back to mock LLM"
else
  ok "OpenAI key resolved"
fi

# ── 2. Prep todoapp sandbox ────────────────────────────────────────────────
if [ ! -d "$SANDBOX/.git" ]; then
  info "cloning todoapp into $SANDBOX …"
  rm -rf "$SANDBOX" 2>/dev/null
  git clone --quiet "$TODOAPP_REPO" "$SANDBOX"
fi
( cd "$SANDBOX" && \
  git config user.email "demo@singularity.local" && \
  git config user.name  "Singularity Demo" && \
  git checkout main >/dev/null 2>&1 && \
  git branch | grep -vE '^\* main$|^  main$' | xargs -I{} git branch -D {} >/dev/null 2>&1 || true )
ok "todoapp sandbox ready at $SANDBOX (on main)"

# ── 3. Bring up the core stack (bare-metal.sh) ─────────────────────────────
info "booting core stack via bin/bare-metal.sh up …"
"$SCRIPT_DIR/bare-metal.sh" up ashokraj postgres localhost 5432 2>&1 | tail -20

# .env.local was just written by bare-metal.sh; source it so we get DATABASE_URLs etc.
. "$ROOT/.env.local"

# ── 4. Apply audit-gov schema (bare-metal sometimes skips this on a fresh DB) ──
info "ensuring audit-gov schema is present…"
PGPASSWORD=postgres psql -h localhost -p 5432 -U ashokraj -d audit_governance \
  -f audit-governance-service/db/init.sql >/dev/null 2>&1 || \
  warn "audit-gov init.sql had warnings (likely already applied)"

# ── 5. Re-launch mcp-server with real OpenAI + todoapp sandbox ─────────────
info "swapping mcp-server to OpenAI + todoapp sandbox…"
# bare-metal launched mcp-server on mock with /workspace — kill it and relaunch
lsof -nP -iTCP:7100 -sTCP:LISTEN -t 2>/dev/null | xargs -I{} kill -9 {} 2>/dev/null || true
sleep 1
(cd "$ROOT/mcp-server" && nohup env \
   PORT=7100 \
   MCP_BEARER_TOKEN="$MCP_BEARER" \
   MCP_SANDBOX_ROOT="$SANDBOX" \
   MCP_AST_DB_PATH="$SANDBOX/.singularity/mcp-ast.sqlite" \
   LLM_PROVIDER="${OPENAI_KEY:+openai}" \
   LLM_PROVIDER="${LLM_PROVIDER:-${OPENAI_KEY:+openai}}" \
   LLM_MODEL="${OPENAI_KEY:+gpt-4.1}" \
   OPENAI_API_KEY="$OPENAI_KEY" \
   OPENAI_DEFAULT_MODEL="${OPENAI_KEY:+gpt-4.1}" \
   OPENAI_PARALLEL_TOOLS=false \
   AUDIT_GOV_URL="${AUDIT_GOV_URL:-http://localhost:8500}" \
   MAX_AGENT_STEPS=8 \
   npm run dev > "$LOG_DIR/mcp-server.log" 2>&1 &)

# Fall back to mock if no OpenAI key
if [ -z "$OPENAI_KEY" ]; then
  warn "Restarting mcp-server in mock mode (no OpenAI key)"
  lsof -nP -iTCP:7100 -sTCP:LISTEN -t 2>/dev/null | xargs -I{} kill -9 {} 2>/dev/null || true
  sleep 1
  (cd "$ROOT/mcp-server" && nohup env \
     PORT=7100 MCP_BEARER_TOKEN="$MCP_BEARER" \
     MCP_SANDBOX_ROOT="$SANDBOX" \
     MCP_AST_DB_PATH="$SANDBOX/.singularity/mcp-ast.sqlite" \
     LLM_PROVIDER=mock LLM_MODEL=mock-fast \
     AUDIT_GOV_URL="${AUDIT_GOV_URL:-http://localhost:8500}" \
     npm run dev > "$LOG_DIR/mcp-server.log" 2>&1 &)
fi
ok "mcp-server relaunched"

# ── 6. Re-launch context-api with IAM bootstrap + writable SQLite paths ────
info "swapping context-api to use IAM bootstrap creds + writable DBs…"
lsof -nP -iTCP:8000 -sTCP:LISTEN -t 2>/dev/null | xargs -I{} kill -9 {} 2>/dev/null || true
sleep 1
mkdir -p /tmp/cf-data
SHARED="$ROOT/context-fabric/shared"
(cd "$ROOT/context-fabric/services/context_api_service" && nohup env \
   PYTHONPATH="$SHARED:${PYTHONPATH:-}" \
   CALL_LOG_DB=/tmp/cf-data/call_log.db \
   EVENTS_STORE_DB=/tmp/cf-data/call_log_events.db \
   IAM_BOOTSTRAP_USERNAME=admin@singularity.local \
   IAM_BOOTSTRAP_PASSWORD=Admin1234! \
   IAM_BASE_URL="${IAM_BASE_URL:-http://localhost:8100/api/v1}" \
   MCP_SERVER_URL="${MCP_SERVER_URL:-http://localhost:7100}" \
   MCP_BEARER_TOKEN="$MCP_BEARER" \
   AUDIT_GOV_URL="${AUDIT_GOV_URL:-http://localhost:8500}" \
   python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8000 \
   > "$LOG_DIR/context-api.log" 2>&1 &)
ok "context-api relaunched"

# ── 7. Start portal, UAC, pseudo-iam (skipped by bare-metal) ───────────────
info "booting portal (5180), UserAndCapabillity (5175), pseudo-iam (8101)…"

# Portal: pin the capability_id Event Horizon uses
cat > "$ROOT/singularity-portal/.env.local" <<EOF
VITE_API_MODE=proxy
VITE_EVENT_HORIZON_CAPABILITY_ID=$CAP_IAM_UUID
EOF

(cd "$ROOT/singularity-portal" && nohup npm run dev > "$LOG_DIR/portal.log" 2>&1 &)
(cd "$ROOT/UserAndCapabillity" && nohup env VITE_IAM_BASE_URL="$IAM_BASE_URL" npm run dev > "$LOG_DIR/uac.log" 2>&1 &)
(cd "$ROOT/pseudo-iam-service" && nohup env PORT=8101 JWT_SECRET="$JWT_SECRET" npm run dev > "$LOG_DIR/pseudo-iam.log" 2>&1 &)
ok "frontends + pseudo-iam launched"

# ── 8. Wait for everything to be ready ─────────────────────────────────────
info "waiting for services to be healthy…"
declare -a CHECKS=(
  "iam-service|http://localhost:8100/api/v1/health"
  "audit-gov|http://localhost:8500/health"
  "agent-runtime|http://localhost:3003/health"
  "tool-service|http://localhost:3002/health"
  "agent-service|http://localhost:3001/health"
  "prompt-composer|http://localhost:3004/health"
  "mcp-server|http://localhost:7100/health"
  "context-api|http://localhost:8000/health"
  "workgraph-api|http://localhost:8080/health"
  "agent-web|http://localhost:3000/"
  "workgraph-web|http://localhost:5174/"
  "blueprint-workbench|http://localhost:5176/"
  "portal|http://localhost:5180/"
  "uac|http://localhost:5175/"
  "pseudo-iam|http://localhost:8101/health"
)

for check in "${CHECKS[@]}"; do
  name="${check%|*}"
  url="${check#*|}"
  printf "  %-18s " "$name"
  for _ in $(seq 1 30); do
    code=$(curl -s -o /dev/null -w "%{http_code}" "$url" --max-time 2 || true)
    if [ "$code" = "200" ]; then echo -e "${C_GREEN}✓${C_END}"; break; fi
    sleep 1
  done
  if [ "$code" != "200" ]; then echo -e "${C_RED}✗ ($code)${C_END}  → tail $LOG_DIR/${name}.log"; fi
done

# ── 9. Register MCP server in IAM (idempotent) ─────────────────────────────
info "registering MCP server in IAM for capability $CAP_IAM_UUID (idempotent)…"
TOKEN=$(curl -sS -X POST http://localhost:8100/api/v1/auth/local/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@singularity.local","password":"Admin1234!"}' \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('access_token',''))")

EXISTING=$(curl -sS -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8100/api/v1/capabilities/$CAP_IAM_UUID/mcp-servers" --max-time 5 \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print(len(d) if isinstance(d,list) else 0)" 2>/dev/null || echo 0)

if [ "$EXISTING" = "0" ]; then
  curl -sS -X POST "http://localhost:8100/api/v1/capabilities/$CAP_IAM_UUID/mcp-servers" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --max-time 5 \
    -d "{\"name\":\"local-mcp-demo\",\"description\":\"Demo MCP (local)\",\"base_url\":\"http://localhost:7100\",\"auth_method\":\"BEARER_TOKEN\",\"bearer_token\":\"$MCP_BEARER\",\"protocol\":\"MCP_HTTP\",\"protocol_version\":\"1.0\"}" \
    > /dev/null && ok "MCP server registered in IAM"
else
  ok "MCP server already registered (skipped)"
fi

# ── 10. Final summary ──────────────────────────────────────────────────────
echo
ok "Demo stack is up. Open the portal:"
echo "    ${C_BLUE}http://localhost:5180${C_END}    Singularity Portal (Event Horizon chat, tiles)"
echo "    http://localhost:5174    Workgraph (designer + Run Insights)"
echo "    http://localhost:5176    Blueprint Workbench (embedded agent loop)"
echo "    http://localhost:3000    Agent Studio + Audit + Cost"
echo "    http://localhost:5175    UserAndCapabillity (IAM admin)"
echo
echo "  Real IAM:    admin@singularity.local / Admin1234!"
echo "  Pseudo-IAM:  any email / any password  (port 8101, for laptop CLI)"
echo
echo "  Code-change demo:    ${C_BLUE}./bin/demo-todoapp.sh${C_END}  (deterministic, real commit)"
echo
echo "  Workflow:            workgraph SPA → 'TodoApp — Add Clear Completed'"
echo "                       (workflow_id: 9f4f1824-0a27-4d49-b24b-2ff15493ab73"
echo "                        — re-create via the SPA if you wiped the DB)"
echo
dim "  Stop everything:    ./bin/demo-up.sh down   (or ./bin/demo-down.sh)"
dim "  Tail any service:   tail -f logs/<name>.log"
