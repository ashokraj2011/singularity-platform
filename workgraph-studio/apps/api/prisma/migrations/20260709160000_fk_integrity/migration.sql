-- P2 FK integrity.
--
-- 1) Runtime workflow_edges source/target FKs were ON DELETE RESTRICT (from the
--    init migration), unlike the design edges (Cascade). That means deleting a
--    runtime node errors on its edges / can leave dangling edges. Match the
--    design edges: ON DELETE CASCADE (deleting a node removes its edges).
ALTER TABLE "workflow_edges" DROP CONSTRAINT "workflow_edges_sourceNodeId_fkey";
ALTER TABLE "workflow_edges" ADD CONSTRAINT "workflow_edges_sourceNodeId_fkey"
  FOREIGN KEY ("sourceNodeId") REFERENCES "workflow_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workflow_edges" DROP CONSTRAINT "workflow_edges_targetNodeId_fkey";
ALTER TABLE "workflow_edges" ADD CONSTRAINT "workflow_edges_targetNodeId_fkey"
  FOREIGN KEY ("targetNodeId") REFERENCES "workflow_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 2) work_item_targets.childWorkflowTemplateId was a plain String with no FK to
--    workflow_templates (no referential integrity). Null any orphans first (a
--    template that was deleted), then add the FK (SET NULL on delete, matching
--    the sibling childWorkflowInstanceId relation).
UPDATE "work_item_targets"
   SET "childWorkflowTemplateId" = NULL
 WHERE "childWorkflowTemplateId" IS NOT NULL
   AND "childWorkflowTemplateId" NOT IN (SELECT "id" FROM "workflow_templates");
ALTER TABLE "work_item_targets" ADD CONSTRAINT "work_item_targets_childWorkflowTemplateId_fkey"
  FOREIGN KEY ("childWorkflowTemplateId") REFERENCES "workflow_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;
