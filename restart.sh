#!/usr/bin/env bash
# Free all Singularity dev ports and restart the docker-compose stack.
#
# Usage:
#   ./restart.sh              # free ports + docker down/up
#   ./restart.sh --no-docker  # only free ports (use when running services locally)
#   ./restart.sh --ports-only # alias of --no-docker

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

C_BLUE=$'\033[1;34m'
C_GREEN=$'\033[1;32m'
C_YELLOW=$'\033[1;33m'
C_RED=$'\033[1;31m'
C_DIM=$'\033[2m'
C_END=$'\033[0m'

info()  { echo -e "${C_BLUE}▸${C_END} $*"; }
ok()    { echo -e "${C_GREEN}✓${C_END} $*"; }
warn()  { echo -e "${C_YELLOW}!${C_END} $*"; }
err()   { echo -e "${C_RED}✗${C_END} $*" >&2; }

# Application ports (UIs + APIs). Storage ports (5432/5433/5434/9000/9001)
# are intentionally excluded — docker-compose owns those.
PORTS=(
  3000   # agent-web (Next.js)
  3001   # agent-service
  3002   # tool-service
  3003   # agent-runtime
  3004   # prompt-composer
  5174   # workgraph-web
  5175   # user-and-capability
  5176   # blueprint-workbench
  5180   # portal
  7000   # mcp-server (local dev default)
  7100   # mcp-server-demo
  8000   # context-api
  8001   # llm-gateway
  8002   # context-memory
  8003   # metrics-ledger
  8010   # formal-verifier
  8080   # workgraph-api
  8100   # iam-service
)

free_port() {
  local port=$1
  # lsof -ti :PORT returns PIDs of processes listening on that port (TCP).
  local pids
  pids=$(lsof -ti tcp:"$port" -sTCP:LISTEN 2>/dev/null || true)
  if [ -z "$pids" ]; then
    return 0
  fi
  for pid in $pids; do
    local cmd
    cmd=$(ps -p "$pid" -o comm= 2>/dev/null || echo "?")
    info "  port $port: killing pid=$pid ($cmd)"
    kill "$pid" 2>/dev/null || true
  done
  # Give them a beat to exit gracefully, then SIGKILL stragglers.
  sleep 1
  pids=$(lsof -ti tcp:"$port" -sTCP:LISTEN 2>/dev/null || true)
  if [ -n "$pids" ]; then
    for pid in $pids; do
      warn "  port $port: pid=$pid did not exit; SIGKILL"
      kill -9 "$pid" 2>/dev/null || true
    done
  fi
}

free_all_ports() {
  info "freeing dev ports …"
  local any_freed=0
  for port in "${PORTS[@]}"; do
    if lsof -ti tcp:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      free_port "$port"
      any_freed=1
    fi
  done
  if [ $any_freed -eq 0 ]; then
    ok "no listeners found on any tracked port."
  else
    ok "ports freed."
  fi
}

docker_down() {
  if ! command -v docker >/dev/null 2>&1; then
    warn "docker not on PATH; skipping docker stop"
    return
  fi
  if ! docker compose version >/dev/null 2>&1; then
    warn "docker compose v2 not available; skipping docker stop"
    return
  fi
  info "stopping master docker-compose stack …"
  docker compose down --remove-orphans 2>/dev/null || warn "docker compose down returned non-zero"
  if [ -d audit-governance-service ]; then
    info "stopping audit-governance stack …"
    ( cd audit-governance-service && docker compose down --remove-orphans 2>/dev/null ) || true
  fi
  ok "docker stack down."
}

docker_up() {
  if ! command -v docker >/dev/null 2>&1; then
    warn "docker not on PATH; skipping docker start"
    return
  fi
  if ! docker compose version >/dev/null 2>&1; then
    warn "docker compose v2 not available; skipping docker start"
    return
  fi
  # Docker Desktop scrubs certain AI provider keys (notably ANTHROPIC_API_KEY)
  # from .env file substitution but does NOT scrub values present in the shell
  # environment. Source .env into this shell so compose picks the real values
  # via ${VAR:-} expansion. Use `set -a` to auto-export each loaded variable.
  if [ -f .env ]; then
    info "loading .env into shell (workaround for Docker Desktop key scrubbing) …"
    set -a
    # shellcheck disable=SC1091
    . ./.env
    set +a
  fi
  # On macOS, $SSH_AUTH_SOCK points at a launchd-managed socket
  # (/private/var/run/com.apple.launchd.XXX/Listeners) that Docker Desktop
  # cannot bind-mount. mcp-server-demo's compose entry falls back to /dev/null
  # when SSH_AUTH_SOCK is empty, so clear it for the docker invocation. Dev
  # mode defaults to MCP_GIT_PUSH_ENABLED=false, so no SSH agent is needed.
  info "starting master docker-compose stack …"
  SSH_AUTH_SOCK="" docker compose up -d
  if [ -d audit-governance-service ]; then
    info "starting audit-governance stack …"
    ( cd audit-governance-service && SSH_AUTH_SOCK="" docker compose up -d ) || warn "audit-governance up failed"
  fi
  ok "docker stack up. Tail logs with: ./singularity.sh logs <service> -f"
}

mode=${1:-full}
case "$mode" in
  --no-docker|--ports-only)
    free_all_ports
    ok "done (ports-only mode). Start your local services manually."
    ;;
  ""|full|--full)
    docker_down
    free_all_ports
    docker_up
    ok "restart complete. ./singularity.sh urls for the address list."
    ;;
  -h|--help|help)
    grep -E '^# ' "$0" | sed 's/^# //'
    ;;
  *)
    err "unknown flag: $mode"
    echo "Run \`$0 --help\` for usage."
    exit 1
    ;;
esac
