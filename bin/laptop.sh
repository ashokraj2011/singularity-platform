#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# laptop.sh — the LAPTOP side: llm-gateway (:8001) and mcp-server (:7100) as
# host apps. Everything else runs in the Docker box (bin/box.sh).
#
#   bin/laptop.sh gateway      llm-gateway :8001          (terminal 2)
#   bin/laptop.sh mcp          mcp-server  :7100, HTTP    (terminal 3)
#   bin/laptop.sh status       are both up?
#
# Secrets/config: put them ONCE in <repo>/.env.laptop (see .env.laptop.example)
# — provider key, Copilot model, GitHub token. The script loads it on every run,
# so no re-exporting per terminal. Shell-exported vars still win.
#
# Built-in preflight (the classic failure modes):
#   • frees a stale process already holding :7100/:8001 (EADDRINUSE)
#   • verifies the `copilot` CLI exists and pins COPILOT_BIN to its absolute
#     path (fixes "spawn copilot ENOENT" from the SDLC copilot stages)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT"

# ── config: .env.laptop (repo root, gitignored) then shell env ───────────────
if [ -f .env.laptop ]; then set -a; . ./.env.laptop; set +a; fi

MCP_BEARER_TOKEN="${MCP_BEARER_TOKEN:-demo-bearer-token-must-be-min-16-chars}"
MCP_WS="${MCP_SANDBOX_ROOT:-$HOME/sg-laptop-workspace}"
LLM_PROVIDER_CONFIG_PATH="${LLM_PROVIDER_CONFIG_PATH:-$ROOT/.singularity/llm-providers.json}"
LLM_MODEL_CATALOG_PATH="${LLM_MODEL_CATALOG_PATH:-$ROOT/.singularity/llm-models.json}"
LLM_GATEWAY_URL="${LLM_GATEWAY_URL:-http://localhost:8001}"

free_port() { # $1 = port — kill whatever stale process holds it (ours in this setup)
  local pids; pids="$(lsof -ti ":$1" 2>/dev/null || true)"
  [ -z "$pids" ] && return 0
  echo "[laptop] :$1 busy (pid $pids) — freeing the stale process…"
  kill $pids 2>/dev/null || true; sleep 1
  pids="$(lsof -ti ":$1" 2>/dev/null || true)"
  [ -n "$pids" ] && { kill -9 $pids 2>/dev/null || true; sleep 1; }
}

case "${1:-}" in
  gateway)
    # Provider keys come from .env.laptop / .env.llm-secrets / your shell.
    if [ -f .env.llm-secrets ]; then set -a; . ./.env.llm-secrets; set +a; fi
    if [ -f context-fabric/.venv/bin/activate ]; then . context-fabric/.venv/bin/activate; fi
    free_port 8001
    echo "[gateway] uvicorn :8001 (providers: $LLM_PROVIDER_CONFIG_PATH)"
    cd context-fabric
    export LLM_PROVIDER_CONFIG_PATH LLM_MODEL_CATALOG_PATH
    export ALLOW_CALLER_PROVIDER_OVERRIDE=false
    exec python3 -m uvicorn services.llm_gateway_service.app.main:app --host 0.0.0.0 --port 8001
    ;;

  mcp)
    # ── preflight: the Copilot CLI must exist for the SDLC copilot stages ────
    COPILOT_BIN="${COPILOT_BIN:-$(command -v copilot || true)}"
    if [ -z "$COPILOT_BIN" ]; then
      echo "[laptop] ✗ 'copilot' CLI not found on PATH." >&2
      echo "         Install it:   npm install -g @github/copilot" >&2
      echo "         (or set COPILOT_BIN=/abs/path/to/copilot in .env.laptop)" >&2
      exit 1
    fi
    if [ "${COPILOT_PROVIDER_TYPE:-}" = "anthropic" ]; then
      case "${COPILOT_PROVIDER_API_KEY:-}" in
        "")           echo "[laptop] ✗ COPILOT_PROVIDER_TYPE=anthropic but COPILOT_PROVIDER_API_KEY is empty — set it in .env.laptop" >&2; exit 1 ;;
        *REPLACE_ME*) echo "[laptop] ✗ COPILOT_PROVIDER_API_KEY is still the .env.laptop.example placeholder — paste your real sk-ant-… key" >&2; exit 1 ;;
        \"*|\'*)      echo "[laptop] ✗ COPILOT_PROVIDER_API_KEY is quoted — remove the quotes (they leak into the auth header → 401)" >&2; exit 1 ;;
      esac
    fi
    free_port 7100
    mkdir -p "$MCP_WS"
    # /healthz/strict requires the sandbox root to be a git working tree
    # (work-item clones nest inside it; nested repos are independent).
    [ -d "$MCP_WS/.git" ] || git -C "$MCP_WS" init -q
    echo "[mcp] HTTP :7100   gateway $LLM_GATEWAY_URL   sandbox $MCP_WS"
    echo "[mcp] copilot: $COPILOT_BIN   provider: ${COPILOT_PROVIDER_TYPE:-<gateway only>}   model: ${COPILOT_MODEL:-default}"
    cd mcp-server
    export PORT=7100 MCP_BEARER_TOKEN LLM_GATEWAY_URL COPILOT_BIN
    export MCP_COMMAND_EXECUTION_MODE=process
    export MCP_SANDBOX_ROOT="$MCP_WS"
    export MCP_LLM_PROVIDER_CONFIG_PATH="$LLM_PROVIDER_CONFIG_PATH"
    export MCP_LLM_MODEL_CATALOG_PATH="$LLM_MODEL_CATALOG_PATH"
    # COPILOT_PROVIDER_* / COPILOT_MODEL / MCP_GIT_* / GITHUB_TOKEN flow through
    # from .env.laptop / the shell to the spawned copilot + git push.
    exec npm run dev
    ;;

  status)
    printf 'llm-gateway :8001 … '; curl -fsS -o /dev/null http://localhost:8001/health && echo OK || echo DOWN
    printf 'mcp-server  :7100 … '
    if curl -fsS -o /dev/null http://localhost:7100/health 2>/dev/null; then
      curl -fsS -o /dev/null -H "authorization: Bearer $MCP_BEARER_TOKEN" http://localhost:7100/healthz/strict 2>/dev/null \
        && echo OK || echo "UP, but strict invariants failing — curl :7100/healthz/strict for which check"
    else
      echo DOWN
    fi
    printf 'copilot CLI       … '; command -v copilot || echo "NOT FOUND (npm install -g @github/copilot)"
    ;;

  *)
    echo "usage: $0 {gateway|mcp|status}" >&2
    echo "  laptop apps for the Docker box (bin/box.sh). Config: .env.laptop" >&2
    exit 1
    ;;
esac
