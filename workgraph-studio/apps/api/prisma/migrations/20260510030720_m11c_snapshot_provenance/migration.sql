-- M11.c — snapshot provenance: sourceHash, sourceVersion, fetchedBy on
-- existing snapshot rows + new PromptProfile / Capability snapshot tables.

-- Existing snapshot tables get provenance columns (all nullable; backfilled
-- as new snapshots land — no data migration required).
ALTER TABLE "agents"
  ADD COLUMN "sourceHash"    TEXT,
  ADD COLUMN "sourceVersion" TEXT,
  ADD COLUMN "fetchedBy"     TEXT;

ALTER TABLE "tools"
  ADD COLUMN "sourceHash"    TEXT,
  ADD COLUMN "sourceVersion" TEXT,
  ADD COLUMN "fetchedBy"     TEXT;

-- Read-only snapshot tables. No FK from anywhere — JOIN by externalId.
CREATE TABLE "prompt_profile_snapshots" (
  "id"             TEXT        PRIMARY KEY,
  "externalId"     TEXT        NOT NULL,
  "name"           TEXT,
  "capabilityId"   TEXT,
  "scope"          TEXT,
  "payload"        JSONB       NOT NULL,
  "sourceHash"     TEXT        NOT NULL,
  "sourceVersion"  TEXT,
  "fetchedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "fetchedBy"      TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "prompt_profile_snapshots_externalId_sourceHash_key"
  ON "prompt_profile_snapshots"("externalId", "sourceHash");
CREATE INDEX "prompt_profile_snapshots_externalId_fetchedAt_idx"
  ON "prompt_profile_snapshots"("externalId", "fetchedAt");

CREATE TABLE "capability_snapshots" (
  "id"             TEXT        PRIMARY KEY,
  "externalId"     TEXT        NOT NULL,
  "capabilityKey"  TEXT,
  "name"           TEXT,
  "capabilityType" TEXT,
  "payload"        JSONB       NOT NULL,
  "sourceHash"     TEXT        NOT NULL,
  "sourceVersion"  TEXT,
  "fetchedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "fetchedBy"      TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "capability_snapshots_externalId_sourceHash_key"
  ON "capability_snapshots"("externalId", "sourceHash");
CREATE INDEX "capability_snapshots_externalId_fetchedAt_idx"
  ON "capability_snapshots"("externalId", "fetchedAt");
