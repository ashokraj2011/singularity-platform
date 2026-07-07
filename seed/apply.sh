#!/usr/bin/env bash
# Apply every SQL seed file in this directory against the matching database.
#
#   bin/bare-metal.sh up <db_user>      ← does this for you
#   seed/apply.sh <db_user> [db_pass] [db_host] [db_port]   ← run by hand
#
# Idempotent — every file uses ON CONFLICT semantics and re-runs cleanly.
#
# Note: 00-iam.sql expects singularity-iam-service to have started once so
# SQLAlchemy has created the iam.* tables and default roles/admin user.

set -e

DB_USER="${1:?usage: $0 <db_user> [db_password] [db_host] [db_port]}"
DB_PASS="${2:-${PGPASSWORD:-postgres}}"
DB_HOST="${3:-localhost}"
DB_PORT="${4:-5432}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PGPASSWORD="$DB_PASS"

run() {
  local db="$1" file="$2" out rc=0
  echo "▸ $file → $db"
  # Capture output so we can inspect psql's REAL exit status. The old form piped
  # straight into `grep … || true`, so the pipeline's status was grep's and the
  # `|| true` forced success — a failed seed (ON_ERROR_STOP=1 → psql exit 3) was
  # silently swallowed and this script still reported success. `|| rc=$?` keeps
  # set -e from aborting on the assignment so we can report the real error.
  out="$(psql -v ON_ERROR_STOP=1 -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$db" -f "$SCRIPT_DIR/$file" 2>&1)" || rc=$?
  printf '%s\n' "$out" | grep -vE "^(SET|BEGIN|COMMIT|INSERT|UPDATE|NOTICE|DO)" || true
  if [ "$rc" -ne 0 ]; then
    echo "✗ $file FAILED against $db (psql exit $rc) — see output above" >&2
    return "$rc"
  fi
}

run singularity_iam  00-iam.sql
run singularity      01-agent-runtime.sql
run workgraph        02-workgraph.sql
run audit_governance 03-audit-governance.sql
run singularity_iam  04-demo-users.sql
run singularity_iam  05-demo-user-capabilities.sql

echo "✓ all seeds applied."
