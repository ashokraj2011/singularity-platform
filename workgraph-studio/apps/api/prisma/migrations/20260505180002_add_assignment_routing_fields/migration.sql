-- TeamQueueItem: support role/skill/capability eligibility filters
ALTER TABLE "team_queue_items" ALTER COLUMN "teamId" DROP NOT NULL;
ALTER TABLE "team_queue_items" ADD COLUMN "roleKey"        TEXT;
ALTER TABLE "team_queue_items" ADD COLUMN "skillKey"       TEXT;
ALTER TABLE "team_queue_items" ADD COLUMN "capabilityId"   TEXT;
ALTER TABLE "team_queue_items" ADD COLUMN "assignmentMode" TEXT;
CREATE INDEX "team_queue_items_taskId_idx"      ON "team_queue_items"("taskId");
CREATE INDEX "team_queue_items_teamId_idx"      ON "team_queue_items"("teamId");
CREATE INDEX "team_queue_items_role_cap_idx"    ON "team_queue_items"("roleKey", "capabilityId");
CREATE INDEX "team_queue_items_skillKey_idx"    ON "team_queue_items"("skillKey");
CREATE INDEX "team_queue_items_claimedById_idx" ON "team_queue_items"("claimedById");

-- ApprovalRequest: same routing fields as Task
ALTER TABLE "approval_requests" ADD COLUMN "assignmentMode" TEXT;
ALTER TABLE "approval_requests" ADD COLUMN "teamId"         TEXT;
ALTER TABLE "approval_requests" ADD COLUMN "roleKey"        TEXT;
ALTER TABLE "approval_requests" ADD COLUMN "skillKey"       TEXT;
ALTER TABLE "approval_requests" ADD COLUMN "capabilityId"   TEXT;
CREATE INDEX "approval_requests_assignedToId_idx" ON "approval_requests"("assignedToId");
CREATE INDEX "approval_requests_teamId_idx"       ON "approval_requests"("teamId");
CREATE INDEX "approval_requests_role_cap_idx"     ON "approval_requests"("roleKey", "capabilityId");
CREATE INDEX "approval_requests_skillKey_idx"     ON "approval_requests"("skillKey");

-- Consumable: same routing fields
ALTER TABLE "consumables" ADD COLUMN "assignedToId"   TEXT;
ALTER TABLE "consumables" ADD COLUMN "assignmentMode" TEXT;
ALTER TABLE "consumables" ADD COLUMN "teamId"         TEXT;
ALTER TABLE "consumables" ADD COLUMN "roleKey"        TEXT;
ALTER TABLE "consumables" ADD COLUMN "skillKey"       TEXT;
ALTER TABLE "consumables" ADD COLUMN "capabilityId"   TEXT;
CREATE INDEX "consumables_assignedToId_idx" ON "consumables"("assignedToId");
CREATE INDEX "consumables_teamId_idx"       ON "consumables"("teamId");
CREATE INDEX "consumables_role_cap_idx"     ON "consumables"("roleKey", "capabilityId");
CREATE INDEX "consumables_skillKey_idx"     ON "consumables"("skillKey");
