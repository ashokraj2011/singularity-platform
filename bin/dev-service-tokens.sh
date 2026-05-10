#!/usr/bin/env bash
# M16 — pair the cf↔workgraph-api service token so the M13 code-changes
# proxy actually returns populated responses in dev.
#
# context-fabric's /internal/mcp/* endpoints check `X-Service-Token` against
# its `IAM_SERVICE_TOKEN` env. workgraph-api passes `CONTEXT_FABRIC_SERVICE_TOKEN`
# in the X-Service-Token header. They must match. This script generates a
# random secret, sets both, and recreates both containers.
#
# Usage:
#   bin/dev-service-tokens.sh         # generate + apply
#   bin/dev-service-tokens.sh show    # print current values from running containers

set -euo pipefail

cmd="${1:-apply}"

case "$cmd" in
  apply)
    if command -v openssl >/dev/null 2>&1; then
      TOKEN=$(openssl rand -hex 32)
    else
      TOKEN=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
    fi
    echo "[svc-tokens] generated token: ${TOKEN:0:8}…"

    echo "[svc-tokens] restarting context-fabric context-api with IAM_SERVICE_TOKEN"
    cd "$(dirname "$0")/../context-fabric"
    IAM_SERVICE_TOKEN="$TOKEN" docker compose up -d --force-recreate context-api-service
    cd - >/dev/null

    echo "[svc-tokens] restarting workgraph-api with CONTEXT_FABRIC_SERVICE_TOKEN"
    cd "$(dirname "$0")/../workgraph-studio"
    AUTH_PROVIDER="${AUTH_PROVIDER:-iam}" \
    CONTEXT_FABRIC_SERVICE_TOKEN="$TOKEN" \
    docker compose -f infra/docker/docker-compose.yml up -d --force-recreate api
    cd - >/dev/null

    echo "[svc-tokens] paired. cf and workgraph-api both have token ${TOKEN:0:8}…"
    ;;
  show)
    echo "context-fabric IAM_SERVICE_TOKEN:"
    docker exec context-fabric-context-api-service-1 env 2>/dev/null | grep IAM_SERVICE_TOKEN || echo "  (cf not running)"
    echo "workgraph-api CONTEXT_FABRIC_SERVICE_TOKEN:"
    docker exec docker-api-1 env 2>/dev/null | grep CONTEXT_FABRIC_SERVICE_TOKEN || echo "  (workgraph-api not running)"
    ;;
  *)
    echo "usage: $0 {apply|show}" >&2
    exit 2
    ;;
esac
