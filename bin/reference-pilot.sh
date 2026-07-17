#!/usr/bin/env bash
# Seed and verify the transparent synthetic reference pilot.
# This proves platform wiring; it is never a production sponsor attestation.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_ID="9f000000-0000-4000-8000-000000000001"
MODE="${1:-all}"

if [ "${NODE_ENV:-}" = "production" ] && [ "${REFERENCE_PILOT_ALLOW_SYNTHETIC:-false}" != "true" ]; then
  echo "reference-pilot: refusing synthetic evidence in production" >&2
  echo "Use a dedicated validation tenant and explicitly set REFERENCE_PILOT_ALLOW_SYNTHETIC=true." >&2
  exit 2
fi

if [ -f "$ROOT/.env.local" ]; then
  set +u
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/.env.local"
  set +a
  set -u
fi

DATABASE_URL="${DATABASE_URL_WORKGRAPH_ADMIN:-${WORKGRAPH_DATABASE_URL_ADMIN:-${DATABASE_URL:-}}}"

seed() {
  if [ -z "$DATABASE_URL" ]; then
    echo "reference-pilot: DATABASE_URL_WORKGRAPH_ADMIN or DATABASE_URL is required" >&2
    exit 2
  fi
  echo "▸ seeding transparent synthetic reference pilot..."
  (cd "$ROOT/workgraph-studio/apps/api" && DATABASE_URL="$DATABASE_URL" npm run pilot:seed)
}

verify() {
  echo "▸ verifying all contract-bound pilot obligations..."
  python3 "$ROOT/bin/verify-contract-bound-pilot.py" --project-id "$PROJECT_ID"
}

case "$MODE" in
  seed) seed ;;
  verify) verify ;;
  all) seed; verify ;;
  *) echo "usage: bin/reference-pilot.sh [all|seed|verify]" >&2; exit 2 ;;
esac

echo "Reference Pilot: http://localhost:5180/synthesis/pilot?project=$PROJECT_ID"
