-- M99 S4.2 — CapabilityWorldModel enrichment.
--
-- Adds the named-but-missing world-model fields the "Centralize Agentic
-- Coding Around Context Fabric" verification flagged, plus auto-refresh
-- bookkeeping. ALL additive with safe defaults, so this is a no-op on
-- existing rows — no backfill required. The bootstrap / refresh workers
-- populate the JSON columns; the drift detector stamps lastAutoRefreshAt
-- when WORLD_MODEL_AUTO_REFRESH_ENABLED is on.

ALTER TABLE "CapabilityWorldModel"
  ADD COLUMN IF NOT EXISTS "repoPatterns"       JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS "entrypoints"        JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS "knownFailures"      JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS "skillFileSummaries" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS "codeConventions"    JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS "lastAutoRefreshAt"  TIMESTAMP(3);
