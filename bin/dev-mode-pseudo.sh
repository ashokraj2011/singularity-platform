#!/usr/bin/env bash
# M16 — flip workgraph-api between real IAM (:8100) and pseudo IAM (:8101).
#
# Without this script, switching modes requires `unset` + force-recreate of
# the api container, which is easy to forget (and often leaves stale
# IAM_BOOTSTRAP_USERNAME/PASSWORD in the shell). This wrapper does it cleanly.
#
# Usage:
#   bin/dev-mode-pseudo.sh on        # point workgraph-api at pseudo-iam (:8101)
#   bin/dev-mode-pseudo.sh off       # point back at real iam (:8100)
#   bin/dev-mode-pseudo.sh status    # show current AUTH_PROVIDER + IAM_BASE_URL
#
# The script edits no files; it just re-creates the api container with the
# right env. Pseudo-iam itself must already be running (see
# pseudo-iam-service/docker-compose.yml).

set -euo pipefail

cd "$(dirname "$0")/../workgraph-studio"

mode="${1:-status}"

case "$mode" in
  on)
    echo "[dev-mode] flipping workgraph-api → pseudo-IAM (:8101)"
    AUTH_PROVIDER=iam \
    IAM_BASE_URL=http://host.docker.internal:8101/api/v1 \
    IAM_BOOTSTRAP_USERNAME=admin@pseudo.local \
    IAM_BOOTSTRAP_PASSWORD=any \
    docker compose -f infra/docker/docker-compose.yml up -d --force-recreate api
    ;;
  off)
    echo "[dev-mode] flipping workgraph-api → real IAM (:8100)"
    # Explicit empty-string envs override anything inherited from the shell.
    AUTH_PROVIDER=iam \
    IAM_BASE_URL=http://host.docker.internal:8100/api/v1 \
    IAM_BOOTSTRAP_USERNAME= \
    IAM_BOOTSTRAP_PASSWORD= \
    docker compose -f infra/docker/docker-compose.yml up -d --force-recreate api
    ;;
  status)
    echo "[dev-mode] current workgraph-api env:"
    docker exec docker-api-1 env 2>/dev/null | grep -E "^(AUTH_PROVIDER|IAM_BASE_URL|IAM_BOOTSTRAP_)" | sort || \
      echo "  (api container not running)"
    ;;
  *)
    echo "usage: $0 {on|off|status}" >&2
    exit 2
    ;;
esac
