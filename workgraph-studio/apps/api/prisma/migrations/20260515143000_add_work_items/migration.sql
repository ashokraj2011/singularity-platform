ALTER TYPE "NodeType" ADD VALUE IF NOT EXISTS 'WORK_ITEM';

CREATE TABLE "work_items" (
  "id"                       TEXT PRIMARY KEY,
  "title"                    TEXT NOT NULL,
  "description"              TEXT,
  "parentCapabilityId"       TEXT,
  "sourceWorkflowInstanceId" TEXT,
  "sourceWorkflowNodeId"     TEXT,
  "status"                   TEXT NOT NULL DEFAULT 'QUEUED',
  "input"                    JSONB NOT NULL DEFAULT '{}',
  "finalOutput"              JSONB,
  "priority"                 INTEGER NOT NULL DEFAULT 50,
  "dueAt"                    TIMESTAMP(3),
  "createdById"              TEXT,
  "approvedById"             TEXT,
  "parentApprovalRequestId"  TEXT,
  "createdAt"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "work_items_sourceWorkflowInstanceId_fkey"
    FOREIGN KEY ("sourceWorkflowInstanceId") REFERENCES "workflow_instances"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "work_items_sourceWorkflowNodeId_fkey"
    FOREIGN KEY ("sourceWorkflowNodeId") REFERENCES "workflow_nodes"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "work_items_parentCapabilityId_idx" ON "work_items"("parentCapabilityId");
CREATE INDEX "work_items_sourceWorkflowInstanceId_idx" ON "work_items"("sourceWorkflowInstanceId");
CREATE INDEX "work_items_sourceWorkflowNodeId_idx" ON "work_items"("sourceWorkflowNodeId");
CREATE INDEX "work_items_status_idx" ON "work_items"("status");

CREATE TABLE "work_item_targets" (
  "id"                      TEXT PRIMARY KEY,
  "workItemId"              TEXT NOT NULL,
  "targetCapabilityId"      TEXT NOT NULL,
  "childWorkflowTemplateId" TEXT,
  "childWorkflowInstanceId" TEXT,
  "roleKey"                 TEXT,
  "status"                  TEXT NOT NULL DEFAULT 'QUEUED',
  "claimedById"             TEXT,
  "output"                  JSONB,
  "claimedAt"               TIMESTAMP(3),
  "startedAt"               TIMESTAMP(3),
  "submittedAt"             TIMESTAMP(3),
  "completedAt"             TIMESTAMP(3),
  "createdAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "work_item_targets_workItemId_fkey"
    FOREIGN KEY ("workItemId") REFERENCES "work_items"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "work_item_targets_childWorkflowInstanceId_fkey"
    FOREIGN KEY ("childWorkflowInstanceId") REFERENCES "workflow_instances"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "work_item_targets_workItemId_idx" ON "work_item_targets"("workItemId");
CREATE INDEX "work_item_targets_targetCapabilityId_status_idx" ON "work_item_targets"("targetCapabilityId", "status");
CREATE INDEX "work_item_targets_childWorkflowTemplateId_idx" ON "work_item_targets"("childWorkflowTemplateId");
CREATE INDEX "work_item_targets_childWorkflowInstanceId_idx" ON "work_item_targets"("childWorkflowInstanceId");
CREATE INDEX "work_item_targets_claimedById_idx" ON "work_item_targets"("claimedById");

CREATE TABLE "work_item_events" (
  "id"         TEXT PRIMARY KEY,
  "workItemId" TEXT NOT NULL,
  "targetId"   TEXT,
  "eventType"  TEXT NOT NULL,
  "actorId"    TEXT,
  "payload"    JSONB,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "work_item_events_workItemId_fkey"
    FOREIGN KEY ("workItemId") REFERENCES "work_items"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "work_item_events_targetId_fkey"
    FOREIGN KEY ("targetId") REFERENCES "work_item_targets"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "work_item_events_workItemId_createdAt_idx" ON "work_item_events"("workItemId", "createdAt");
CREATE INDEX "work_item_events_targetId_idx" ON "work_item_events"("targetId");
CREATE INDEX "work_item_events_eventType_idx" ON "work_item_events"("eventType");
