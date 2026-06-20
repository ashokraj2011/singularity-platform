#!/usr/bin/env bash
#
# setup.sh — interactive one-shot Singularity (bare-metal) setup.
#
# Asks a handful of questions (Postgres + LLM), then does everything:
#   • brings the bare-metal platform apps up via bin/bare-metal-apps.sh
#     (DBs, deps, schema, seed, boot — incl. demo workflows/artifacts),
#   • optionally starts local runtime infra via bin/bare-metal-runtime.sh
#     (llm-gateway + mcp-server),
#   • optionally points the LLM gateway at an OpenAI-compatible bridge
#     (Copilot/openai-compat) and restarts it,
#   • smoke-checks and prints the URLs.
#
# Answers persist to .singularity/setup.conf, so re-runs reuse them. Pass --yes
# to skip the prompts entirely (use the saved file / built-in defaults) — handy
# for scripted/repeat setups.
#
# Usage:
#   bin/setup.sh            # interactive
#   bin/setup.sh --yes      # non-interactive (saved answers or defaults)
#   bin/setup.sh --reset    # DROP existing databases first, then set up fresh
#   bin/setup.sh --box-only # only start platform apps; skip local runtime infra
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"
CONF="$ROOT/.singularity/setup.conf"
mkdir -p "$ROOT/.singularity" "$ROOT/logs"

C_B=$'\033[1;34m'; C_G=$'\033[1;32m'; C_Y=$'\033[1;33m'; C_R=$'\033[1;31m'; C_D=$'\033[2m'; C_E=$'\033[0m'
info() { echo "${C_B}▸${C_E} $*"; }
ok()   { echo "${C_G}✓${C_E} $*"; }
warn() { echo "${C_Y}!${C_E} $*"; }
err()  { echo "${C_R}✗${C_E} $*" >&2; }

ASSUME_YES=0; RESET_DB=0; BOX_ONLY_MODE="${BOX_ONLY:-}"
for arg in "$@"; do
  case "$arg" in
    --yes|-y)      ASSUME_YES=1 ;;
    --reset|--fresh) RESET_DB=1 ;;
    --box-only)    BOX_ONLY_MODE=1 ;;
    -h|--help)     grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) err "unknown arg: $arg (try --help)"; exit 1 ;;
  esac
done

# ── defaults (overridden by saved answers, then prompts) ─────────────────────
PG_USER="${USER:-postgres}"; PG_PASS="postgres"; PG_HOST="localhost"; PG_PORT="5432"
LLM_MODE="mock"                                  # mock | bridge
LLM_URL="http://localhost:4141/v1"               # OpenAI-compatible base (ends in /v1)
LLM_MODEL="gpt-4o"                               # safe default; works on virtually all Copilot plans
LLM_TOKEN="copilot-local"

if [ -f "$CONF" ]; then info "loading saved answers from .singularity/setup.conf"; . "$CONF"; fi

ask() { # ask VAR "label"
  local var="$1" label="$2" cur="${!1}"
  [ "$ASSUME_YES" = "1" ] && return 0
  local ans; printf "  %s [%s]: " "$label" "$cur"; read -r ans || true
  [ -n "$ans" ] && printf -v "$var" '%s' "$ans"
  return 0
}

echo "${C_B}Singularity — interactive setup${C_E}"
echo "${C_D}One command sets up Postgres + the platform stack + optional local/remote runtime wiring.${C_E}"
echo
echo "Postgres ${C_D}(needs PG 16 + pgvector running; the role must be able to log in — usually your macOS user, not 'postgres')${C_E}"
ask PG_USER "user"
ask PG_PASS "password"
ask PG_HOST "host"
ask PG_PORT "port"

echo
echo "LLM provider ${C_D}(mock = offline/no key; bridge = an OpenAI-compatible server like copilot-api)${C_E}"
if [ "$ASSUME_YES" != "1" ]; then
  printf "  use an LLM bridge? [y/N] (current: %s): " "$LLM_MODE"; read -r yn || true
  case "${yn:-}" in [yY]*) LLM_MODE="bridge" ;; [nN]*) LLM_MODE="mock" ;; "") : ;; esac
fi
if [ "$LLM_MODE" = "bridge" ]; then
  ask LLM_URL   "bridge base URL (must end in /v1)"
  ask LLM_MODEL "model (gpt-4o is safe; note: copilot-api LISTS claude-*/gpt-5/gemini but your plan may reject them with 'model_not_supported')"
  ask LLM_TOKEN "token (any value if the bridge ignores auth)"
fi

# ── persist answers (gitignored; holds pg password + llm token) ──────────────
umask 077
cat > "$CONF" <<EOF
PG_USER="$PG_USER"
PG_PASS="$PG_PASS"
PG_HOST="$PG_HOST"
PG_PORT="$PG_PORT"
LLM_MODE="$LLM_MODE"
LLM_URL="$LLM_URL"
LLM_MODEL="$LLM_MODEL"
LLM_TOKEN="$LLM_TOKEN"
EOF
ok "saved answers → .singularity/setup.conf"

# ── quick Postgres reachability check (friendlier than a mid-up failure) ─────
if command -v psql >/dev/null 2>&1; then
  if ! PGPASSWORD="$PG_PASS" psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d postgres -tAc 'select 1' >/dev/null 2>&1; then
    err "can't connect to Postgres as ${PG_USER}@${PG_HOST}:${PG_PORT}."
    err "start it (e.g. 'brew services start postgresql@16') and make sure role '${PG_USER}' can log in, then re-run."
    exit 1
  fi
  ok "Postgres reachable as ${PG_USER}@${PG_HOST}:${PG_PORT}"
fi

# ── optional clean slate: drop existing databases first ──────────────────────
if [ "$RESET_DB" != "1" ] && [ "$ASSUME_YES" != "1" ]; then
  printf "  drop existing databases for a clean start? (DESTRUCTIVE) [y/N]: "; read -r dr || true
  case "${dr:-}" in [yY]*) RESET_DB=1 ;; esac
fi
if [ "$RESET_DB" = "1" ]; then
  warn "clean start: stopping services + dropping all platform databases…"
  bin/bare-metal-runtime.sh down >/dev/null 2>&1 || true
  bin/bare-metal-apps.sh down >/dev/null 2>&1 || true
  if ! bin/bare-metal.sh reset-db "$PG_USER" "$PG_PASS" "$PG_HOST" "$PG_PORT"; then
    err "reset-db failed — see output above"; exit 1
  fi
fi

# ── 1. bring up the platform apps ────────────────────────────────────────────
echo
if [ "$BOX_ONLY_MODE" = "1" ]; then
  info "bringing up platform apps — local llm-gateway and MCP are skipped…"
else
  info "bringing up platform apps — this installs deps, pushes schema, seeds, and boots app services…"
fi
if [ "$BOX_ONLY_MODE" = "1" ]; then
  bin/bare-metal-apps.sh up "$PG_USER" "$PG_PASS" "$PG_HOST" "$PG_PORT"
  app_up_status=$?
else
  bin/bare-metal-apps.sh up "$PG_USER" "$PG_PASS" "$PG_HOST" "$PG_PORT"
  app_up_status=$?
fi
if [ "$app_up_status" != "0" ]; then
  err "bin/bare-metal-apps.sh up failed — see the output above + logs/"
  exit 1
fi

# ── 2. bring up local runtime infra unless this is a box-only install ────────
if [ "$BOX_ONLY_MODE" != "1" ]; then
  echo
  info "bringing up local runtime infrastructure — llm-gateway + MCP…"
  if ! bin/bare-metal-runtime.sh up; then
    err "bin/bare-metal-runtime.sh up failed — see the output above + logs/"
    exit 1
  fi
fi

# ── 3. point the LLM gateway at the bridge (optional) ────────────────────────
if [ "$LLM_MODE" = "bridge" ] && [ "$BOX_ONLY_MODE" != "1" ]; then
  echo
  info "pointing the LLM gateway at ${LLM_URL} (${LLM_MODEL})…"
  # llm-use-copilot.sh flips providers + aliases to the bridge and restarts the
  # gateway through Docker or the split bare-metal runtime PID file. If an older
  # or partially configured environment reports a non-fatal restart issue, fall
  # back to a clean runtime restart.
  if ! bin/llm-use-copilot.sh --base-url "$LLM_URL" --model "$LLM_MODEL" --token "$LLM_TOKEN"; then
    warn "llm-use-copilot reported an error after writing config — restarting runtime directly"
    bin/bare-metal-runtime.sh down >/dev/null 2>&1 || true
    bin/bare-metal-runtime.sh up || warn "runtime restart failed — check logs/llm-gateway.log"
  fi
  sleep 4
  if curl -s -m 4 localhost:8001/llm/providers 2>/dev/null | grep -q '"default_provider": *"copilot"'; then
    ok "LLM gateway now serving copilot/${LLM_MODEL}"
  else
    warn "gateway didn't confirm copilot — check logs/llm-gateway.log and 'curl :8001/llm/providers'"
  fi
fi
if [ "$LLM_MODE" = "bridge" ] && [ "$BOX_ONLY_MODE" = "1" ]; then
  warn "LLM bridge config saved, but --box-only leaves the local gateway/MCP to the laptop or remote runtime."
fi

# ── 4. smoke + URLs ──────────────────────────────────────────────────────────
echo
info "platform app smoke check…"
bin/bare-metal-apps.sh smoke || warn "some platform services aren't healthy yet — give them a few seconds, then re-run 'bin/bare-metal-apps.sh smoke'"
if [ "$BOX_ONLY_MODE" != "1" ]; then
  info "runtime infra smoke check…"
  bin/bare-metal-runtime.sh smoke || warn "runtime infra is not healthy yet — give it a few seconds, then re-run 'bin/bare-metal-runtime.sh smoke'"
fi

echo
ok "setup complete. Open:"
echo "    http://localhost:5180                unified platform web"
echo "    http://localhost:5180/operations     operations + readiness"
echo "    http://localhost:5180/agents/studio  Agent Studio"
echo "    http://localhost:5180/workflows      workflows, runs, insights"
echo "    http://localhost:5180/workbench      Blueprint Workbench"
echo "    http://localhost:5180/foundry        Code Foundry"
echo "    http://localhost:5180/identity       IAM admin + governance authoring"
echo "    http://localhost:8100   IAM API  (bootstrap login from ./singularity.sh config show)"
echo
echo "${C_D}re-run anytime: bin/setup.sh (reuses your answers) · stop apps: bin/bare-metal-apps.sh down · stop runtime: bin/bare-metal-runtime.sh down${C_E}"
echo "${C_D}LLM status: curl :8001/llm/providers  # when local runtime is running${C_E}"
echo "${C_D}deep UI/API parity: BARE_METAL_DEEP_SMOKE=1 bin/bare-metal-apps.sh smoke  # routes + APIs + browser hydration + audit/Workbench/workflow/Foundry/Agent Studio${C_E}"
echo "${C_D}preflight check: bin/doctor.sh  (verifies services, cross-app env, seeds, auth — and prints fixes; --fix appends missing env keys)${C_E}"
