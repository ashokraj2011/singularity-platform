#!/usr/bin/env bash
# Singularity Platform — single-shot CLI wrapper around the master docker-compose.
#
# Usage:
#   ./singularity.sh up [service]          start all (or just one)
#   ./singularity.sh down                  stop everything (keeps volumes)
#   ./singularity.sh nuke                  stop + delete all data volumes
#   ./singularity.sh stop <service>        stop one service
#   ./singularity.sh restart <service>     restart one service
#   ./singularity.sh status                list services + state
#   ./singularity.sh logs <service> [-f]   tail logs of a service
#   ./singularity.sh build [service]       rebuild image(s)
#   ./singularity.sh urls                  print all service URLs
#   ./singularity.sh ls                    list known service names
#   ./singularity.sh login                 quick smoke: IAM /auth/local/login
#
# Service names match the docker-compose `services:` keys. Quick reference:
#   portal                 the wrapper SPA on :5180
#   user-and-capability    IAM admin SPA on :5175
#   workgraph-web          workflow designer + runtime SPA on :5174
#   agent-web              agents/tools/prompts admin Next.js on :3000
#   workgraph-api          DAG runtime on :8080
#   prompt-composer        prompt assembly on :3004
#   agent-runtime          agent template + memory on :3003
#   tool-service           tool registry on :3002
#   agent-service          agent CRUD on :3001
#   context-api            LLM optimizer entry on :8000
#   llm-gateway            :8001
#   context-memory         :8002
#   metrics-ledger         :8003
#   mcp-server-demo        reference MCP server on :7100 (per-tenant in prod)
#   iam-service            IAM API on :8100
#   iam-postgres           IAM Postgres on :5433
#   at-postgres            agent-and-tools Postgres on :5432
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

cmd=${1:-help}
shift || true

case "$cmd" in
  up)
    require_compose
    target="${1:-}"
    if [ -n "$target" ]; then
      info "starting $target …"
      docker compose up -d "$target"
    else
      info "starting all services …"
      docker compose up -d
    fi
    ok "done. Use \`$0 urls\` for the address list."
    ;;

  down)
    require_compose
    info "stopping all services (volumes preserved) …"
    docker compose down
    ok "stack down."
    ;;

  nuke)
    require_compose
    warn "this will DELETE all data volumes (Postgres, MinIO). Type 'yes' to confirm."
    read -r confirm
    if [ "$confirm" != "yes" ]; then
      err "aborted."
      exit 1
    fi
    docker compose down -v
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

  ${C_GREEN}Portal & UIs${C_END}
    portal              http://localhost:5180
    user-and-capability http://localhost:5175   (IAM admin SPA)
    workgraph-web       http://localhost:5174   (workflow designer + runtime)
    agent-web           http://localhost:3000   (Next.js admin for agents/tools/prompts)

  ${C_GREEN}APIs${C_END}
    iam-service         http://localhost:8100/api/v1
    workgraph-api       http://localhost:8080/api
    prompt-composer     http://localhost:3004/api/v1
    agent-runtime       http://localhost:3003/api/v1
    tool-service        http://localhost:3002/api/v1
    agent-service       http://localhost:3001/api/v1
    context-api         http://localhost:8000      (LLM optimizer entry)
    llm-gateway         http://localhost:8001
    context-memory      http://localhost:8002
    metrics-ledger      http://localhost:8003
    mcp-server-demo     http://localhost:7100      (reference MCP server; bearer-token gated)

  ${C_GREEN}Storage${C_END}
    iam-postgres        localhost:5433  (db: singularity_iam, user: singularity)
    at-postgres         localhost:5432  (db: singularity, user: postgres)
    wg-postgres         localhost:5434  (db: workgraph, user: workgraph)
    wg-minio            http://localhost:9000  (console: :9001, user: workgraph / workgraph_secret)
EOF
    ;;

  ls|list)
    require_compose
    docker compose config --services | sort
    ;;

  login)
    require_compose
    info "POST iam-service /auth/local/login (admin@singularity.local)"
    code=$(curl -s -o /tmp/sp-login.json -w '%{http_code}' \
      -X POST http://localhost:8100/api/v1/auth/local/login \
      -H "Content-Type: application/json" \
      -d '{"email":"admin@singularity.local","password":"Admin1234!"}')
    if [ "$code" = "200" ]; then
      ok "login OK (token issued)"
      python3 -c "import json; d=json.load(open('/tmp/sp-login.json')); print(' user:', d['user']['email'], '/ super_admin:', d['user'].get('is_super_admin'))" 2>/dev/null
    else
      err "login failed (http $code)"
      cat /tmp/sp-login.json
    fi
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
