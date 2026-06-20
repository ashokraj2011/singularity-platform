ALTER TABLE "workflow_instances"
  ADD COLUMN IF NOT EXISTS "tenantId" TEXT;

CREATE INDEX IF NOT EXISTS "workflow_instances_tenantId_idx"
  ON "workflow_instances"("tenantId");
