-- M61 Slice A — CapabilityWorldModel
--
-- See agent-runtime/prisma/schema.prisma for the rationale block. This
-- migration adds one new table; existing CapabilityBootstrapRun /
-- CapabilityLearningCandidate / CapabilityRepository tables are not
-- touched. Backfill is deferred to a separate one-shot job (operator
-- can run the existing bootstrap "refresh" path against a capability
-- to populate the new row).

CREATE TABLE "CapabilityWorldModel" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "capabilityId" TEXT NOT NULL,
    "repoFingerprint" TEXT,
    "primaryLanguage" TEXT,
    "buildSystem" TEXT,
    "testCommands" JSONB NOT NULL DEFAULT '[]',
    "buildCommands" JSONB NOT NULL DEFAULT '[]',
    "runCommands" JSONB NOT NULL DEFAULT '[]',
    "agentRules" JSONB NOT NULL DEFAULT '[]',
    "readmeSummary" TEXT,
    "architectureSlice" JSONB NOT NULL DEFAULT '{}',
    "astIndexedAt" TIMESTAMP(3),
    "astIndexFiles" INTEGER NOT NULL DEFAULT 0,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "refreshedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CapabilityWorldModel_pkey" PRIMARY KEY ("id")
);

-- One row per capability. Bootstrap upserts on capabilityId.
CREATE UNIQUE INDEX "CapabilityWorldModel_capabilityId_key"
  ON "CapabilityWorldModel"("capabilityId");

-- Drift detector + refresh worker scan recent rows; refreshedAt is
-- the natural ordering key.
CREATE INDEX "CapabilityWorldModel_refreshedAt_idx"
  ON "CapabilityWorldModel"("refreshedAt");

ALTER TABLE "CapabilityWorldModel"
  ADD CONSTRAINT "CapabilityWorldModel_capabilityId_fkey"
  FOREIGN KEY ("capabilityId") REFERENCES "Capability"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
