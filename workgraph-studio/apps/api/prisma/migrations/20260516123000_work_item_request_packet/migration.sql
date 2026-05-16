DO $$ BEGIN
  CREATE TYPE "WorkItemOriginType" AS ENUM (
    'PARENT_DELEGATED',
    'CAPABILITY_LOCAL'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "WorkItemUrgency" AS ENUM (
    'LOW',
    'NORMAL',
    'HIGH',
    'CRITICAL'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "WorkItemClarificationStatus" AS ENUM (
    'OPEN',
    'ANSWERED',
    'CLOSED'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "WorkItemClarificationDirection" AS ENUM (
    'CHILD_TO_PARENT',
    'PARENT_TO_CHILD'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TYPE "WorkItemEventType" ADD VALUE IF NOT EXISTS 'CLARIFICATION_REQUESTED';
ALTER TYPE "WorkItemEventType" ADD VALUE IF NOT EXISTS 'CLARIFICATION_ANSWERED';

ALTER TABLE "work_items" ADD COLUMN IF NOT EXISTS "workCode" TEXT;

WITH numbered AS (
  SELECT id, row_number() OVER (ORDER BY "createdAt", id) AS rn
  FROM "work_items"
  WHERE "workCode" IS NULL
)
UPDATE "work_items" w
SET "workCode" = 'WRK-' || lpad(upper(to_hex(numbered.rn::int)), 5, '0')
FROM numbered
WHERE w.id = numbered.id;

ALTER TABLE "work_items"
  ALTER COLUMN "workCode" SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "work_items_workCode_key" ON "work_items"("workCode");
CREATE INDEX IF NOT EXISTS "work_items_workCode_idx" ON "work_items"("workCode");

ALTER TABLE "work_items"
  ADD COLUMN IF NOT EXISTS "originType" "WorkItemOriginType" NOT NULL DEFAULT 'CAPABILITY_LOCAL',
  ADD COLUMN IF NOT EXISTS "details" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS "budget" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS "urgency" "WorkItemUrgency" NOT NULL DEFAULT 'NORMAL',
  ADD COLUMN IF NOT EXISTS "requiredBy" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "detailsLocked" BOOLEAN NOT NULL DEFAULT true;

UPDATE "work_items"
SET "originType" = 'PARENT_DELEGATED'
WHERE "sourceWorkflowInstanceId" IS NOT NULL OR "parentCapabilityId" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "work_items_originType_idx" ON "work_items"("originType");

CREATE TABLE IF NOT EXISTS "work_item_clarifications" (
  "id" TEXT NOT NULL,
  "workItemId" TEXT NOT NULL,
  "targetId" TEXT,
  "direction" "WorkItemClarificationDirection" NOT NULL DEFAULT 'CHILD_TO_PARENT',
  "status" "WorkItemClarificationStatus" NOT NULL DEFAULT 'OPEN',
  "question" TEXT NOT NULL,
  "answer" TEXT,
  "requestedById" TEXT,
  "answeredById" TEXT,
  "answeredAt" TIMESTAMP(3),
  "payload" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "work_item_clarifications_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "work_item_clarifications_workItemId_fkey"
    FOREIGN KEY ("workItemId") REFERENCES "work_items"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "work_item_clarifications_targetId_fkey"
    FOREIGN KEY ("targetId") REFERENCES "work_item_targets"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "work_item_clarifications_workItemId_status_idx"
  ON "work_item_clarifications"("workItemId", "status");
CREATE INDEX IF NOT EXISTS "work_item_clarifications_targetId_idx"
  ON "work_item_clarifications"("targetId");
