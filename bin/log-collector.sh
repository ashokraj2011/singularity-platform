#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT/deploy/observability/docker-compose.yml"

load_env() {
  local file
  for file in "$ROOT/.env" "$ROOT/.env.local"; do
    if [ -f "$file" ]; then
      set -a
      # shellcheck disable=SC1090
      . "$file"
      set +a
    fi
  done
  export AUDIT_GOV_URL="${AUDIT_GOV_URL:-http://host.docker.internal:8500}"
}

require_token() {
  if [ -z "${AUDIT_GOV_SERVICE_TOKEN:-}" ]; then
    echo "ERROR: AUDIT_GOV_SERVICE_TOKEN is missing. Run bin/setup.sh or set it in .env.local." >&2
    exit 1
  fi
}

usage() {
  echo "Usage: bin/log-collector.sh up|down|restart|status|logs|validate"
}

load_env
case "${1:-}" in
  up)
    require_token
    docker compose -f "$COMPOSE_FILE" up -d
    ;;
  down)
    docker compose -f "$COMPOSE_FILE" down
    ;;
  restart)
    require_token
    docker compose -f "$COMPOSE_FILE" up -d --force-recreate
    ;;
  status)
    docker compose -f "$COMPOSE_FILE" ps
    ;;
  logs)
    docker compose -f "$COMPOSE_FILE" logs -f log-collector
    ;;
  validate)
    require_token
    docker run --rm \
      -e AUDIT_GOV_URL="$AUDIT_GOV_URL" \
      -e AUDIT_GOV_SERVICE_TOKEN="$AUDIT_GOV_SERVICE_TOKEN" \
      -e SINGULARITY_ENV="${SINGULARITY_ENV:-development}" \
      -v "$ROOT/deploy/observability/vector-docker.yaml:/etc/vector/vector.yaml:ro" \
      timberio/vector:0.56.0-alpine validate --skip-healthchecks /etc/vector/vector.yaml
    ;;
  *)
    usage
    exit 2
    ;;
esac
