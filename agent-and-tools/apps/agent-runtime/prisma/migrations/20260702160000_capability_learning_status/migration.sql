-- Capability learning status makes repo/profile grounding observable and durable.
-- The UI should read this table instead of inferring health from generated text.

CREATE TABLE IF NOT EXISTS "CapabilityLearningStatus" (
  "id" TEXT NOT NULL,
  "capabilityId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'NOT_CONFIGURED',
  "message" TEXT,
  "lastAttemptAt" TIMESTAMP(3),
  "lastSuccessAt" TIMESTAMP(3),
  "lastFailureAt" TIMESTAMP(3),
  "lastFailureCode" TEXT,
  "lastFailureMessage" TEXT,
  "runtimeId" TEXT,
  "runtimeUserId" TEXT,
  "runtimeTenantId" TEXT,
  "sourceFingerprint" TEXT,
  "repoProfileVersion" INTEGER NOT NULL DEFAULT 0,
  "activeSourceCount" INTEGER NOT NULL DEFAULT 0,
  "learnedSourceCount" INTEGER NOT NULL DEFAULT 0,
  "lastGoodStack" JSONB NOT NULL DEFAULT '[]',
  "lastRepoProfiles" JSONB NOT NULL DEFAULT '[]',
  "diagnostics" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "CapabilityLearningStatus_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "CapabilityLearningStatus"
  ADD COLUMN IF NOT EXISTS "id" TEXT,
  ADD COLUMN IF NOT EXISTS "capabilityId" TEXT,
  ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'NOT_CONFIGURED',
  ADD COLUMN IF NOT EXISTS "message" TEXT,
  ADD COLUMN IF NOT EXISTS "lastAttemptAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lastSuccessAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lastFailureAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lastFailureCode" TEXT,
  ADD COLUMN IF NOT EXISTS "lastFailureMessage" TEXT,
  ADD COLUMN IF NOT EXISTS "runtimeId" TEXT,
  ADD COLUMN IF NOT EXISTS "runtimeUserId" TEXT,
  ADD COLUMN IF NOT EXISTS "runtimeTenantId" TEXT,
  ADD COLUMN IF NOT EXISTS "sourceFingerprint" TEXT,
  ADD COLUMN IF NOT EXISTS "repoProfileVersion" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "activeSourceCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "learnedSourceCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "lastGoodStack" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS "lastRepoProfiles" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS "diagnostics" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3);

UPDATE "CapabilityLearningStatus"
SET "updatedAt" = CURRENT_TIMESTAMP
WHERE "updatedAt" IS NULL;

ALTER TABLE "CapabilityLearningStatus"
  ALTER COLUMN "id" SET NOT NULL,
  ALTER COLUMN "capabilityId" SET NOT NULL,
  ALTER COLUMN "updatedAt" SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'CapabilityLearningStatus_pkey'
  ) THEN
    ALTER TABLE "CapabilityLearningStatus"
      ADD CONSTRAINT "CapabilityLearningStatus_pkey" PRIMARY KEY ("id");
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "CapabilityLearningStatus_capabilityId_key"
  ON "CapabilityLearningStatus"("capabilityId");

CREATE INDEX IF NOT EXISTS "CapabilityLearningStatus_status_idx"
  ON "CapabilityLearningStatus"("status");

CREATE INDEX IF NOT EXISTS "CapabilityLearningStatus_updatedAt_idx"
  ON "CapabilityLearningStatus"("updatedAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'CapabilityLearningStatus_capabilityId_fkey'
  ) THEN
    ALTER TABLE "CapabilityLearningStatus"
      ADD CONSTRAINT "CapabilityLearningStatus_capabilityId_fkey"
      FOREIGN KEY ("capabilityId") REFERENCES "Capability"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
