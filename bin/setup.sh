#!/usr/bin/env bash
#
# setup.sh — interactive one-shot Singularity (bare-metal) setup.
#
# Asks a handful of questions (Postgres + LLM), then does everything:
#   • brings the whole stack up via bin/bare-metal.sh (DBs, deps, schema, seed,
#     boot — incl. the demo workflows/artifacts),
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
#                           # (also offered as a prompt in interactive mode)
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

ASSUME_YES=0; RESET_DB=0
for arg in "$@"; do
  case "$arg" in
    --yes|-y)      ASSUME_YES=1 ;;
    --reset|--fresh) RESET_DB=1 ;;
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
echo "${C_D}One command sets up Postgres + the full stack + (optionally) your LLM bridge.${C_E}"
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
  bin/bare-metal.sh down >/dev/null 2>&1 || true
  if ! bin/bare-metal.sh reset-db "$PG_USER" "$PG_PASS" "$PG_HOST" "$PG_PORT"; then
    err "reset-db failed — see output above"; exit 1
  fi
fi

# ── 1. bring up the whole stack ──────────────────────────────────────────────
echo
info "bringing up the stack — this installs deps, pushes schema, seeds, and boots all services…"
if ! bin/bare-metal.sh up "$PG_USER" "$PG_PASS" "$PG_HOST" "$PG_PORT"; then
  err "bin/bare-metal.sh up failed — see the output above + logs/"
  exit 1
fi

# ── 2. point the LLM gateway at the bridge (optional) ────────────────────────
if [ "$LLM_MODE" = "bridge" ]; then
  echo
  info "pointing the LLM gateway at ${LLM_URL} (${LLM_MODEL})…"
  # llm-use-copilot.sh flips providers + every alias to the bridge. Its built-in
  # restart is Docker-aware; on bare-metal it may report a non-fatal Docker
  # error AFTER writing the config — we restart the gateway ourselves below so
  # this works regardless of which version of that script is present.
  bin/llm-use-copilot.sh --base-url "$LLM_URL" --model "$LLM_MODEL" --token "$LLM_TOKEN" \
    || warn "llm-use-copilot reported a non-fatal error (likely the Docker step) — restarting the gateway directly"
  # shellcheck source=/dev/null
  set -a; [ -f "$ROOT/.env.local" ] && . "$ROOT/.env.local"; [ -f "$ROOT/.env.llm-secrets" ] && . "$ROOT/.env.llm-secrets"; set +a
  PYBIN="$ROOT/.venv/bin/python"; [ -x "$PYBIN" ] || PYBIN=python3
  lsof -ti :8001 2>/dev/null | xargs kill -9 2>/dev/null || true
  ( cd "$ROOT/context-fabric" && \
      LLM_PROVIDER_CONFIG_PATH="${LLM_PROVIDER_CONFIG_PATH:-$ROOT/.singularity/llm-providers.json}" \
      LLM_MODEL_CATALOG_PATH="${LLM_MODEL_CATALOG_PATH:-$ROOT/.singularity/llm-models.json}" \
      COPILOT_TOKEN="${COPILOT_TOKEN:-$LLM_TOKEN}" ALLOW_CALLER_PROVIDER_OVERRIDE=false \
      nohup "$PYBIN" -m uvicorn services.llm_gateway_service.app.main:app --host 0.0.0.0 --port 8001 \
      > "$ROOT/logs/llm-gateway.log" 2>&1 & )
  sleep 4
  if curl -s -m 4 localhost:8001/llm/providers 2>/dev/null | grep -q '"default_provider": *"copilot"'; then
    ok "LLM gateway now serving copilot/${LLM_MODEL}"
  else
    warn "gateway didn't confirm copilot — check logs/llm-gateway.log and 'curl :8001/llm/providers'"
  fi
fi

# ── 3. smoke + URLs ──────────────────────────────────────────────────────────
echo
info "smoke check…"
bin/bare-metal.sh smoke || warn "some services aren't healthy yet — give them a few seconds, then re-run 'bin/bare-metal.sh smoke'"

echo
ok "setup complete. Open:"
echo "    http://localhost:5180   portal (operations + launcher)"
echo "    http://localhost:5176   blueprint workbench (SDLC / bug-fix loops)"
echo "    http://localhost:5174   workgraph (designer, runs, insights)"
echo "    http://localhost:3000   agent studio (/audit, /cost)"
echo "    http://localhost:5175   IAM admin + governance authoring"
echo "    http://localhost:8100   IAM API  (admin@singularity.local / Admin1234!)"
echo
echo "${C_D}re-run anytime: bin/setup.sh (reuses your answers) · stop: bin/bare-metal.sh down · LLM status: curl :8001/llm/providers${C_E}"
echo "${C_D}preflight check: bin/doctor.sh  (verifies services, cross-app env, seeds, auth — and prints fixes; --fix appends missing env keys)${C_E}"
