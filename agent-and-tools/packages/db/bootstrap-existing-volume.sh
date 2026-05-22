#!/bin/sh
# M67 Slice 3A.1 — Idempotent at-postgres bootstrap for EXISTING volumes.
#
# init.sql (mounted at /docker-entrypoint-initdb.d/) only runs the first
# time Postgres starts against an empty PGDATA dir. Operators upgrading
# through M67 Slice 3A have an existing volume, so init.sql's additions
# (singularity_iam DB + singularity role) never run on their stack — and
# iam-service crashes on startup with "password authentication failed".
#
# This script runs on every `docker compose up -d`, connects as the
# `postgres` superuser, and ensures both the role + DB exist. Safe to
# re-run; every statement is gated on a NOT EXISTS check.
#
# Companion service in docker-compose.yml: at-postgres-bootstrap.
# iam-service depends_on it with service_completed_successfully, so the
# auth path is always ready by the time iam-service tries to connect.

set -e

echo "[bootstrap] ensuring 'singularity' role exists…"
psql -v ON_ERROR_STOP=1 -d singularity <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='singularity') THEN
    CREATE ROLE singularity LOGIN PASSWORD 'singularity' SUPERUSER;
    RAISE NOTICE '[bootstrap] created role singularity';
  END IF;
END$$;
SQL

echo "[bootstrap] ensuring 'singularity_iam' database exists…"
DB_EXISTS=$(psql -v ON_ERROR_STOP=1 -d singularity -tAc \
  "SELECT 1 FROM pg_database WHERE datname='singularity_iam'")
if [ -z "$DB_EXISTS" ]; then
  psql -v ON_ERROR_STOP=1 -d singularity -c \
    "CREATE DATABASE singularity_iam OWNER singularity"
  echo "[bootstrap] created database singularity_iam"
fi

echo "[bootstrap] ensuring pgcrypto + grants in singularity_iam…"
psql -v ON_ERROR_STOP=1 -d singularity_iam <<'SQL'
CREATE EXTENSION IF NOT EXISTS pgcrypto;
GRANT ALL ON SCHEMA public TO singularity;
SQL

echo "[bootstrap] done."
