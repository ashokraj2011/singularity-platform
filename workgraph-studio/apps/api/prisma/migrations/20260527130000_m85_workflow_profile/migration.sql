-- M85.s1 — Workflow profile column + backfill.
--
-- Distinguishes 'main' (top-level orchestration) from 'workbench'
-- (a standalone agent-loop template). 'workbench-host' is a
-- migration-helper marker for legacy main templates that still
-- contain an inline WORKBENCH_TASK node — the M85.s6 cutover
-- targets exactly those.
--
-- Both columns default to 'main' so existing rows + future callers
-- that don't set the field land in the same bucket they always
-- have. The backfill then upgrades the subset that contains a
-- WORKBENCH_TASK node to 'workbench-host'.

ALTER TABLE "workflow_templates"
  ADD COLUMN "profile" TEXT NOT NULL DEFAULT 'main';

ALTER TABLE "workflow_instances"
  ADD COLUMN "profile" TEXT NOT NULL DEFAULT 'main';

-- Backfill: templates with at least one WORKBENCH_TASK design node
-- get profile='workbench-host' so the M85.s2 list UI can mark them
-- and M85.s6 can find them for conversion. Live runs cloned from
-- those templates inherit the same marker.
UPDATE "workflow_templates" t
SET "profile" = 'workbench-host'
WHERE EXISTS (
  SELECT 1
  FROM "workflow_design_nodes" dn
  WHERE dn."workflowId" = t.id
    AND dn."nodeType" = 'WORKBENCH_TASK'
);

-- Mirror for instances cloned from those templates.
UPDATE "workflow_instances" i
SET "profile" = 'workbench-host'
WHERE EXISTS (
  SELECT 1
  FROM "workflow_templates" t
  WHERE t.id = i."templateId" AND t."profile" = 'workbench-host'
);

-- An index makes the UI filter fast — workflow lists are routinely
-- scoped by profile from now on.
CREATE INDEX "workflow_templates_profile_idx" ON "workflow_templates"("profile");
CREATE INDEX "workflow_instances_profile_idx" ON "workflow_instances"("profile");
