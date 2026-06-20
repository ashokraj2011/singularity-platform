#!/usr/bin/env bash
# Free all Singularity dev ports and restart the docker-compose stack.
#
# Usage:
#   ./restart.sh              # free core ports + docker down/up core
#   ./restart.sh --profile p  # restart core plus an optional compose profile
#   ./restart.sh --full       # restart the historical all-local stack
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
# are intentionally excluded — docker-compose owns those. Runtime infra ports
# are optional so we do not kill a laptop/remote gateway by default.
CORE_PORTS=(
  3000   # legacy/dev Next port
  3001   # platform-core compatibility port: agent-service
  3002   # platform-core compatibility port: tool-service
  3003   # platform-core compatibility port: agent-runtime
  3004   # platform-core compatibility port: prompt-composer
  3005   # code-foundry-api
  5180   # platform-web
  8000   # context-api
  8080   # workgraph-api
  8100   # iam-service
)
OPTIONAL_PORTS=(5174 5175 5176 5182 7000 7100 8001 8002 8003 8010 8011 8101 8500)
PORTS=("${CORE_PORTS[@]}")

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
    case "$cmd" in
      *docker*|*Docker*|*vpnkit*)
        warn "  port $port: leaving Docker-owned listener pid=$pid ($cmd)"
        continue
        ;;
    esac
    info "  port $port: killing pid=$pid ($cmd)"
    kill "$pid" 2>/dev/null || true
  done
  # Give them a beat to exit gracefully, then SIGKILL stragglers.
  sleep 1
  pids=$(lsof -ti tcp:"$port" -sTCP:LISTEN 2>/dev/null || true)
  if [ -n "$pids" ]; then
    for pid in $pids; do
      local cmd
      cmd=$(ps -p "$pid" -o comm= 2>/dev/null || echo "?")
      case "$cmd" in
        *docker*|*Docker*|*vpnkit*) continue ;;
      esac
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
  # cannot bind-mount. mcp-server's compose entry falls back to /dev/null
  # when SSH_AUTH_SOCK is empty, so clear it for the docker invocation. Dev
  # mode defaults to MCP_GIT_PUSH_ENABLED=false, so no SSH agent is needed.
  if [ "$RESTART_FULL" = "1" ]; then
    info "starting full local stack …"
  else
    info "starting core docker-compose stack …"
  fi
  SSH_AUTH_SOCK="" ./singularity.sh up "${SINGULARITY_UP_ARGS[@]}"
  ok "docker stack up. Tail logs with: ./singularity.sh logs <service> -f"
}

RESTART_FULL=0
SINGULARITY_UP_ARGS=()
mode="core"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --full|full)
      RESTART_FULL=1
      SINGULARITY_UP_ARGS+=(--full)
      PORTS+=("${OPTIONAL_PORTS[@]}")
      ;;
    --profile)
      shift
      profile="${1:?usage: $0 --profile <name>}"
      SINGULARITY_UP_ARGS+=(--profile "$profile")
      case "$profile" in
        llm-gateway|gateway-only|composer-only) PORTS+=(8001) ;;
        mcp) PORTS+=(7000 7100) ;;
        foundry|code-foundry) PORTS+=(3005) ;;
        verification) PORTS+=(8010) ;;
        compression) PORTS+=(8011) ;;
        frontend-legacy) PORTS+=(5174 5175 5176 5182 8085) ;;
        audit) PORTS+=(8500) ;;
      esac
      ;;
    --profile=*)
      profile="${1#--profile=}"
      SINGULARITY_UP_ARGS+=(--profile "$profile")
      case "$profile" in
        llm-gateway|gateway-only|composer-only) PORTS+=(8001) ;;
        mcp) PORTS+=(7000 7100) ;;
        foundry|code-foundry) PORTS+=(3005) ;;
        verification) PORTS+=(8010) ;;
        compression) PORTS+=(8011) ;;
        frontend-legacy) PORTS+=(5174 5175 5176 5182 8085) ;;
        audit) PORTS+=(8500) ;;
      esac
      ;;
    --with-llm-gateway|--llm-gateway)
      SINGULARITY_UP_ARGS+=(--profile llm-gateway)
      PORTS+=(8001)
      ;;
    --with-mcp|--mcp)
      SINGULARITY_UP_ARGS+=(--profile mcp)
      PORTS+=(7000 7100)
      ;;
    --no-docker|--ports-only|help|--help|-h|"")
      mode="$1"
      ;;
    *)
      err "unknown flag: $1"
      echo "Run \`$0 --help\` for usage."
      exit 1
      ;;
  esac
  shift || true
done
case "$mode" in
  --no-docker|--ports-only)
    free_all_ports
    ok "done (ports-only mode). Start your local services manually."
    ;;
  ""|core|full|--full)
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
