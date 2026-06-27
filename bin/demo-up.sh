#!/usr/bin/env bash
# Demo launcher — brings up the FULL stack ready for the demo.
#
# Wraps bin/bare-metal-apps.sh + bin/bare-metal-runtime.sh + pseudo-iam (8101)
# for the `singularity-mcp login` demo. Platform Web (:5180) is started by the
# apps launcher.
#
# Also fixes the things the standard bare-metal launchers don't do by default:
#   - mcp-server pointed at /tmp/todoapp-demo with real OpenAI (gpt-4.1)
#   - context-api re-launched with IAM bootstrap creds + writable SQLite paths
#   - audit-gov schema applied (idempotent)
#   - default-demo MCP server registered in IAM (idempotent)
#   - todoapp-demo cloned/refreshed at /tmp/todoapp-demo with git user configured
#   - Platform Web uses the seeded IAM capability_id
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

bootstrap_json=$(python3 - <<'PY'
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
BOOTSTRAP_EMAIL=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["email"])' <<< "$bootstrap_json")
BOOTSTRAP_PASSWORD=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["password"])' <<< "$bootstrap_json")

free_non_docker_port() {
  local port="$1" pids pid cmd
  pids=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)
  for pid in $pids; do
    cmd=$(ps -p "$pid" -o comm= 2>/dev/null || echo "?")
    case "$cmd" in
      *docker*|*Docker*|*vpnkit*)
        warn "port $port is Docker-owned (pid $pid); leaving it alone"
        continue
        ;;
    esac
    kill -9 "$pid" 2>/dev/null || true
  done
}

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

# LLM calls route through the central gateway. Demo mode is mock-only unless
# the operator has explicitly reconfigured .singularity for Copilot.
LLM_GATEWAY_URL="${LLM_GATEWAY_URL:-http://localhost:8001}"

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

# ── 3. Bring up platform apps + local runtime infra ────────────────────────
info "booting platform apps via bin/bare-metal-apps.sh up …"
"$SCRIPT_DIR/bare-metal-apps.sh" up ashokraj postgres localhost 5432 2>&1 | tail -20
info "booting runtime infra via bin/bare-metal-runtime.sh up …"
"$SCRIPT_DIR/bare-metal-runtime.sh" up 2>&1 | tail -20

# .env.local was just written by the apps launcher; source it so we get DATABASE_URLs etc.
. "$ROOT/.env.local"

# ── 4. Apply audit-gov schema (bare-metal sometimes skips this on a fresh DB) ──
info "ensuring audit-gov schema is present…"
PGPASSWORD=postgres psql -h localhost -p 5432 -U ashokraj -d audit_governance \
  -f audit-governance-service/db/init.sql >/dev/null 2>&1 || \
  warn "audit-gov init.sql had warnings (likely already applied)"

# ── 5. Re-launch mcp-server with todoapp sandbox + central gateway ─────────
info "swapping mcp-server to todoapp sandbox + central LLM gateway…"
free_non_docker_port 7100
sleep 1
(cd "$ROOT/mcp-server" && nohup env \
   PORT=7100 \
   MCP_BEARER_TOKEN="$MCP_BEARER" \
   MCP_SANDBOX_ROOT="$SANDBOX" \
   MCP_AST_DB_PATH="$SANDBOX/.singularity/mcp-ast.sqlite" \
   LLM_GATEWAY_URL="$LLM_GATEWAY_URL" \
   MCP_LLM_PROVIDER_CONFIG_PATH="$ROOT/.singularity/llm-providers.json" \
   MCP_LLM_MODEL_CATALOG_PATH="$ROOT/.singularity/llm-models.json" \
   AUDIT_GOV_URL="${AUDIT_GOV_URL:-http://localhost:8500}" \
   MAX_AGENT_STEPS=8 \
   npm run dev > "$LOG_DIR/mcp-server.log" 2>&1 &)
ok "mcp-server relaunched"

# ── 6. Re-launch context-api with IAM bootstrap + Postgres store ───────────
info "swapping context-api to use IAM bootstrap creds + Postgres store…"
free_non_docker_port 8000
sleep 1
PGPASSWORD=postgres psql -h localhost -p 5432 -U ashokraj -d postgres -tAc \
  "SELECT 1 FROM pg_database WHERE datname='singularity_context_fabric'" | grep -q 1 || \
  PGPASSWORD=postgres createdb -h localhost -p 5432 -U ashokraj singularity_context_fabric
CONTEXT_FABRIC_DATABASE_URL="${CONTEXT_FABRIC_DATABASE_URL:-postgresql://ashokraj:postgres@localhost:5432/singularity_context_fabric}"
SHARED="$ROOT/context-fabric/shared"
(cd "$ROOT/context-fabric/services/context_api_service" && nohup env \
   PYTHONPATH="$SHARED:${PYTHONPATH:-}" \
   CONTEXT_FABRIC_DATABASE_URL="$CONTEXT_FABRIC_DATABASE_URL" \
   IAM_BOOTSTRAP_USERNAME="$BOOTSTRAP_EMAIL" \
   IAM_BOOTSTRAP_PASSWORD="$BOOTSTRAP_PASSWORD" \
   IAM_BASE_URL="${IAM_BASE_URL:-http://localhost:8100/api/v1}" \
   MCP_SERVER_URL="${MCP_SERVER_URL:-http://localhost:7100}" \
   MCP_BEARER_TOKEN="$MCP_BEARER" \
   AUDIT_GOV_URL="${AUDIT_GOV_URL:-http://localhost:8500}" \
   python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8000 \
   > "$LOG_DIR/context-api.log" 2>&1 &)
ok "context-api relaunched"

# ── 7. Start pseudo-iam (bare-metal already started Platform Web) ──────────
info "booting pseudo-iam (8101)…"

(cd "$ROOT/pseudo-iam-service" && nohup env PORT=8101 JWT_SECRET="$JWT_SECRET" npm run dev > "$LOG_DIR/pseudo-iam.log" 2>&1 &)
ok "pseudo-iam launched"

# ── 8. Wait for everything to be ready ─────────────────────────────────────
info "waiting for services to be healthy…"
declare -a CHECKS=(
  "iam-service|http://localhost:8100/api/v1/health"
  "audit-gov|http://localhost:8500/health"
  "agent-runtime|http://localhost:3003/health"
  "agent-service|http://localhost:3001/health"
  "prompt-composer|http://localhost:3004/health"
  "mcp-server|http://localhost:7100/health"
  "context-api|http://localhost:8000/health"
  "workgraph-api|http://localhost:8080/health"
  "platform-web|http://localhost:5180/"
  "platform-agents|http://localhost:5180/agents/studio"
  "platform-workflows|http://localhost:5180/workflows"
  "platform-workbench|http://localhost:5180/workbench"
  "platform-foundry|http://localhost:5180/foundry"
  "platform-identity|http://localhost:5180/identity"
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
  -d "$bootstrap_json" \
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
ok "Demo stack is up. Open Platform Web:"
echo "    ${C_BLUE}http://localhost:5180${C_END}                 unified platform shell"
echo "    http://localhost:5180/agents/studio  Agent Studio"
echo "    http://localhost:5180/workflows      Workflows + Run Insights"
echo "    http://localhost:5180/workbench      Blueprint Workbench"
echo "    http://localhost:5180/foundry        Code Foundry"
echo "    http://localhost:5180/identity       IAM admin"
echo
echo "  Real IAM:    $BOOTSTRAP_EMAIL / configured bootstrap password"
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
