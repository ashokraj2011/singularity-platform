#!/bin/sh
# agent-runtime startup wrapper — closes the two Prisma drift modes
# that have bitten this session:
#
#   (1) DB missing a column the client expects (e.g. M40's
#       AgentTemplateVersion.contractHash — schema.prisma had it for
#       months but no migration was authored, so the long-running
#       at-postgres volume never grew the column. agent-runtime
#       crashed every time `listTemplateVersions()` ran).
#
#   (2) Generated Prisma client missing a column the schema defines.
#       Less common here than in prompt-composer but the same
#       prevention pattern applies.
#
# We deliberately do NOT use `prisma db push` here because agent-runtime
# shares its database with prompt-composer — a push would drop
# composer's tables (PromptAssembly, CapabilityCompiledContext, etc).
# See the comment block in this service's Dockerfile.
#
# Migration tracking: a dedicated `_singularity_startup_migrations`
# table records what's been applied. On first run we seed it from
# Prisma's own `_prisma_migrations` so the four already-applied
# Prisma-format migrations don't re-run (their CREATE TABLE
# statements are NOT idempotent and would crash).
#
# Going forward, every new migration we add must be additive (no
# DROP) and use IF NOT EXISTS guards so a re-apply (e.g. operator
# deletes a row from the tracking table) is a no-op.
set -e

echo "[agent-runtime] waiting for database..."
until pg_isready -d "$DATABASE_URL" >/dev/null 2>&1; do
  sleep 2
done

# Bootstrap the tracking table. Idempotent.
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
CREATE TABLE IF NOT EXISTS _singularity_startup_migrations (
  name        TEXT PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  service     TEXT NOT NULL DEFAULT 'unknown'
);
SQL

# First-run seeding: copy from Prisma's `_prisma_migrations` if
# present. agent-runtime has 4 Prisma-format migrations that are
# already recorded there; without this step the wrapper would
# re-run them on first boot and they'd crash (the older ones
# don't have IF NOT EXISTS guards).
count="$(psql "$DATABASE_URL" -tA -c "SELECT COUNT(*) FROM _singularity_startup_migrations;")"
if [ "$count" = "0" ]; then
  has_prisma="$(psql "$DATABASE_URL" -tA -c "SELECT to_regclass('public._prisma_migrations') IS NOT NULL;")"
  if [ "$has_prisma" = "t" ]; then
    echo "[agent-runtime] first run — seeding tracking from _prisma_migrations"
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c \
      "INSERT INTO _singularity_startup_migrations (name, service)
       SELECT migration_name, 'agent-runtime' FROM _prisma_migrations
       ON CONFLICT (name) DO NOTHING;"
  fi
fi

# Apply any new migrations. Two file layouts coexist:
#   prisma/migrations/<timestamp>_<name>/migration.sql  — Prisma format
#   prisma/migrations/*.sql                              — flat (older)
# Tracked under the directory name (or filename) so the same file
# layout choice doesn't trigger re-application.
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
    echo "[agent-runtime] applying $name/migration.sql"
    if psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$dir/migration.sql"; then
      psql "$DATABASE_URL" -q -c \
        "INSERT INTO _singularity_startup_migrations (name, service) VALUES ('$name', 'agent-runtime');"
    else
      echo "[agent-runtime] FATAL: migration $name failed — aborting startup"
      exit 1
    fi
  done
  # Flat .sql (legacy / out-of-band patches).
  for migration in $(ls "$MIGRATIONS_DIR"/*.sql 2>/dev/null | sort); do
    name="$(basename "$migration")"
    applied="$(psql "$DATABASE_URL" -tA -c \
      "SELECT 1 FROM _singularity_startup_migrations WHERE name = '$name';")"
    if [ "$applied" = "1" ]; then
      continue
    fi
    echo "[agent-runtime] applying $name"
    if psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$migration"; then
      psql "$DATABASE_URL" -q -c \
        "INSERT INTO _singularity_startup_migrations (name, service) VALUES ('$name', 'agent-runtime');"
    else
      echo "[agent-runtime] FATAL: migration $name failed — aborting startup"
      exit 1
    fi
  done
fi

# Re-apply post-push.sql every boot (kept here so this script is
# the single source of truth for what happens at agent-runtime
# startup). post-push.sql is hand-written to be idempotent.
if [ -e "prisma/post-push.sql" ]; then
  echo "[agent-runtime] applying post-push.sql"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "prisma/post-push.sql"
fi

# Regenerate the Prisma client. Cheap, idempotent.
echo "[agent-runtime] regenerating prisma client"
PRISMA_HIDE_UPDATE_MESSAGE=1 npx prisma generate --generator client || true

# Run prisma db seed in dev only. RUN_SEED controlled by Dockerfile
# (dev sets it; prod doesn't). Failure here is non-fatal because seed
# is best-effort population, not schema correctness.
if [ "${RUN_SEED:-false}" = "true" ]; then
  echo "[agent-runtime] running prisma db seed"
  npx prisma db seed || echo "[agent-runtime] seed failed (continuing)"
fi

echo "[agent-runtime] starting app"
exec "$@"
