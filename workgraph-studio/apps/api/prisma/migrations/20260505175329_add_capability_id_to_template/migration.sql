-- Add capability ownership to workflow templates.  When set, this is the
-- authorization boundary; when null, falls back to the legacy team rule.
ALTER TABLE "workflow_templates" ADD COLUMN "capabilityId" TEXT;
CREATE INDEX "workflow_templates_capabilityId_idx" ON "workflow_templates"("capabilityId");
