-- M40 — ImmutableContract pin on AgentTemplateVersion.
--
-- Adds contractHash + contractId columns plus a hash lookup index so a
-- published template version records the prompt-composer contract that
-- froze its prompt/tool/model state at publish time. Both nullable for
-- backward compat — rows that predate the M40 mint flow stay valid.
--
-- This file backfills an orphaned migration: M40 added the columns to
-- schema.prisma but no migration was authored alongside it, so the
-- long-running at-postgres volume drifted (the column exists on
-- fresh `prisma db push` paths used in dev, not on production
-- `migrate deploy` paths). agent-runtime crashed with
-- "column AgentTemplateVersion.contractHash does not exist" until
-- this landed.
--
-- Idempotent so a re-run is a no-op.

ALTER TABLE "AgentTemplateVersion"
  ADD COLUMN IF NOT EXISTS "contractHash" TEXT,
  ADD COLUMN IF NOT EXISTS "contractId" TEXT;

CREATE INDEX IF NOT EXISTS "AgentTemplateVersion_contractHash_idx"
  ON "AgentTemplateVersion" ("contractHash");
