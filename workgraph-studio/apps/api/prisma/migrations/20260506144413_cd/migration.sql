-- DropForeignKey
ALTER TABLE "team_queue_items" DROP CONSTRAINT "team_queue_items_teamId_fkey";

-- AddForeignKey
ALTER TABLE "workflow_instances" ADD CONSTRAINT "workflow_instances_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "workflow_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_queue_items" ADD CONSTRAINT "team_queue_items_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "approval_requests_role_cap_idx" RENAME TO "approval_requests_roleKey_capabilityId_idx";

-- RenameIndex
ALTER INDEX "consumables_role_cap_idx" RENAME TO "consumables_roleKey_capabilityId_idx";

-- RenameIndex
ALTER INDEX "team_queue_items_role_cap_idx" RENAME TO "team_queue_items_roleKey_capabilityId_idx";

-- RenameIndex
ALTER INDEX "workflow_instances_workflowId_idx" RENAME TO "workflow_instances_templateId_idx";

-- RenameIndex
ALTER INDEX "workflow_template_versions_template_hash_idx" RENAME TO "workflow_template_versions_templateId_contentHash_idx";
