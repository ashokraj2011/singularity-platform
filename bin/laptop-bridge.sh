#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# laptop-bridge.sh — localhost BRIDGE-mode split test.
#
#   ┌─────────────── Docker "box" ───────────────┐        ┌──── host apps ────┐
#   │ context-api · workgraph-api · platform-core │        │ mcp-server (:7100)│
#   │ iam · platform-web · dbs                    │◀──WSS──│  LAPTOP_MODE      │
#   └─────────────────────────────────────────────┘  out  │ llm-gateway(:8001)│
#                  (no mcp-server / no llm-gateway)        └───────────────────┘
#
# The host mcp-server dials OUT to context-api's /api/laptop-bridge/connect, so
# the box never needs to reach the host. Governed runs with prefer_laptop=true
# dispatch tools / chat (model-run) / world-model (code-context) to the host.
#
# Usage:
#   bin/laptop-bridge.sh mint-token <iam-user-id>   # 1. device JWT (sub = user)
#   bin/laptop-bridge.sh box-up                     # 2. core Docker box (no mcp/gw)
#   bin/laptop-bridge.sh box-up                     #    includes Platform Web + Foundry API
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

# Laptop secrets (Copilot BYOK key, GITHUB_TOKEN, model) — same file bin/laptop.sh
# uses, so bridge-mode mcp gets them too without per-terminal exports.
if [ -f .env.laptop ]; then set -a; . ./.env.laptop; set +a; fi

# ── shared config (override via env) ─────────────────────────────────────────
# JWT_SECRET MUST be identical for the box (verifies the device JWT) and the
# mint step (signs it). Default matches docker-compose + IAM + the bridge so the
# one-Mac test works without exporting anything; export your own to change all.
JWT_SECRET="${JWT_SECRET:-changeme_dev_only_min_32_chars_long!!}"
MCP_BEARER_TOKEN="${MCP_BEARER_TOKEN:-demo-bearer-token-must-be-min-16-chars}"
DEVICE_TOKEN_FILE="${DEVICE_TOKEN_FILE:-$ROOT/.singularity/laptop-device-token}"
MCP_WS="${MCP_SANDBOX_ROOT:-$HOME/sg-laptop-workspace}"
LLM_PROVIDER_CONFIG_PATH="${LLM_PROVIDER_CONFIG_PATH:-$ROOT/.singularity/llm-providers.json}"
LLM_MODEL_CATALOG_PATH="${LLM_MODEL_CATALOG_PATH:-$ROOT/.singularity/llm-models.json}"
LAPTOP_BRIDGE_URL="${LAPTOP_BRIDGE_URL:-ws://localhost:8000/api/laptop-bridge/connect}"
LLM_GATEWAY_URL="${LLM_GATEWAY_URL:-http://localhost:8001}"
export JWT_SECRET MCP_BEARER_TOKEN

dc()  { docker compose -f docker-compose.yml -f docker-compose.laptop-bridge.yml "$@"; }
# Direct-HTTP overlay (box calls the host mcp/gateway at host.docker.internal).
dcd() { docker compose -f docker-compose.yml -f docker-compose.laptop-direct.yml "$@"; }
# The three services that carry the Copilot-questions feature code (rebuild these
# after a git pull so the box runs your new code, not a stale image).
FEATURE_SVCS="platform-core context-api workgraph-api platform-web"

# Box services — everything EXCEPT the two host apps (mcp-server, llm-gateway)
# and the laptop-side sandbox runner. --no-deps stops context-api's depends_on
# from pulling the profiled mcp-server / llm-gateway back in.
INFRA="at-postgres wg-postgres wg-minio"
BOOTSTRAP="at-postgres-bootstrap"
CORE_APPS="iam-service platform-core context-api workgraph-api platform-web"

build_app_list() {
  APPS="$CORE_APPS"
  BUILD=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --build) BUILD="--build" ;;
      --with-foundry|--foundry) ;; # retained for compatibility; Code Generation is Workgraph-owned now.
      --with-verifier|--verification) APPS="$APPS formal-verifier" ;;
      --with-compression|--compression) APPS="$APPS prompt-compressor" ;;
      --with-legacy-ui|--legacy-ui) APPS="$APPS workgraph-web blueprint-workbench user-and-capability code-foundry-web portal edge-gateway" ;;
      *) echo "unknown box option: $1" >&2; exit 1 ;;
    esac
    shift
  done
}

# ── commands ─────────────────────────────────────────────────────────────────
cmd_mint_token() {
  local uid="${1:-${BRIDGE_USER_ID:-}}"
  if [ -z "$uid" ]; then
    echo "usage: $0 mint-token <iam-user-id>" >&2
    echo "  <iam-user-id> is the 'sub' of the user who launches runs — it must" >&2
    echo "  match run_context.user_id, or the bridge won't route to this laptop." >&2
    echo "  Find it: log into Platform Web, then decode the JWT 'sub' (jwt.io) or GET /api/v1/me." >&2
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
  build_app_list "$@"
  echo "[box] infra (postgres + minio)…";            dc up -d $INFRA
  echo "[box] seed (at-postgres-bootstrap)…";         dc up -d $BOOTSTRAP
  echo "[box] apps — --no-deps so mcp-server/llm-gateway are NOT started…"
  dc up -d $BUILD --no-deps $APPS
  entry_banner
  echo "Next:  $0 gateway   (terminal 2)   and   $0 mcp   (terminal 3)"
}

entry_banner() {
  echo
  echo "════════════════════════════════════════════════════════════════════"
  echo "  ▶  OPEN THE PLATFORM AT:   http://localhost:5180"
  echo "        /operations · /agents · /workflows · /workbench · /foundry · /identity"
  echo "  Legacy split UIs are debug-only under the frontend-legacy profile."
  echo "════════════════════════════════════════════════════════════════════"
}

cmd_box_down() {
  dc stop $CORE_APPS formal-verifier prompt-compressor workgraph-web blueprint-workbench user-and-capability code-foundry-web portal edge-gateway $BOOTSTRAP $INFRA
  echo "[box] stopped (data kept; 'dc down -v' to wipe)."
}

# Rebuild ONLY the services whose images carry your new code. Run after a git
# pull, then box-up-direct (or box-up) to recreate them.
cmd_rebuild() {
  echo "[rebuild] building $FEATURE_SVCS …"
  dcd build $FEATURE_SVCS
  echo "[rebuild] done — recreate with: $0 box-up-direct"
}

# Fully seed the box (users, capability, prompts, SDLC workflows). Uses the direct
# overlay; prefer_laptop=false to match box-up-direct (mcp-direct/HTTP). Override
# SEED_PREFER_LAPTOP=true if you brought the box up in BRIDGE mode (box-up + mcp).
cmd_seed() {
  COMPOSE_FILES="-f docker-compose.yml -f docker-compose.laptop-direct.yml" \
    SEED_PREFER_LAPTOP="${SEED_PREFER_LAPTOP:-false}" \
    "$(dirname "$0")/seed-docker.sh"
}

# Direct-HTTP box: same services as box-up, but the box calls the HOST mcp +
# gateway at host.docker.internal (docker-compose.laptop-direct.yml). No bridge,
# no device token, no prefer_laptop. --build picks up new feature code.
cmd_box_up_direct() {
  build_app_list "$@"
  echo "[box:direct] infra…"; dcd up -d $INFRA
  echo "[box:direct] seed…";  dcd up -d $BOOTSTRAP
  echo "[box:direct] apps — --build (new code) + --no-deps (no mcp/gateway containers)…"
  dcd up -d ${BUILD:---build} --no-deps $APPS
  entry_banner
  echo "The box calls your host mcp at http://host.docker.internal:7100."
  echo "Next:  $0 gateway   (terminal 2)   and   $0 mcp-direct   (terminal 3)"
}

# Host mcp-server as a NORMAL HTTP server (NOT laptop mode) on :7100 — the box
# reaches it directly. Copilot BYOK (COPILOT_PROVIDER_*) + git creds (GITHUB_TOKEN,
# MCP_GIT_*) inherit from your shell; export them once before running this.
cmd_mcp_direct() {
  mkdir -p "$MCP_WS"
  echo "[mcp-direct] HTTP :7100 (no bridge)   gateway $LLM_GATEWAY_URL   sandbox $MCP_WS"
  echo "[mcp-direct] Copilot provider: ${COPILOT_PROVIDER_TYPE:-<unset — export COPILOT_PROVIDER_* for the SDLC>}"
  cd mcp-server
  export PORT=7100 MCP_BEARER_TOKEN LLM_GATEWAY_URL
  export MCP_COMMAND_EXECUTION_MODE=process
  export MCP_SANDBOX_ROOT="$MCP_WS"
  export MCP_LLM_PROVIDER_CONFIG_PATH="$LLM_PROVIDER_CONFIG_PATH"
  export MCP_LLM_MODEL_CATALOG_PATH="$LLM_MODEL_CATALOG_PATH"
  exec npm run dev
}

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
  printf '── mcp-server (:7100, direct HTTP) … '
  curl -fsS -H "authorization: Bearer $MCP_BEARER_TOKEN" http://localhost:7100/healthz/strict >/dev/null 2>&1 \
    && echo "UP" || echo "DOWN (expected in BRIDGE mode — it runs no HTTP server)"
  printf '── context-api (:8000) … '
  curl -fsS http://localhost:8000/health >/dev/null 2>&1 && echo "UP" || echo "DOWN"
  echo  "── laptop bridge — does the box see the laptop? (BRIDGE mode only)"
  curl -fsS http://localhost:8000/api/laptop-bridge/status 2>/dev/null || echo "   (context-api down, or direct mode / no laptop connected)"
  echo
}

case "${1:-}" in
  mint-token)    shift; cmd_mint_token "$@" ;;
  box-up)        shift; cmd_box_up "$@" ;;          # bridge mode: box (no mcp/gateway)
  box-up-direct) shift; cmd_box_up_direct "$@" ;;   # direct mode: box → host mcp via HTTP
  box-down)      cmd_box_down ;;
  rebuild)       cmd_rebuild ;;         # rebuild the 3 feature-code images after a pull
  seed)          cmd_seed ;;            # seed users + capability + prompts + SDLC workflows
  gateway)       cmd_gateway ;;         # host llm-gateway :8001 (both modes)
  mcp)           cmd_mcp ;;             # host mcp-server, BRIDGE (dials out)
  mcp-direct)    cmd_mcp_direct ;;      # host mcp-server, DIRECT (HTTP :7100)
  status)        cmd_status ;;
  *) echo "usage: $0 {mint-token <iam-user-id>|rebuild|box-up [--build] [--with-foundry] [--with-verifier] [--with-compression] [--with-legacy-ui]|box-up-direct [same opts]|seed|gateway|mcp|mcp-direct|status|box-down}
  bridge mode:  mint-token → box-up        → gateway + mcp
  direct mode:  rebuild    → box-up-direct  → gateway + mcp-direct   (simplest; tests the Copilot-questions feature)" >&2; exit 1 ;;
esac
