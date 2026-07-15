-- M91: Discovery compatibility bridge (ADR 0006 Slice 2). Link columns so a
-- mirrored discovery question can be traced back to the legacy row it shadows
-- (work-item clarification / workbench stage question), enabling backward-
-- compatible dual-write without duplicate mirroring.

ALTER TABLE "discovery_questions" ADD COLUMN IF NOT EXISTS "sourceType" TEXT;
ALTER TABLE "discovery_questions" ADD COLUMN IF NOT EXISTS "sourceId" TEXT;

CREATE INDEX IF NOT EXISTS "discovery_questions_sourceType_sourceId_idx" ON "discovery_questions"("sourceType", "sourceId");
