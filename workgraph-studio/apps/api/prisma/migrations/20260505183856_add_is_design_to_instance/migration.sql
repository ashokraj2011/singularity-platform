-- Add a flag distinguishing the design instance (editable canonical graph)
-- from runs (read-only execution copies cloned from the design at start).
ALTER TABLE "workflow_instances" ADD COLUMN "isDesign" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "workflow_instances_template_design_idx"
  ON "workflow_instances"("templateId", "isDesign");

-- Back-fill: for every template with at least one instance, mark the
-- earliest-created one as the design.  All others stay as legacy runs.
UPDATE "workflow_instances" wi
SET "isDesign" = true
FROM (
  SELECT DISTINCT ON ("templateId") "id"
  FROM "workflow_instances"
  WHERE "templateId" IS NOT NULL
  ORDER BY "templateId", "createdAt" ASC
) earliest
WHERE wi."id" = earliest."id";
