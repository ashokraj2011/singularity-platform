#!/bin/sh
# Idempotently provision the non-bypass Workgraph application DB role.
#
# The owner/admin role runs Prisma migrations and RLS cutovers. The API runtime
# should connect with WORKGRAPH_APP_DB_USER so forced RLS cannot be bypassed by
# a superuser/owner connection.

set -eu

APP_USER="${WORKGRAPH_APP_DB_USER:-workgraph_app}"
APP_PASSWORD="${WORKGRAPH_APP_DB_PASSWORD:-workgraph_app_secret}"
ADMIN_USER="${POSTGRES_USER:-workgraph}"
DB_NAME="${POSTGRES_DB:-workgraph}"
# Default tenant for the app role (see WORKGRAPH_DEFAULT_TENANT_ID). Set as a
# role-level `app.tenant_id` so bare (non-withTenantDbTransaction) queries still
# resolve a tenant under FORCE RLS instead of seeing zero rows; per-request
# SET LOCAL still overrides it. MUST match the config default + backfill value.
DEFAULT_TENANT="${WORKGRAPH_DEFAULT_TENANT_ID:-default}"

validate_ident() {
  case "$1" in
    ""|*[!A-Za-z0-9_]*|[0-9]*)
      echo "[workgraph-bootstrap] invalid SQL identifier for $2: '$1'" >&2
      exit 1
      ;;
  esac
}

case "$APP_PASSWORD" in
  *"'"*)
    echo "[workgraph-bootstrap] WORKGRAPH_APP_DB_PASSWORD cannot contain a single quote" >&2
    exit 1
    ;;
esac

case "$DEFAULT_TENANT" in
  *"'"*)
    echo "[workgraph-bootstrap] WORKGRAPH_DEFAULT_TENANT_ID cannot contain a single quote" >&2
    exit 1
    ;;
esac

validate_ident "$APP_USER" "WORKGRAPH_APP_DB_USER"
validate_ident "$ADMIN_USER" "POSTGRES_USER"
validate_ident "$DB_NAME" "POSTGRES_DB"

echo "[workgraph-bootstrap] ensuring app role '${APP_USER}' exists…"
psql -v ON_ERROR_STOP=1 -d "$DB_NAME" <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${APP_USER}') THEN
    CREATE ROLE ${APP_USER} LOGIN PASSWORD '${APP_PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
    RAISE NOTICE '[workgraph-bootstrap] created role ${APP_USER}';
  ELSE
    ALTER ROLE ${APP_USER} LOGIN PASSWORD '${APP_PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
    RAISE NOTICE '[workgraph-bootstrap] refreshed role ${APP_USER}';
  END IF;
END\$\$;
SQL

echo "[workgraph-bootstrap] granting runtime privileges…"
psql -v ON_ERROR_STOP=1 -d "$DB_NAME" <<SQL
GRANT CONNECT ON DATABASE ${DB_NAME} TO ${APP_USER};
GRANT USAGE ON SCHEMA public TO ${APP_USER};
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_USER};
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${APP_USER};
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${APP_USER};
ALTER DEFAULT PRIVILEGES FOR ROLE ${ADMIN_USER} IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${APP_USER};
ALTER DEFAULT PRIVILEGES FOR ROLE ${ADMIN_USER} IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${APP_USER};
ALTER DEFAULT PRIVILEGES FOR ROLE ${ADMIN_USER} IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO ${APP_USER};
-- Default tenant for bare connections under FORCE RLS (per-request SET LOCAL overrides).
ALTER ROLE ${APP_USER} SET app.tenant_id = '${DEFAULT_TENANT}';
SQL

echo "[workgraph-bootstrap] done."
