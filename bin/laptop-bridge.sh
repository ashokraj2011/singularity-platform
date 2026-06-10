#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# laptop-bridge.sh — localhost BRIDGE-mode split test.
#
#   ┌─────────────── Docker "box" ───────────────┐        ┌──── host apps ────┐
#   │ context-api · workgraph-api · agent-runtime │        │ mcp-server (:7100)│
#   │ prompt-composer · iam · UIs · postgres …    │◀──WSS──│  LAPTOP_MODE      │
#   └─────────────────────────────────────────────┘  out  │ llm-gateway(:8001)│
#                  (no mcp-server / no llm-gateway)        └───────────────────┘
#
# The host mcp-server dials OUT to context-api's /api/laptop-bridge/connect, so
# the box never needs to reach the host. Governed runs with prefer_laptop=true
# dispatch tools / chat (model-run) / world-model (code-context) to the host.
#
# Usage:
#   bin/laptop-bridge.sh mint-token <iam-user-id>   # 1. device JWT (sub = user)
#   bin/laptop-bridge.sh box-up                     # 2. Docker box (no mcp/gw)
#   bin/laptop-bridge.sh gateway                     # 3. host llm-gateway :8001
#   bin/laptop-bridge.sh mcp                         # 4. host mcp-server (bridge)
#   bin/laptop-bridge.sh status                      #    health + bridge status
#   bin/laptop-bridge.sh box-down                    #    stop the box
#
# Run gateway + mcp in their own terminals (they stay in the foreground).
# See docs/laptop-bridge-localhost-test.md for the full walkthrough.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# ── shared config (override via env) ─────────────────────────────────────────
# JWT_SECRET MUST be identical for the box (verifies the device JWT) and the
# mint step (signs it). Default is a dev value; export your own to change both.
JWT_SECRET="${JWT_SECRET:-dev-laptop-bridge-secret-min-32-chars!!}"
MCP_BEARER_TOKEN="${MCP_BEARER_TOKEN:-demo-bearer-token-must-be-min-16-chars}"
DEVICE_TOKEN_FILE="${DEVICE_TOKEN_FILE:-$ROOT/.singularity/laptop-device-token}"
MCP_WS="${MCP_SANDBOX_ROOT:-$HOME/sg-laptop-workspace}"
LLM_PROVIDER_CONFIG_PATH="${LLM_PROVIDER_CONFIG_PATH:-$ROOT/.singularity/llm-providers.json}"
LLM_MODEL_CATALOG_PATH="${LLM_MODEL_CATALOG_PATH:-$ROOT/.singularity/llm-models.json}"
LAPTOP_BRIDGE_URL="${LAPTOP_BRIDGE_URL:-ws://localhost:8000/api/laptop-bridge/connect}"
LLM_GATEWAY_URL="${LLM_GATEWAY_URL:-http://localhost:8001}"
export JWT_SECRET MCP_BEARER_TOKEN

dc() { docker compose -f docker-compose.yml -f docker-compose.laptop-bridge.yml "$@"; }

# Box services — everything EXCEPT the two host apps (mcp-server, llm-gateway)
# and the laptop-side sandbox runner. --no-deps stops context-api's depends_on
# from pulling the profiled mcp-server / llm-gateway back in.
INFRA="iam-postgres at-postgres wg-postgres wg-minio"
BOOTSTRAP="at-postgres-bootstrap"
APPS="iam-service context-memory context-api formal-verifier agent-service tool-service agent-runtime prompt-composer workgraph-api workgraph-web blueprint-workbench user-and-capability agent-web portal edge-gateway"

# ── commands ─────────────────────────────────────────────────────────────────
cmd_mint_token() {
  local uid="${1:-${BRIDGE_USER_ID:-}}"
  if [ -z "$uid" ]; then
    echo "usage: $0 mint-token <iam-user-id>" >&2
    echo "  <iam-user-id> is the 'sub' of the user who launches runs — it must" >&2
    echo "  match run_context.user_id, or the bridge won't route to this laptop." >&2
    echo "  Find it: log into the portal, then the JWT 'sub' (jwt.io) or GET /api/v1/me." >&2
    exit 1
  fi
  mkdir -p "$(dirname "$DEVICE_TOKEN_FILE")"
  JWT_SECRET="$JWT_SECRET" SUB="$uid" node -e '
    const c = require("crypto");
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const { JWT_SECRET, SUB } = process.env;
    const now = Math.floor(Date.now() / 1000);
    const head = b64({ alg: "HS256", typ: "JWT" });
    const body = b64({
      kind: "device", sub: SUB,
      device_id: "laptop-test-" + SUB, device_name: "mcp-laptop-test",
      iat: now, exp: now + 90 * 24 * 3600,
    });
    const sig = c.createHmac("sha256", JWT_SECRET).update(head + "." + body).digest("base64url");
    process.stdout.write(head + "." + body + "." + sig);
  ' > "$DEVICE_TOKEN_FILE"
  chmod 600 "$DEVICE_TOKEN_FILE"
  echo "minted device JWT (kind=device, sub=$uid, 90d) → $DEVICE_TOKEN_FILE"
}

cmd_box_up() {
  echo "[box] infra (postgres + minio)…";            dc up -d $INFRA
  echo "[box] seed (at-postgres-bootstrap)…";         dc up -d $BOOTSTRAP
  echo "[box] apps — --no-deps so mcp-server/llm-gateway are NOT started…"
  dc up -d --no-deps $APPS
  echo
  echo "[box] up:  context-api http://localhost:8000   portal http://localhost:5180"
  echo "           workflow   http://localhost:5174    edge   http://localhost:8085"
  echo "Next:  $0 gateway   (terminal 2)   and   $0 mcp   (terminal 3)"
}

cmd_box_down() { dc stop $APPS $BOOTSTRAP $INFRA; echo "[box] stopped (data kept; 'dc down -v' to wipe)."; }

cmd_gateway() {
  # Provider keys (ANTHROPIC_API_KEY / COPILOT_TOKEN / …) come from
  # .env.llm-secrets or your shell — never hard-coded here.
  if [ -f .env.llm-secrets ]; then set -a; . ./.env.llm-secrets; set +a; fi
  if [ -f context-fabric/.venv/bin/activate ]; then . context-fabric/.venv/bin/activate; fi
  echo "[gateway] uvicorn :8001 (provider config: $LLM_PROVIDER_CONFIG_PATH)"
  cd context-fabric
  export LLM_PROVIDER_CONFIG_PATH LLM_MODEL_CATALOG_PATH
  export ALLOW_CALLER_PROVIDER_OVERRIDE=false
  exec python3 -m uvicorn services.llm_gateway_service.app.main:app --host 0.0.0.0 --port 8001
}

cmd_mcp() {
  if [ ! -f "$DEVICE_TOKEN_FILE" ]; then
    echo "no device token at $DEVICE_TOKEN_FILE — run: $0 mint-token <iam-user-id>" >&2
    exit 1
  fi
  mkdir -p "$MCP_WS"
  echo "[mcp] LAPTOP_MODE → $LAPTOP_BRIDGE_URL   gateway $LLM_GATEWAY_URL   sandbox $MCP_WS"
  cd mcp-server
  # Required bridge + runtime env. COPILOT_* / GITHUB_TOKEN / MCP_GIT_* inherit
  # from your shell (export them once) and pass straight through to npm run dev.
  export LAPTOP_MODE=true
  export LAPTOP_BRIDGE_URL SINGULARITY_DEVICE_NAME="mcp-laptop-test"
  export SINGULARITY_DEVICE_TOKEN="$(cat "$DEVICE_TOKEN_FILE")"
  export JWT_SECRET PORT=7100 MCP_BEARER_TOKEN LLM_GATEWAY_URL
  export MCP_COMMAND_EXECUTION_MODE=process
  export MCP_SANDBOX_ROOT="$MCP_WS"
  export MCP_LLM_PROVIDER_CONFIG_PATH="$LLM_PROVIDER_CONFIG_PATH"
  export MCP_LLM_MODEL_CATALOG_PATH="$LLM_MODEL_CATALOG_PATH"
  exec npm run dev
}

cmd_status() {
  printf '── llm-gateway (:8001) … '
  curl -fsS http://localhost:8001/health >/dev/null 2>&1 && echo "UP" || echo "DOWN"
  printf '── context-api (:8000) … '
  curl -fsS http://localhost:8000/health >/dev/null 2>&1 && echo "UP" || echo "DOWN"
  echo  "── laptop bridge — does the box see the laptop?"
  curl -fsS http://localhost:8000/api/laptop-bridge/status 2>/dev/null || echo "   (context-api down, or no laptop connected yet)"
  echo
}

case "${1:-}" in
  mint-token) shift; cmd_mint_token "$@" ;;
  box-up)     cmd_box_up ;;
  box-down)   cmd_box_down ;;
  gateway)    cmd_gateway ;;
  mcp)        cmd_mcp ;;
  status)     cmd_status ;;
  *) echo "usage: $0 {mint-token <iam-user-id>|box-up|gateway|mcp|status|box-down}" >&2; exit 1 ;;
esac
