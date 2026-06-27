#!/usr/bin/env bash
# Singularity Platform — single-shot CLI wrapper around the master docker-compose.
#
# Usage:
#   ./singularity.sh up [--profile p] [service]
#                                             start core by default, optional profiles on demand
#   ./singularity.sh up --full             start historical full local stack
#   ./singularity.sh backend-split         run product stack with split agent/tools backend containers
#   ./singularity.sh core-only             stop optional/runtime containers and run core only
#   ./singularity.sh down                  stop everything (keeps volumes)
#   ./singularity.sh nuke                  stop + delete all data volumes
#   ./singularity.sh stop <service>        stop one service
#   ./singularity.sh restart <service>     restart one service
#   ./singularity.sh status                list services + state
#   ./singularity.sh logs <service> [-f]   tail logs of a service
#   ./singularity.sh build [service]       rebuild image(s)
#   ./singularity.sh urls                  print all service URLs
#   ./singularity.sh topology              validate/explain the active container topology
#   ./singularity.sh ls                    list known service names
#   ./singularity.sh login                 quick smoke: IAM /auth/local/login
#   ./singularity.sh doctor [git|secrets]  validate config, ports, health, keys
#   ./singularity.sh tenant-isolation      dry-run/apply Workgraph tenant DB forced-RLS cutover
#   ./singularity.sh office-copilot-only   configure strict office mode: Copilot only
#   ./singularity.sh config <command>      configure DBs, keys, endpoints, LLMs, MCP
#     common: init | show | doctor | set | mcp | git | providers | models | export | write | prepare-production | mint-workgraph-proxy-token
#
# Service names match the docker-compose `services:` keys. Quick reference:
#   platform-web           unified platform web app on :5180
#   blueprint-workbench    legacy artifact workbench on :5176 (frontend-legacy profile)
#   workgraph-api          DAG runtime on :8080
#   platform-core          one container for agent-service/tool-service/agent-runtime/prompt-composer (:3001-:3004)
#   context-api            LLM optimizer entry on :8000
#   llm-gateway            :8001 (optional/runtime-infra profile)
#   context-memory         :8002 (deprecated)
#   metrics-ledger         :8003 (deprecated)
#   formal-verifier        optional SMT analyzer on :8010
#   mcp-server             Tool Runtime (MCP-compatible) on :7100 (optional/per-tenant)
#   iam-service            IAM API on :8100
#   iam-postgres           deprecated IAM Postgres on :5433
#   at-postgres            shared app/IAM Postgres on :5432
#   wg-postgres            workgraph Postgres on :5434
#   wg-minio               MinIO on :9000/:9001

set -e

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

require_compose() {
  if ! docker compose version >/dev/null 2>&1; then
    err "docker compose v2 not found. Install Docker Desktop or the compose plugin."
    exit 1
  fi
}

compose_orphan_args() {
  if [ "${SINGULARITY_KEEP_ORPHANS:-0}" = "1" ]; then
    return 0
  fi
  printf '%s\n' "--remove-orphans"
}

# App ports the platform publishes. Storage ports (5432/5434/9000/9001) are
# owned by the Docker postgres/minio and intentionally excluded. Frees any
# NON-Docker host process squatting on an app port (e.g. a bare-metal stack from
# another clone) so `docker compose up` doesn't fail with "address already in
# use". NEVER kills Docker's own proxy. Opt out with SINGULARITY_NO_FREE_PORTS=1.
#
# Keep remote/pluggable runtime ports out of the default cleanup path. The user
# may be running llm-gateway or MCP outside this compose stack.
SINGULARITY_CORE_APP_PORTS=(3000 3001 3002 3003 3004 5180 8000 8080 8100)
SINGULARITY_RUNTIME_APP_PORTS=(7100 8001)
SINGULARITY_OPTIONAL_APP_PORTS=(5174 5175 5176 5181 5182 8002 8003 8010 8011 8101 8500)
SINGULARITY_OPTIONAL_SERVICES=(
  llm-gateway
  mcp-server
  mcp-sandbox-runner
  formal-verifier
  prompt-compressor
  context-memory
  agent-service
  agent-runtime
  prompt-composer
  blueprint-workbench
  edge-gateway
  iam-postgres
)

profile_active() {
  local needle="$1" p
  for p in "${ACTIVE_PROFILES[@]:-}"; do
    [ "$p" = "$needle" ] && return 0
  done
  IFS=',' read -r -a _env_profiles <<< "${COMPOSE_PROFILES:-core}"
  for p in "${_env_profiles[@]}"; do
    [ "$p" = "$needle" ] && return 0
  done
  return 1
}

profile_requested() {
  local needle="$1" p
  for p in "${ACTIVE_PROFILES[@]:-}"; do
    [ "$p" = "$needle" ] && return 0
  done
  return 1
}

free_host_ports() {
  if [ "${SINGULARITY_NO_FREE_PORTS:-0}" = "1" ]; then return 0; fi
  command -v lsof >/dev/null 2>&1 || return 0
  local ports=("$@")
  if [ "${#ports[@]}" -eq 0 ]; then
    ports=("${SINGULARITY_CORE_APP_PORTS[@]}")
  fi
  local port pid cmd sig
  for sig in TERM KILL; do
    for port in "${ports[@]}"; do
      for pid in $(lsof -ti tcp:"$port" -sTCP:LISTEN 2>/dev/null || true); do
        cmd="$(ps -p "$pid" -o comm= 2>/dev/null || echo '')"
        case "$cmd" in *docker*|*Docker*|*vpnkit*) continue ;; esac   # never kill Docker's own
        if [ "$sig" = "TERM" ]; then info "  freeing :$port — ${cmd##*/} (pid $pid)"; fi
        kill "-$sig" "$pid" 2>/dev/null || true
      done
    done
    if [ "$sig" = "TERM" ]; then sleep 1; fi
  done
}

audit_compose() {
  if [ -f "$SCRIPT_DIR/.env" ]; then
    ( cd audit-governance-service && docker compose --env-file "$SCRIPT_DIR/.env" "$@" )
  else
    ( cd audit-governance-service && docker compose "$@" )
  fi
}

cmd=${1:-help}
shift || true

case "$cmd" in
  up)
    require_compose
    target=""
    ACTIVE_PROFILES=()
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --full)
          ACTIVE_PROFILES+=(full)
          ;;
        --profile)
          shift
          ACTIVE_PROFILES+=("${1:?usage: $0 up --profile <name> [service]}")
          ;;
        --profile=*)
          ACTIVE_PROFILES+=("${1#--profile=}")
          ;;
        --with-llm-gateway|--llm-gateway)
          ACTIVE_PROFILES+=(llm-gateway)
          ;;
        --with-mcp|--mcp)
          ACTIVE_PROFILES+=(mcp)
          ;;
        *)
          if [ -n "$target" ]; then
            err "only one service target is supported: '$target' and '$1'"
            exit 1
          fi
          target="$1"
          ;;
      esac
      shift || true
    done

    compose_profile_args=()
    if [ "${#ACTIVE_PROFILES[@]}" -gt 0 ] \
      && ! profile_requested full \
      && ! profile_requested backend-split \
      && ! profile_requested gateway-only \
      && ! profile_requested composer-only; then
      compose_profile_args+=(--profile core)
    fi
    for p in "${ACTIVE_PROFILES[@]}"; do
      compose_profile_args+=(--profile "$p")
    done
    orphan_args=()
    while IFS= read -r arg; do
      [ -n "$arg" ] && orphan_args+=("$arg")
    done < <(compose_orphan_args)
    compose_cmd=(docker compose)
    if profile_requested backend-split; then
      compose_cmd=(env COMPOSE_PROFILES=backend-split docker compose)
    elif profile_requested composer-only; then
      compose_cmd=(env COMPOSE_PROFILES=composer-only docker compose)
    elif profile_requested gateway-only; then
      compose_cmd=(env COMPOSE_PROFILES=gateway-only docker compose)
    fi

    ports_to_free=("${SINGULARITY_CORE_APP_PORTS[@]}")
    if profile_active full; then
      ports_to_free+=("${SINGULARITY_RUNTIME_APP_PORTS[@]}" "${SINGULARITY_OPTIONAL_APP_PORTS[@]}")
    else
      if profile_active llm-gateway || profile_active gateway-only || profile_active composer-only; then
        ports_to_free+=(8001)
      fi
      if profile_active mcp; then
        ports_to_free+=(7100)
      fi
      if profile_active verification; then
        ports_to_free+=(8010)
      fi
      if profile_active compression; then
        ports_to_free+=(8011)
      fi
      if profile_active frontend-legacy; then
        ports_to_free+=(5174 5175 5176 5181 5182 8085)
      fi
      if profile_active audit; then
        ports_to_free+=(8500)
      fi
    fi

    info "freeing selected app ports held by non-Docker processes (set SINGULARITY_NO_FREE_PORTS=1 to skip)…"
    free_host_ports "${ports_to_free[@]}"
    if [ -n "$target" ]; then
      info "starting $target …"
      "${compose_cmd[@]}" "${compose_profile_args[@]}" up -d "${orphan_args[@]}" "$target"
    else
      if profile_active full; then
        info "starting full local stack …"
      elif profile_active backend-split; then
        info "starting backend-split platform stack …"
      else
        info "starting core platform stack …"
      fi
      "${compose_cmd[@]}" "${compose_profile_args[@]}" up -d "${orphan_args[@]}"
      # Side stack that lives in its own compose file. Keep it opt-in so the
      # default stack is product-core only; start with `--profile audit` or
      # `--full` when governance ledger UI/API is needed locally.
      if [ -d audit-governance-service ] && { profile_active full || profile_active audit; }; then
        info "starting audit-governance …"
        audit_compose up -d
      fi
    fi
    ok "done. Use \`$0 urls\` for the address list."
    ;;

  down)
    require_compose
    info "stopping master stack (volumes preserved) …"
    docker compose down
    if [ -d audit-governance-service ]; then
      audit_compose down
    fi
    ok "stack down."
    ;;

  core-only|core)
    require_compose
    info "stopping optional/runtime containers (volumes preserved) …"
    docker compose --profile full --profile frontend-legacy --profile deprecated stop "${SINGULARITY_OPTIONAL_SERVICES[@]}" >/dev/null 2>&1 || true
    if [ -d audit-governance-service ]; then
      audit_compose down >/dev/null 2>&1 || true
    fi
    orphan_args=()
    while IFS= read -r arg; do
      [ -n "$arg" ] && orphan_args+=("$arg")
    done < <(compose_orphan_args)
    info "ensuring core platform stack is running …"
    docker compose --profile core up -d "${orphan_args[@]}"
    ok "core stack running. Optional runtime services stay stopped until started with --profile."
    ;;

  backend-split|split-backend)
    require_compose
    info "freeing selected app ports held by non-Docker processes (set SINGULARITY_NO_FREE_PORTS=1 to skip)…"
    free_host_ports "${SINGULARITY_CORE_APP_PORTS[@]}"
    info "stopping consolidated platform-core before starting split backend containers …"
    docker compose stop platform-core >/dev/null 2>&1 || true
    orphan_args=()
    while IFS= read -r arg; do
      [ -n "$arg" ] && orphan_args+=("$arg")
    done < <(compose_orphan_args)
    info "starting product stack with backend-split profile …"
    COMPOSE_PROFILES=backend-split docker compose up -d "${orphan_args[@]}"
    ok "backend-split stack running. Return to consolidated mode with \`$0 core-only\`."
    ;;

  nuke)
    require_compose
    warn "this will DELETE all data volumes (Postgres, MinIO, audit-gov). Type 'yes' to confirm."
    read -r confirm
    if [ "$confirm" != "yes" ]; then
      err "aborted."
      exit 1
    fi
    docker compose down -v
    if [ -d audit-governance-service ]; then
      audit_compose down -v
    fi
    ok "stack down + data wiped."
    ;;

  stop)
    require_compose
    target="${1:?usage: $0 stop <service>}"
    info "stopping $target …"
    docker compose stop "$target"
    ;;

  restart)
    require_compose
    target="${1:?usage: $0 restart <service>}"
    info "restarting $target …"
    docker compose restart "$target"
    ;;

  recreate)
    # M101 — `restart` only bounces the process; it does NOT re-read a
    # service's env_file or ${...} interpolation. Use `recreate` after editing
    # a service's .env (e.g. mcp-server/.env git config) so the new values are
    # actually loaded into a fresh container.
    require_compose
    target="${1:?usage: $0 recreate <service>}"
    info "recreating $target (reloads its env_file / .env) …"
    orphan_args=()
    while IFS= read -r arg; do
      [ -n "$arg" ] && orphan_args+=("$arg")
    done < <(compose_orphan_args)
    docker compose up -d --force-recreate --no-deps "${orphan_args[@]}" "$target"
    ;;

  status|ps)
    require_compose
    docker compose ps
    ;;

  logs)
    require_compose
    target="${1:?usage: $0 logs <service> [-f]}"
    shift
    docker compose logs "$@" "$target"
    ;;

  build)
    require_compose
    target="${1:-}"
    if [ -n "$target" ]; then
      info "building $target …"
      docker compose build "$target"
    else
      info "building all images (this may take a while) …"
      docker compose build
    fi
    ok "build done."
    ;;

  urls)
    cat <<EOF
${C_BLUE}Singularity Platform URLs${C_END}

  ${C_GREEN}Platform Web${C_END}
    platform-web        http://localhost:5180   (operations, agents, workflows, workbench, foundry, identity)
    legacy UIs          frontend-legacy profile only (:5182/:5174/:5175/:5176/:5181/:8085)

  ${C_GREEN}APIs${C_END}
    platform-core       http://localhost:3001-3004  (one Docker container hosting agent-service/tool-service/agent-runtime/prompt-composer)
    iam-service         http://localhost:8100/api/v1
    workgraph-api       http://localhost:8080/api
    prompt-composer     http://localhost:3004/api/v1 (served by platform-core in Docker)
    agent-runtime       http://localhost:3003/api/v1 (served by platform-core in Docker)
    tool-service        http://localhost:3002/api/v1 (served by platform-core in Docker)
    agent-service       http://localhost:3001/api/v1 (served by platform-core in Docker)
    context-api         http://localhost:8000      (core orchestration/context API)
    code generation     http://localhost:8080/api/codegen (served by workgraph-api for /foundry)

  ${C_GREEN}Optional Runtime Infrastructure${C_END}
    llm-gateway         http://localhost:8001      (--profile llm-gateway, or remote)
    mcp-server          http://localhost:7100      (--profile mcp, or remote/per-tenant)
    formal-verifier     http://localhost:8010      (--profile verification)
    prompt-compressor   http://localhost:8011      (--profile compression)
    audit-governance    http://localhost:8500      (--profile audit or --full)

  ${C_GREEN}Storage${C_END}
    at-postgres         localhost:5432  (dbs: singularity, singularity_iam; user: postgres/singularity)
    wg-postgres         localhost:5434  (db: workgraph, user: workgraph)
    wg-minio            http://localhost:9000  (console: :9001, user: workgraph / workgraph_secret)
    iam-postgres        localhost:5433  (deprecated profile only)
    audit-postgres      localhost:5436  (audit-governance side stack)
EOF
    ;;

  ls|list)
    require_compose
    docker compose config --services | sort
    ;;

  topology)
    require_compose
    python3 "$SCRIPT_DIR/bin/check-platform-topology-contract.py"
    echo
    python3 "$SCRIPT_DIR/bin/check-platform-topology.py"
    echo
    bash "$SCRIPT_DIR/bin/check-agent-tools-topology.sh"
    echo
    docker compose ps --format 'table {{.Service}}\t{{.State}}\t{{.Status}}\t{{.Ports}}'
    ;;

  login)
    require_compose
    login_payload="$(python3 - <<'PY'
import json
from pathlib import Path

data = json.loads(Path(".singularity/config.local.json").read_text()) if Path(".singularity/config.local.json").exists() else {}
identity = data.get("identity", {}) if isinstance(data, dict) else {}
email = identity.get("bootstrapEmail") or "admin@singularity.local"
password = identity.get("bootstrapPassword") or "Admin1234!"
print(json.dumps({"email": email, "password": password}))
PY
)"
    login_email="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["email"])' <<< "$login_payload")"
    info "POST iam-service /auth/local/login ($login_email)"
    code=$(curl -s -o /tmp/sp-login.json -w '%{http_code}' \
      -X POST http://localhost:8100/api/v1/auth/local/login \
      -H "Content-Type: application/json" \
      -d "$login_payload")
    if [ "$code" = "200" ]; then
      ok "login OK (token issued)"
      python3 -c "import json; d=json.load(open('/tmp/sp-login.json')); print(' user:', d['user']['email'], '/ super_admin:', d['user'].get('is_super_admin'))" 2>/dev/null
    else
      err "login failed (http $code)"
      cat /tmp/sp-login.json
    fi
    ;;

  config)
    python3 "$SCRIPT_DIR/bin/configure-platform.py" "$@"
    ;;

  doctor)
    python3 "$SCRIPT_DIR/bin/configure-platform.py" doctor "$@"
    ;;

  tenant-isolation|workgraph-tenant-isolation|force-rls)
    python3 "$SCRIPT_DIR/bin/workgraph-tenant-isolation-cutover.py" "$@"
    ;;

  office|office-copilot-only|copilot-only)
    if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
      python3 "$SCRIPT_DIR/bin/configure-platform.py" office-copilot-only "$@"
      exit 0
    fi
    info "configuring strict office mode (GitHub Copilot only) …"
    python3 "$SCRIPT_DIR/bin/configure-platform.py" office-copilot-only "$@"
    ok "office Copilot-only config written. Restart services with \`$0 recreate mcp-server\` or \`$0 up\`."
    ;;

  help|--help|-h|"")
    grep -E '^# ' "$0" | sed 's/^# //'
    ;;

  *)
    err "unknown command: $cmd"
    echo "Run \`$0 help\` for usage."
    exit 1
    ;;
esac
