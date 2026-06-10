#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# box.sh — the Docker BOX: every platform service EXCEPT mcp-server and
# llm-gateway (those run on the laptop via bin/laptop.sh).
#
#   bin/box.sh up           start the box (no image builds — fast)
#   bin/box.sh up --build   start the box, rebuilding changed images first
#   bin/box.sh rebuild      rebuild the feature images (context-api, workgraph-api,
#                           workgraph-web, portal) after a git pull
#   bin/box.sh seed         seed users + capability + prompts + SDLC workflows
#   bin/box.sh status       container + endpoint health
#   bin/box.sh logs <svc>   tail a service's logs (e.g. logs workgraph-api)
#   bin/box.sh down         stop the box (data kept)
#
# The box reaches the laptop apps at host.docker.internal:7100 (mcp) and :8001
# (llm-gateway) via docker-compose.laptop-direct.yml. Run the laptop side with:
#   bin/laptop.sh gateway     (terminal 2)
#   bin/laptop.sh mcp         (terminal 3)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT"

dc() { docker compose -f docker-compose.yml -f docker-compose.laptop-direct.yml "$@"; }

INFRA="iam-postgres at-postgres wg-postgres wg-minio"
BOOTSTRAP="at-postgres-bootstrap"
# Everything except mcp-server / llm-gateway / mcp-sandbox-runner. --no-deps keeps
# context-api's depends_on from pulling the profiled mcp/gateway containers in.
APPS="iam-service context-memory context-api formal-verifier agent-service tool-service agent-runtime prompt-composer workgraph-api workgraph-web blueprint-workbench user-and-capability agent-web portal edge-gateway"
FEATURE_SVCS="context-api workgraph-api workgraph-web portal"

banner() {
  echo
  echo "════════════════════════════════════════════════════════════════════"
  echo "  ▶  OPEN THE PLATFORM AT:   http://localhost:8085"
  echo "        portal /   ·   /operations   ·   /workflow   ·   /workbench   ·   /iam"
  echo "  (per-app ports :5174/:5176/:5180 render blank — gateway-only builds)"
  echo "════════════════════════════════════════════════════════════════════"
  echo "  Laptop side:   bin/laptop.sh gateway    bin/laptop.sh mcp"
  echo "  First time?    bin/box.sh seed"
}

case "${1:-}" in
  up)
    BUILD=""; [ "${2:-}" = "--build" ] && BUILD="--build"
    echo "[box] infra…";  dc up -d $INFRA
    echo "[box] seed db bootstrap…"; dc up -d $BOOTSTRAP
    echo "[box] apps ${BUILD:+(rebuilding) }— mcp/llm-gateway stay on the laptop…"
    dc up -d $BUILD --no-deps $APPS
    banner
    ;;
  rebuild)
    echo "[box] building: $FEATURE_SVCS"
    dc build $FEATURE_SVCS
    echo "[box] done — apply with: $0 up"
    ;;
  seed)
    COMPOSE_FILES="-f docker-compose.yml -f docker-compose.laptop-direct.yml" \
      SEED_PREFER_LAPTOP="${SEED_PREFER_LAPTOP:-false}" \
      "$ROOT/bin/seed-docker.sh"
    ;;
  status)
    dc ps --format 'table {{.Name}}\t{{.Status}}' | sed 's/^/  /'
    printf '  edge-gateway :8085 … '; curl -fsS -o /dev/null http://localhost:8085/ && echo OK || echo DOWN
    printf '  context-api  :8000 … '; curl -fsS -o /dev/null http://localhost:8000/health && echo OK || echo DOWN
    printf '  laptop mcp   :7100 … '; curl -fsS -o /dev/null -H "authorization: Bearer ${MCP_BEARER_TOKEN:-demo-bearer-token-must-be-min-16-chars}" http://localhost:7100/healthz/strict && echo OK || echo "DOWN (start: bin/laptop.sh mcp)"
    printf '  laptop llm   :8001 … '; curl -fsS -o /dev/null http://localhost:8001/health && echo OK || echo "DOWN (start: bin/laptop.sh gateway)"
    ;;
  logs)
    [ -n "${2:-}" ] || { echo "usage: $0 logs <service>" >&2; exit 1; }
    dc logs --tail=100 -f "$2"
    ;;
  down)
    dc stop $APPS $BOOTSTRAP $INFRA
    echo "[box] stopped (data kept; 'docker compose down -v' to wipe)."
    ;;
  *)
    echo "usage: $0 {up [--build]|rebuild|seed|status|logs <svc>|down}" >&2
    echo "  Docker box = everything except mcp-server + llm-gateway (laptop: bin/laptop.sh)" >&2
    exit 1
    ;;
esac
