#!/usr/bin/env bash
# Apply every SQL seed file in this directory against the matching database.
#
#   bin/bare-metal.sh up <db_user>      ← does this for you
#   seed/apply.sh <db_user> [db_pass] [db_host] [db_port]   ← run by hand
#
# Idempotent — every file uses ON CONFLICT semantics and re-runs cleanly.

set -e

DB_USER="${1:?usage: $0 <db_user> [db_password] [db_host] [db_port]}"
DB_PASS="${2:-${PGPASSWORD:-postgres}}"
DB_HOST="${3:-localhost}"
DB_PORT="${4:-5432}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PGPASSWORD="$DB_PASS"

run() {
  local db="$1" file="$2"
  echo "▸ $file → $db"
  psql -v ON_ERROR_STOP=1 -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$db" -f "$SCRIPT_DIR/$file" \
    2>&1 | grep -vE "^(SET|BEGIN|COMMIT|INSERT|UPDATE|NOTICE|DO)" || true
}

run singularity      01-agent-runtime.sql
run workgraph        02-workgraph.sql
run audit_governance 03-audit-governance.sql

echo "✓ all seeds applied."
