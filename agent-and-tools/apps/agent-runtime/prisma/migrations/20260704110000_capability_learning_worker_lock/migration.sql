-- Durable learning-worker leases prevent duplicate source sync / grounding work
-- when multiple agent-runtime instances serve the same capability.

CREATE TABLE IF NOT EXISTS "CapabilityLearningWorkerLock" (
  "id" TEXT NOT NULL,
  "capabilityId" TEXT NOT NULL,
  "operation" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CapabilityLearningWorkerLock_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "CapabilityLearningWorkerLock"
  ADD COLUMN IF NOT EXISTS "id" TEXT,
  ADD COLUMN IF NOT EXISTS "capabilityId" TEXT,
  ADD COLUMN IF NOT EXISTS "operation" TEXT,
  ADD COLUMN IF NOT EXISTS "ownerId" TEXT,
  ADD COLUMN IF NOT EXISTS "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "CapabilityLearningWorkerLock"
SET
  "startedAt" = COALESCE("startedAt", CURRENT_TIMESTAMP),
  "expiresAt" = COALESCE("expiresAt", CURRENT_TIMESTAMP),
  "createdAt" = COALESCE("createdAt", CURRENT_TIMESTAMP),
  "updatedAt" = COALESCE("updatedAt", CURRENT_TIMESTAMP)
WHERE "startedAt" IS NULL
   OR "expiresAt" IS NULL
   OR "createdAt" IS NULL
   OR "updatedAt" IS NULL;

ALTER TABLE "CapabilityLearningWorkerLock"
  ALTER COLUMN "id" SET NOT NULL,
  ALTER COLUMN "capabilityId" SET NOT NULL,
  ALTER COLUMN "operation" SET NOT NULL,
  ALTER COLUMN "ownerId" SET NOT NULL,
  ALTER COLUMN "startedAt" SET NOT NULL,
  ALTER COLUMN "expiresAt" SET NOT NULL,
  ALTER COLUMN "createdAt" SET NOT NULL,
  ALTER COLUMN "updatedAt" SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'CapabilityLearningWorkerLock_pkey'
  ) THEN
    ALTER TABLE "CapabilityLearningWorkerLock"
      ADD CONSTRAINT "CapabilityLearningWorkerLock_pkey" PRIMARY KEY ("id");
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "CapabilityLearningWorkerLock_capabilityId_key"
  ON "CapabilityLearningWorkerLock"("capabilityId");

CREATE INDEX IF NOT EXISTS "CapabilityLearningWorkerLock_operation_idx"
  ON "CapabilityLearningWorkerLock"("operation");

CREATE INDEX IF NOT EXISTS "CapabilityLearningWorkerLock_expiresAt_idx"
  ON "CapabilityLearningWorkerLock"("expiresAt");

CREATE INDEX IF NOT EXISTS "CapabilityLearningWorkerLock_updatedAt_idx"
  ON "CapabilityLearningWorkerLock"("updatedAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'CapabilityLearningWorkerLock_capabilityId_fkey'
  ) THEN
    ALTER TABLE "CapabilityLearningWorkerLock"
      ADD CONSTRAINT "CapabilityLearningWorkerLock_capabilityId_fkey"
      FOREIGN KEY ("capabilityId") REFERENCES "Capability"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
