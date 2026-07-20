#!/bin/sh
# prompt-composer startup wrapper — closes the two Prisma drift modes
# that have bitten this session:
#
#   (1) DB missing a column the client expects (e.g. M71 Slice E's
#       `phase` column — schema.prisma had it, .sql migration was
#       authored, but it never ran on this volume so the live DB
#       drifted under the running client).
#
#   (2) Generated Prisma client missing a column the schema defines
#       (e.g. happened after schema.prisma was edited mid-development
#       without rebuilding the image). Regenerating at startup is
#       cheap (<2s) and idempotent.
#
# We deliberately do NOT use `prisma db push` here because composer
# shares its database with agent-runtime — a push would drop
# agent-runtime's tables. See the comment in this service's Dockerfile.
# Instead we apply hand-written .sql migration files, which only
# ADD (every one of them is guarded with `IF NOT EXISTS`) and never
# DROP.
#
# Migration tracking: a dedicated `_singularity_startup_migrations`
# table records what's been applied so a restart doesn't re-run
# everything. The bootstrap pass seeds the table from Prisma's
# `_prisma_migrations` (if present) so existing volumes don't blast
# through their already-applied migrations on first wrapper boot.
set -e

echo "[prompt-composer] waiting for database..."
until pg_isready -d "$DATABASE_URL" >/dev/null 2>&1; do
  sleep 2
done

# Bootstrap the tracking table. Idempotent. The schema is
# intentionally separate from Prisma's `_prisma_migrations` so we
# don't fight Prisma's own contract for that table.
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
CREATE TABLE IF NOT EXISTS _singularity_startup_migrations (
  name        TEXT PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  service     TEXT NOT NULL DEFAULT 'unknown'
);
SQL

# First-run seeding: if the tracking table is empty AND Prisma's
# `_prisma_migrations` is present, copy its applied names in so we
# don't re-run migrations Prisma already handled.
count="$(psql "$DATABASE_URL" -tA -c "SELECT COUNT(*) FROM _singularity_startup_migrations;")"
if [ "$count" = "0" ]; then
  has_prisma="$(psql "$DATABASE_URL" -tA -c "SELECT to_regclass('public._prisma_migrations') IS NOT NULL;")"
  if [ "$has_prisma" = "t" ]; then
    echo "[prompt-composer] first run — seeding tracking from _prisma_migrations"
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c \
      "INSERT INTO _singularity_startup_migrations (name, service)
       SELECT migration_name, 'prompt-composer' FROM _prisma_migrations
       ON CONFLICT (name) DO NOTHING;"
  fi
fi

# Apply any migration files that aren't already recorded. Two file layouts
# coexist, exactly as in agent-runtime's wrapper:
#   prisma/migrations/<timestamp>_<name>/migration.sql  — Prisma format
#   prisma/migrations/*.sql                              — flat (older)
# The directory layout is what `prisma migrate diff` produces, so it is what
# new migrations use. Handling only the flat glob (as this script did before
# D3) meant a correctly-authored Prisma migration was silently skipped — and
# because the client IS regenerated from schema.prisma further down, that
# produced exactly drift mode (1) above: a client expecting a column the DB
# never got. Tracked under the directory name so the layout choice alone
# doesn't re-run anything.
MIGRATIONS_DIR="prisma/migrations"
if [ -d "$MIGRATIONS_DIR" ]; then
  # Directory-format first (Prisma convention).
  for dir in $(ls -d "$MIGRATIONS_DIR"/*/ 2>/dev/null | sort); do
    [ -e "$dir/migration.sql" ] || continue
    name="$(basename "$dir")"
    applied="$(psql "$DATABASE_URL" -tA -c \
      "SELECT 1 FROM _singularity_startup_migrations WHERE name = '$name';")"
    if [ "$applied" = "1" ]; then
      continue
    fi
    echo "[prompt-composer] applying $name/migration.sql"
    if psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$dir/migration.sql"; then
      psql "$DATABASE_URL" -q -c \
        "INSERT INTO _singularity_startup_migrations (name, service) VALUES ('$name', 'prompt-composer');"
    else
      echo "[prompt-composer] FATAL: migration $name failed — aborting startup"
      exit 1
    fi
  done
  # Flat .sql (legacy / out-of-band patches). Sort ensures lexicographic
  # order (m52 < m61 < m71_... < m74_...).
  for migration in $(ls "$MIGRATIONS_DIR"/*.sql 2>/dev/null | sort); do
    name="$(basename "$migration")"
    applied="$(psql "$DATABASE_URL" -tA -c \
      "SELECT 1 FROM _singularity_startup_migrations WHERE name = '$name';")"
    if [ "$applied" = "1" ]; then
      continue
    fi
    echo "[prompt-composer] applying $name"
    if psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$migration"; then
      psql "$DATABASE_URL" -q -c \
        "INSERT INTO _singularity_startup_migrations (name, service) VALUES ('$name', 'prompt-composer');"
    else
      echo "[prompt-composer] FATAL: migration $name failed — aborting startup"
      exit 1
    fi
  done
fi

# Regenerate the Prisma client. Cheap, idempotent, prevents the
# "schema edited but client stale" drift mode. The Mermaid ERD
# post-generate hook requires Chrome and is not in the runtime
# image — `|| true` swallows that specific failure since the
# client itself was already generated before the hook ran.
echo "[prompt-composer] regenerating prisma client"
PRISMA_HIDE_UPDATE_MESSAGE=1 \
  npx prisma generate --schema=prisma/schema.prisma --generator client || true
PRISMA_HIDE_UPDATE_MESSAGE=1 \
  npx prisma generate --schema=prisma/runtime-read.prisma --generator client || true

echo "[prompt-composer] starting app"
exec "$@"
