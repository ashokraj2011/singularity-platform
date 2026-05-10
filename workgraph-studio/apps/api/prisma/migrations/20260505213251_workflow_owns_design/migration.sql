-- ─────────────────────────────────────────────────────────────────────────────
-- Restructure: Workflow (formerly WorkflowTemplate) now owns its design graph
-- directly via dedicated workflow_design_* tables.  The previous
-- "isDesign instance" pattern is removed.
-- ─────────────────────────────────────────────────────────────────────────────

-- Defensive: if a previous attempt at this migration partially applied,
-- drop the new tables and re-create them cleanly.
DROP TABLE IF EXISTS "workflow_design_edges"  CASCADE;
DROP TABLE IF EXISTS "workflow_design_nodes"  CASCADE;
DROP TABLE IF EXISTS "workflow_design_phases" CASCADE;

-- 1. Create the new design tables
CREATE TABLE "workflow_design_phases" (
  "id"           TEXT         NOT NULL,
  "workflowId"   TEXT         NOT NULL,
  "name"         TEXT         NOT NULL,
  "displayOrder" INTEGER      NOT NULL DEFAULT 0,
  "color"        TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "workflow_design_phases_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "workflow_design_phases_workflowId_idx" ON "workflow_design_phases"("workflowId");
ALTER TABLE "workflow_design_phases"
  ADD CONSTRAINT "workflow_design_phases_workflowId_fkey"
  FOREIGN KEY ("workflowId") REFERENCES "workflow_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "workflow_design_nodes" (
  "id"                 TEXT             NOT NULL,
  "workflowId"         TEXT             NOT NULL,
  "phaseId"            TEXT,
  "nodeType"           "NodeType"       NOT NULL,
  "label"              TEXT             NOT NULL,
  "config"             JSONB            NOT NULL DEFAULT '{}',
  "compensationConfig" JSONB,
  "executionLocation"  "ExecutionLocation" NOT NULL DEFAULT 'SERVER',
  "positionX"          DOUBLE PRECISION NOT NULL DEFAULT 0,
  "positionY"          DOUBLE PRECISION NOT NULL DEFAULT 0,
  "createdAt"          TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3)     NOT NULL,
  CONSTRAINT "workflow_design_nodes_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "workflow_design_nodes_workflowId_idx" ON "workflow_design_nodes"("workflowId");
ALTER TABLE "workflow_design_nodes"
  ADD CONSTRAINT "workflow_design_nodes_workflowId_fkey"
  FOREIGN KEY ("workflowId") REFERENCES "workflow_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workflow_design_nodes"
  ADD CONSTRAINT "workflow_design_nodes_phaseId_fkey"
  FOREIGN KEY ("phaseId") REFERENCES "workflow_design_phases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "workflow_design_edges" (
  "id"           TEXT         NOT NULL,
  "workflowId"   TEXT         NOT NULL,
  "sourceNodeId" TEXT         NOT NULL,
  "targetNodeId" TEXT         NOT NULL,
  "edgeType"     "EdgeType"   NOT NULL DEFAULT 'SEQUENTIAL',
  "condition"    JSONB,
  "label"        TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "workflow_design_edges_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "workflow_design_edges_workflowId_idx" ON "workflow_design_edges"("workflowId");
CREATE INDEX "workflow_design_edges_sourceNodeId_idx" ON "workflow_design_edges"("sourceNodeId");
CREATE INDEX "workflow_design_edges_targetNodeId_idx" ON "workflow_design_edges"("targetNodeId");
ALTER TABLE "workflow_design_edges"
  ADD CONSTRAINT "workflow_design_edges_workflowId_fkey"
  FOREIGN KEY ("workflowId") REFERENCES "workflow_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workflow_design_edges"
  ADD CONSTRAINT "workflow_design_edges_sourceNodeId_fkey"
  FOREIGN KEY ("sourceNodeId") REFERENCES "workflow_design_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workflow_design_edges"
  ADD CONSTRAINT "workflow_design_edges_targetNodeId_fkey"
  FOREIGN KEY ("targetNodeId") REFERENCES "workflow_design_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 2. Backfill: copy each existing design-instance's graph into the new tables.
INSERT INTO "workflow_design_phases" ("id", "workflowId", "name", "displayOrder", "color", "createdAt")
SELECT p."id", i."templateId", p."name", p."displayOrder", p."color", p."createdAt"
FROM   "workflow_phases" p
JOIN   "workflow_instances" i ON i."id" = p."instanceId"
WHERE  i."isDesign" = true AND i."templateId" IS NOT NULL
ON CONFLICT (id) DO NOTHING;

INSERT INTO "workflow_design_nodes"
  ("id", "workflowId", "phaseId", "nodeType", "label", "config",
   "compensationConfig", "executionLocation", "positionX", "positionY",
   "createdAt", "updatedAt")
SELECT n."id", i."templateId", n."phaseId", n."nodeType", n."label", n."config",
       n."compensationConfig", n."executionLocation", n."positionX", n."positionY",
       n."createdAt", n."updatedAt"
FROM   "workflow_nodes" n
JOIN   "workflow_instances" i ON i."id" = n."instanceId"
WHERE  i."isDesign" = true AND i."templateId" IS NOT NULL
ON CONFLICT (id) DO NOTHING;

INSERT INTO "workflow_design_edges"
  ("id", "workflowId", "sourceNodeId", "targetNodeId", "edgeType", "condition", "label", "createdAt")
SELECT e."id", i."templateId", e."sourceNodeId", e."targetNodeId", e."edgeType",
       e."condition", e."label", e."createdAt"
FROM   "workflow_edges" e
JOIN   "workflow_instances" i ON i."id" = e."instanceId"
WHERE  i."isDesign" = true AND i."templateId" IS NOT NULL
ON CONFLICT (id) DO NOTHING;

-- 3. Delete dependent rows of design instances first (some FKs lack ON DELETE
--    CASCADE).  We collect design-instance ids once, then clean each table.
CREATE TEMP TABLE _design_instance_ids ON COMMIT DROP AS
  SELECT "id" FROM "workflow_instances" WHERE "isDesign" = true;

DELETE FROM "workflow_mutations"          WHERE "instanceId" IN (SELECT "id" FROM _design_instance_ids);
DELETE FROM "workflow_events"             WHERE "instanceId" IN (SELECT "id" FROM _design_instance_ids);
DELETE FROM "tasks"                       WHERE "instanceId" IN (SELECT "id" FROM _design_instance_ids);
DELETE FROM "approval_requests"           WHERE "instanceId" IN (SELECT "id" FROM _design_instance_ids);
DELETE FROM "consumables"                 WHERE "instanceId" IN (SELECT "id" FROM _design_instance_ids);
DELETE FROM "agent_runs"                  WHERE "instanceId" IN (SELECT "id" FROM _design_instance_ids);
DELETE FROM "tool_runs"                   WHERE "instanceId" IN (SELECT "id" FROM _design_instance_ids);
DELETE FROM "pending_executions"          WHERE "instanceId" IN (SELECT "id" FROM _design_instance_ids);
DELETE FROM "documents"                   WHERE "instanceId" IN (SELECT "id" FROM _design_instance_ids);

-- 4. Delete the design instance rows.  ON DELETE CASCADE handles
--    workflow_phases / workflow_nodes / workflow_edges (these *are* set up
--    that way in the original schema).
DELETE FROM "workflow_instances" WHERE "isDesign" = true;

-- 5. Drop the discriminator
DROP INDEX IF EXISTS "workflow_instances_template_design_idx";
ALTER TABLE "workflow_instances" DROP COLUMN "isDesign";

-- 6. Index for run lookup by workflow (Prisma maps `workflowId` → column "templateId")
CREATE INDEX IF NOT EXISTS "workflow_instances_workflowId_idx" ON "workflow_instances"("templateId");
