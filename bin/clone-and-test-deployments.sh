#!/usr/bin/env bash
# Clone Singularity into a separate folder and run deployment smoke tests.
#
# Default matrix:
#   - Docker Compose core
#   - Docker Compose optional runtime profiles
#   - Plain Docker core
#   - Plain Docker core + audit
#
# Bare-metal and runtime-bridge tests are opt-in because they either need a
# host Postgres or long-running foreground MCP/LLM processes.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEFAULT_SOURCE="$(git -C "$ROOT" config --get remote.origin.url 2>/dev/null || printf '%s' "$ROOT")"
SOURCE="$DEFAULT_SOURCE"
REF="${REF:-main}"
TARGET="${TARGET:-$HOME/Downloads/singularity-platform-deploy-test}"
MODES="${MODES:-compose-core,compose-runtime,plain-docker,plain-docker-audit}"
RESET_TARGET=0
SKIP_CLONE=0
COPY_WORKING_TREE=0
KEEP_RUNNING=0
RUN_DEEP=0
BARE_METAL_DB_USER="${BARE_METAL_DB_USER:-postgres}"
BARE_METAL_DB_PASS="${BARE_METAL_DB_PASS:-${PGPASSWORD:-postgres}}"
BARE_METAL_DB_HOST="${BARE_METAL_DB_HOST:-localhost}"
BARE_METAL_DB_PORT="${BARE_METAL_DB_PORT:-5432}"

MARKER=".singularity-deploy-test-target"

log() { printf '[deploy-test] %s\n' "$*"; }
err() { printf '[deploy-test] ERROR: %s\n' "$*" >&2; }

usage() {
  cat <<'USAGE'
Clone Singularity into a separate folder and test deployment options.

Usage:
  bin/clone-and-test-deployments.sh [options]

Options:
  --target <dir>             target clone/copy directory
  --source <url-or-path>     git clone source; default = origin remote
  --ref <branch-or-tag>      branch/tag to checkout; default = main
  --modes <csv|all>          compose-core,compose-runtime,plain-docker,
                             plain-docker-audit,bare-metal,runtime-bridge
  --reset-target             remove target first if it is a prior test target
  --skip-clone               use existing target directory
  --copy-working-tree        copy current working tree instead of git clone
                             useful for testing uncommitted local changes
  --deep                     run deeper doctor/smoke checks where supported
  --keep-running             do not stop the tested stack after each mode

Bare-metal env:
  BARE_METAL_DB_USER=postgres
  BARE_METAL_DB_PASS=postgres
  BARE_METAL_DB_HOST=localhost
  BARE_METAL_DB_PORT=5432

Examples:
  bin/clone-and-test-deployments.sh --target ~/Downloads/sg-test --reset-target
  bin/clone-and-test-deployments.sh --copy-working-tree --target ~/Downloads/sg-dirty-test --reset-target
  bin/clone-and-test-deployments.sh --modes all --target ~/Downloads/sg-all --reset-target
  bin/clone-and-test-deployments.sh --modes bare-metal --skip-clone --target ~/Downloads/sg-test
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --target) TARGET="${2:?missing --target value}"; shift 2 ;;
    --source) SOURCE="${2:?missing --source value}"; shift 2 ;;
    --ref) REF="${2:?missing --ref value}"; shift 2 ;;
    --modes) MODES="${2:?missing --modes value}"; shift 2 ;;
    --reset-target) RESET_TARGET=1; shift ;;
    --skip-clone) SKIP_CLONE=1; shift ;;
    --copy-working-tree) COPY_WORKING_TREE=1; shift ;;
    --deep) RUN_DEEP=1; shift ;;
    --keep-running) KEEP_RUNNING=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) err "unknown option: $1"; usage; exit 1 ;;
  esac
done

if [ "$MODES" = "all" ]; then
  MODES="compose-core,compose-runtime,plain-docker,plain-docker-audit,bare-metal,runtime-bridge"
fi

target_abs() {
  python3 - "$TARGET" <<'PY'
import os, sys
print(os.path.abspath(os.path.expanduser(sys.argv[1])))
PY
}

TARGET="$(target_abs)"

reset_target_if_needed() {
  if [ "$SKIP_CLONE" = "1" ]; then
    [ -d "$TARGET" ] || { err "--skip-clone target does not exist: $TARGET"; exit 1; }
    return
  fi
  if [ -e "$TARGET" ]; then
    if [ "$RESET_TARGET" != "1" ]; then
      err "target exists: $TARGET"
      err "rerun with --reset-target, or choose another --target"
      exit 1
    fi
    if [ ! -f "$TARGET/$MARKER" ]; then
      err "refusing to remove target without marker: $TARGET"
      err "delete it manually or choose a fresh folder"
      exit 1
    fi
    rm -rf "$TARGET"
  fi
}

prepare_target() {
  reset_target_if_needed
  if [ "$SKIP_CLONE" = "1" ]; then
    log "using existing target: $TARGET"
    return
  fi

  if [ "$COPY_WORKING_TREE" = "1" ]; then
    command -v rsync >/dev/null 2>&1 || { err "rsync is required for --copy-working-tree"; exit 1; }
    log "copying current working tree to $TARGET"
    mkdir -p "$TARGET"
    rsync -a \
      --exclude '.git' \
      --exclude '.env' \
      --exclude '.env.*' \
      --exclude '.pids' \
      --exclude '.pids.runtime' \
      --exclude '.venv' \
      --exclude 'node_modules' \
      --exclude '*/node_modules' \
      --exclude 'logs' \
      --exclude '.singularity/laptop-device-token' \
      "$ROOT/" "$TARGET/"
    ( cd "$TARGET" && git init >/dev/null && git add . >/dev/null && git commit -m "deployment test working tree snapshot" >/dev/null 2>&1 || true )
  else
    if [ "$SOURCE" = "$ROOT" ] || [ "$SOURCE" = "file://$ROOT" ]; then
      if ! git -C "$ROOT" diff --quiet || [ -n "$(git -C "$ROOT" ls-files --others --exclude-standard)" ]; then
        log "warning: uncommitted/untracked local changes are not included by git clone"
        log "use --copy-working-tree to test the dirty working tree"
      fi
    fi
    log "cloning $SOURCE#$REF to $TARGET"
    git clone --branch "$REF" "$SOURCE" "$TARGET"
  fi
  touch "$TARGET/$MARKER"
}

in_target() {
  ( cd "$TARGET" && "$@" )
}

cleanup_all() {
  [ -d "$TARGET" ] || return 0
  log "cleanup"
  in_target bash -lc './singularity.sh down >/dev/null 2>&1 || true'
  in_target bash -lc 'bin/docker-core.sh down >/dev/null 2>&1 || true'
  in_target bash -lc 'bin/bare-metal-runtime.sh down >/dev/null 2>&1 || true'
  in_target bash -lc 'bin/bare-metal-apps.sh down >/dev/null 2>&1 || true'
  in_target bash -lc 'bin/laptop-bridge.sh box-down >/dev/null 2>&1 || true'
}

trap 'if [ "$KEEP_RUNNING" != "1" ]; then cleanup_all; fi' EXIT

run_compose_core() {
  log "mode: Docker Compose core"
  cleanup_all
  in_target bash -lc './singularity.sh config init --profile office-laptop'
  in_target bash -lc './singularity.sh config mcp-catalog --default-alias mock'
  in_target bash -lc './singularity.sh config write'
  in_target bash -lc './singularity.sh up'
  in_target bash -lc 'bin/seed-docker.sh'
  in_target bash -lc './singularity.sh doctor'
  if [ "$RUN_DEEP" = "1" ]; then
    in_target bash -lc 'SINGULARITY_DOCTOR_DEEP_SMOKE=1 ./singularity.sh doctor'
  fi
  [ "$KEEP_RUNNING" = "1" ] || in_target bash -lc './singularity.sh down'
}

run_compose_runtime() {
  log "mode: Docker Compose optional MCP/LLM runtime profiles"
  cleanup_all
  in_target bash -lc './singularity.sh config init --profile office-laptop'
  in_target bash -lc './singularity.sh config mcp-catalog --default-alias mock'
  in_target bash -lc './singularity.sh config write'
  in_target bash -lc 'docker compose --profile core --profile llm-gateway --profile mcp up -d'
  in_target bash -lc 'curl -fsS http://localhost:8001/health >/dev/null'
  in_target bash -lc 'curl -fsS http://localhost:7100/health >/dev/null'
  in_target bash -lc './singularity.sh doctor'
  [ "$KEEP_RUNNING" = "1" ] || in_target bash -lc './singularity.sh down'
}

run_plain_docker() {
  log "mode: plain Docker core"
  cleanup_all
  in_target bash -lc 'bin/docker-core.sh up --build'
  in_target bash -lc 'bin/docker-core.sh seed'
  in_target bash -lc 'bin/docker-core.sh smoke'
  [ "$KEEP_RUNNING" = "1" ] || in_target bash -lc 'bin/docker-core.sh nuke --yes'
}

run_plain_docker_audit() {
  log "mode: plain Docker core + audit"
  cleanup_all
  in_target bash -lc 'bin/docker-core.sh up --build --with-audit'
  in_target bash -lc 'bin/docker-core.sh seed --with-audit'
  in_target bash -lc 'bin/docker-core.sh smoke --with-audit'
  [ "$KEEP_RUNNING" = "1" ] || in_target bash -lc 'bin/docker-core.sh nuke --yes'
}

run_bare_metal() {
  log "mode: bare metal apps + runtime"
  cleanup_all
  in_target bash -lc "bin/bare-metal-apps.sh up '$BARE_METAL_DB_USER' '$BARE_METAL_DB_PASS' '$BARE_METAL_DB_HOST' '$BARE_METAL_DB_PORT'"
  in_target bash -lc 'bin/bare-metal-apps.sh smoke'
  if [ "$RUN_DEEP" = "1" ]; then
    in_target bash -lc 'BARE_METAL_DEEP_SMOKE=1 bin/bare-metal-apps.sh smoke'
  fi
  in_target bash -lc 'bin/bare-metal-runtime.sh up'
  in_target bash -lc 'bin/bare-metal-runtime.sh smoke'
  [ "$KEEP_RUNNING" = "1" ] || in_target bash -lc 'bin/bare-metal-runtime.sh down && bin/bare-metal-apps.sh down'
}

run_runtime_bridge() {
  log "mode: runtime bridge one-machine smoke"
  cleanup_all
  in_target bash -lc './singularity.sh config init --profile office-laptop && ./singularity.sh config mcp-catalog --default-alias mock && ./singularity.sh config write'
  in_target bash -lc 'bin/laptop-bridge.sh box-up --build'
  in_target bash -lc 'bin/laptop-bridge.sh mint-token 00000000-0000-0000-0000-000000000001'
  in_target bash -lc 'mkdir -p logs; (bin/laptop-bridge.sh gateway > logs/deploy-test-gateway.log 2>&1 & echo $! > .deploy-test-gateway.pid)'
  in_target bash -lc 'for i in $(seq 1 90); do curl -fsS http://localhost:8001/health >/dev/null 2>&1 && exit 0; sleep 1; done; exit 1'
  in_target bash -lc 'mkdir -p logs; (bin/laptop-bridge.sh mcp > logs/deploy-test-mcp.log 2>&1 & echo $! > .deploy-test-mcp.pid)'
  in_target bash -lc 'source .env.local 2>/dev/null || true; for i in $(seq 1 90); do curl -fsS -H "X-Service-Token: ${CONTEXT_FABRIC_SERVICE_TOKEN:-}" http://localhost:8000/api/runtime-bridge/status | grep -q "\"count\":[[:space:]]*[1-9]" && exit 0; sleep 1; done; curl -s -H "X-Service-Token: ${CONTEXT_FABRIC_SERVICE_TOKEN:-}" http://localhost:8000/api/runtime-bridge/status || true; exit 1'
  if [ "$KEEP_RUNNING" != "1" ]; then
    in_target bash -lc 'kill "$(cat .deploy-test-mcp.pid 2>/dev/null)" "$(cat .deploy-test-gateway.pid 2>/dev/null)" >/dev/null 2>&1 || true'
    in_target bash -lc 'bin/laptop-bridge.sh box-down'
  fi
}

prepare_target

IFS=',' read -r -a mode_list <<< "$MODES"
for mode in "${mode_list[@]}"; do
  mode="$(printf '%s' "$mode" | xargs)"
  case "$mode" in
    compose-core) run_compose_core ;;
    compose-runtime) run_compose_runtime ;;
    plain-docker) run_plain_docker ;;
    plain-docker-audit) run_plain_docker_audit ;;
    bare-metal) run_bare_metal ;;
    runtime-bridge) run_runtime_bridge ;;
    "") ;;
    *) err "unknown mode: $mode"; exit 1 ;;
  esac
done

log "deployment matrix complete in $TARGET"
