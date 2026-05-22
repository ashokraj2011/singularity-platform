-- WorkItem-first metadata, routing, and trigger model.

ALTER TYPE "WorkItemStatus" ADD VALUE IF NOT EXISTS 'SCHEDULED';

ALTER TYPE "WorkItemEventType" ADD VALUE IF NOT EXISTS 'SCHEDULED';
ALTER TYPE "WorkItemEventType" ADD VALUE IF NOT EXISTS 'TRIGGERED';
ALTER TYPE "WorkItemEventType" ADD VALUE IF NOT EXISTS 'ROUTED';
ALTER TYPE "WorkItemEventType" ADD VALUE IF NOT EXISTS 'ATTACHED';
ALTER TYPE "WorkItemEventType" ADD VALUE IF NOT EXISTS 'AUTO_STARTED';
ALTER TYPE "WorkItemEventType" ADD VALUE IF NOT EXISTS 'ROUTE_FAILED';

DO $$ BEGIN
  CREATE TYPE "WorkItemRoutingMode" AS ENUM ('MANUAL', 'AUTO_ATTACH', 'AUTO_START', 'SCHEDULED_START');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "WorkItemRoutingState" AS ENUM ('UNROUTED', 'ROUTED', 'ATTACHED', 'STARTED', 'ROUTE_FAILED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "MetadataDefinitionKind" AS ENUM ('WORK_ITEM_TYPE', 'WORKFLOW_TYPE', 'NODE_TYPE', 'EVENT_TYPE', 'TRIGGER_PROFILE');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "MetadataDefinitionStatus" AS ENUM ('DRAFT', 'ACTIVE', 'DEPRECATED', 'ARCHIVED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "MetadataScopeType" AS ENUM ('GLOBAL', 'CAPABILITY', 'WORKFLOW', 'NODE');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "WorkItemTriggerType" AS ENUM ('EVENT', 'SCHEDULE', 'WEBHOOK');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "workflow_templates"
  ADD COLUMN IF NOT EXISTS "workflowTypeKey" TEXT NOT NULL DEFAULT 'GENERAL',
  ADD COLUMN IF NOT EXISTS "typeVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "typeSnapshot" JSONB,
  ADD COLUMN IF NOT EXISTS "eligibleWorkItemTypes" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS "isDefaultForType" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "defaultRoutingMode" "WorkItemRoutingMode" NOT NULL DEFAULT 'MANUAL';

UPDATE "workflow_templates"
SET "workflowTypeKey" = COALESCE(NULLIF(upper(("metadata"->>'workflowType')), ''), "workflowTypeKey", 'GENERAL')
WHERE "metadata" IS NOT NULL;

ALTER TABLE "workflow_design_nodes"
  ADD COLUMN IF NOT EXISTS "nodeTypeKey" TEXT,
  ADD COLUMN IF NOT EXISTS "nodeTypeVersion" INTEGER,
  ADD COLUMN IF NOT EXISTS "nodeTypeSnapshot" JSONB;

UPDATE "workflow_design_nodes"
SET "nodeTypeKey" = COALESCE("nodeTypeKey", "nodeType"::TEXT),
    "nodeTypeVersion" = COALESCE("nodeTypeVersion", 1);

ALTER TABLE "workflow_nodes"
  ADD COLUMN IF NOT EXISTS "nodeTypeKey" TEXT,
  ADD COLUMN IF NOT EXISTS "nodeTypeVersion" INTEGER,
  ADD COLUMN IF NOT EXISTS "nodeTypeSnapshot" JSONB;

UPDATE "workflow_nodes"
SET "nodeTypeKey" = COALESCE("nodeTypeKey", "nodeType"::TEXT),
    "nodeTypeVersion" = COALESCE("nodeTypeVersion", 1);

ALTER TABLE "work_items"
  ADD COLUMN IF NOT EXISTS "workItemTypeKey" TEXT NOT NULL DEFAULT 'GENERAL',
  ADD COLUMN IF NOT EXISTS "typeVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "typeSnapshot" JSONB,
  ADD COLUMN IF NOT EXISTS "routingMode" "WorkItemRoutingMode" NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN IF NOT EXISTS "scheduledAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "notBefore" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "sourceEventTypeKey" TEXT,
  ADD COLUMN IF NOT EXISTS "routingPolicyId" TEXT,
  ADD COLUMN IF NOT EXISTS "routingState" "WorkItemRoutingState" NOT NULL DEFAULT 'UNROUTED';

CREATE TABLE IF NOT EXISTS "metadata_definitions" (
  "id" TEXT PRIMARY KEY,
  "kind" "MetadataDefinitionKind" NOT NULL,
  "key" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "status" "MetadataDefinitionStatus" NOT NULL DEFAULT 'ACTIVE',
  "scopeType" "MetadataScopeType" NOT NULL DEFAULT 'GLOBAL',
  "scopeId" TEXT NOT NULL DEFAULT '*',
  "label" TEXT NOT NULL,
  "description" TEXT,
  "icon" TEXT,
  "color" TEXT,
  "category" TEXT,
  "schema" JSONB NOT NULL DEFAULT '{}',
  "defaults" JSONB NOT NULL DEFAULT '{}',
  "policy" JSONB NOT NULL DEFAULT '{}',
  "ui" JSONB NOT NULL DEFAULT '{}',
  "compatibility" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "metadata_definitions_kind_key_version_scopeType_scopeId_key"
  ON "metadata_definitions"("kind", "key", "version", "scopeType", "scopeId");
CREATE INDEX IF NOT EXISTS "metadata_definitions_kind_key_status_idx"
  ON "metadata_definitions"("kind", "key", "status");
CREATE INDEX IF NOT EXISTS "metadata_definitions_scopeType_scopeId_idx"
  ON "metadata_definitions"("scopeType", "scopeId");

CREATE TABLE IF NOT EXISTS "work_item_routing_policies" (
  "id" TEXT PRIMARY KEY,
  "capabilityId" TEXT NOT NULL,
  "workItemTypeKey" TEXT NOT NULL DEFAULT 'GENERAL',
  "workflowTypeKey" TEXT NOT NULL DEFAULT 'GENERAL',
  "workflowId" TEXT,
  "routingMode" "WorkItemRoutingMode" NOT NULL DEFAULT 'MANUAL',
  "priority" INTEGER NOT NULL DEFAULT 100,
  "selector" JSONB NOT NULL DEFAULT '{}',
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "work_item_routing_policies_workflowId_fkey"
    FOREIGN KEY ("workflowId") REFERENCES "workflow_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "work_item_routing_policies_capabilityId_workItemTypeKey_isActive_idx"
  ON "work_item_routing_policies"("capabilityId", "workItemTypeKey", "isActive");
CREATE INDEX IF NOT EXISTS "work_item_routing_policies_workflowTypeKey_idx"
  ON "work_item_routing_policies"("workflowTypeKey");
CREATE INDEX IF NOT EXISTS "work_item_routing_policies_workflowId_idx"
  ON "work_item_routing_policies"("workflowId");

ALTER TABLE "work_items"
  ADD CONSTRAINT "work_items_routingPolicyId_fkey"
    FOREIGN KEY ("routingPolicyId") REFERENCES "work_item_routing_policies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "work_item_triggers" (
  "id" TEXT PRIMARY KEY,
  "triggerType" "WorkItemTriggerType" NOT NULL,
  "eventTypeKey" TEXT,
  "capabilityId" TEXT,
  "workItemTypeKey" TEXT NOT NULL DEFAULT 'GENERAL',
  "routingMode" "WorkItemRoutingMode" NOT NULL DEFAULT 'MANUAL',
  "scheduleConfig" JSONB NOT NULL DEFAULT '{}',
  "payloadMapping" JSONB NOT NULL DEFAULT '{}',
  "dedupeKey" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "lastFiredAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "work_item_triggers_triggerType_isActive_idx"
  ON "work_item_triggers"("triggerType", "isActive");
CREATE INDEX IF NOT EXISTS "work_item_triggers_eventTypeKey_idx"
  ON "work_item_triggers"("eventTypeKey");
CREATE INDEX IF NOT EXISTS "work_item_triggers_capabilityId_workItemTypeKey_idx"
  ON "work_item_triggers"("capabilityId", "workItemTypeKey");
CREATE INDEX IF NOT EXISTS "work_item_triggers_dedupeKey_idx"
  ON "work_item_triggers"("dedupeKey");

CREATE INDEX IF NOT EXISTS "workflow_templates_capabilityId_workflowTypeKey_status_idx"
  ON "workflow_templates"("capabilityId", "workflowTypeKey", "status");
CREATE INDEX IF NOT EXISTS "workflow_templates_workflowTypeKey_isDefaultForType_idx"
  ON "workflow_templates"("workflowTypeKey", "isDefaultForType");
CREATE INDEX IF NOT EXISTS "work_items_workItemTypeKey_idx" ON "work_items"("workItemTypeKey");
CREATE INDEX IF NOT EXISTS "work_items_routingMode_idx" ON "work_items"("routingMode");
CREATE INDEX IF NOT EXISTS "work_items_routingState_idx" ON "work_items"("routingState");
CREATE INDEX IF NOT EXISTS "work_items_scheduledAt_idx" ON "work_items"("scheduledAt");
CREATE INDEX IF NOT EXISTS "work_items_notBefore_idx" ON "work_items"("notBefore");
CREATE INDEX IF NOT EXISTS "work_items_sourceEventTypeKey_idx" ON "work_items"("sourceEventTypeKey");
CREATE INDEX IF NOT EXISTS "work_items_routingPolicyId_idx" ON "work_items"("routingPolicyId");

INSERT INTO "metadata_definitions" ("id", "kind", "key", "version", "label", "description", "icon", "color", "category", "defaults", "policy", "ui", "compatibility")
VALUES
  ('meta-workitem-general-v1', 'WORK_ITEM_TYPE', 'GENERAL', 1, 'General WorkItem', 'Default WorkItem type for migrated and uncategorized work.', 'Inbox', '#64748b', 'Common', '{"urgency":"NORMAL","priority":50,"routingMode":"MANUAL"}', '{"allowedRoutingModes":["MANUAL","AUTO_ATTACH","AUTO_START","SCHEDULED_START"]}', '{}', '{}'),
  ('meta-workitem-bug-fix-v1', 'WORK_ITEM_TYPE', 'BUG_FIX', 1, 'Bug Fix', 'Defect correction or production issue remediation.', 'Bug', '#ef4444', 'Engineering', '{"urgency":"HIGH","priority":80,"routingMode":"AUTO_ATTACH"}', '{"compatibleWorkflowTypes":["BUG_FIX","SDLC","GENERAL"],"allowedRoutingModes":["MANUAL","AUTO_ATTACH","AUTO_START","SCHEDULED_START"]}', '{}', '{}'),
  ('meta-workitem-feature-v1', 'WORK_ITEM_TYPE', 'FEATURE', 1, 'Feature', 'New product or platform capability work.', 'Sparkles', '#2563eb', 'Engineering', '{"urgency":"NORMAL","priority":50,"routingMode":"MANUAL"}', '{"compatibleWorkflowTypes":["FEATURE","SDLC","GENERAL"]}', '{}', '{}'),
  ('meta-workitem-incident-v1', 'WORK_ITEM_TYPE', 'INCIDENT', 1, 'Incident', 'Urgent response or service-restoration work.', 'Siren', '#f97316', 'Operations', '{"urgency":"CRITICAL","priority":95,"routingMode":"AUTO_START"}', '{"compatibleWorkflowTypes":["INCIDENT","OPERATIONS","GENERAL"]}', '{}', '{}'),
  ('meta-workitem-research-v1', 'WORK_ITEM_TYPE', 'RESEARCH', 1, 'Research', 'Investigation, spike, or analysis work.', 'Search', '#0ea5e9', 'Discovery', '{"urgency":"NORMAL","priority":40,"routingMode":"MANUAL"}', '{"compatibleWorkflowTypes":["RESEARCH","GENERAL"]}', '{}', '{}'),
  ('meta-workitem-compliance-review-v1', 'WORK_ITEM_TYPE', 'COMPLIANCE_REVIEW', 1, 'Compliance Review', 'Governance, audit, or control review work.', 'ShieldCheck', '#7c3aed', 'Governance', '{"urgency":"HIGH","priority":70,"routingMode":"AUTO_ATTACH"}', '{"compatibleWorkflowTypes":["COMPLIANCE","GENERAL"],"requiresApproval":true}', '{}', '{}'),
  ('meta-workflow-general-v1', 'WORKFLOW_TYPE', 'GENERAL', 1, 'General Workflow', 'Default workflow type.', 'Workflow', '#64748b', 'Common', '{"routingMode":"MANUAL"}', '{"compatibleWorkItemTypes":["GENERAL","BUG_FIX","FEATURE","INCIDENT","RESEARCH","COMPLIANCE_REVIEW"]}', '{}', '{}'),
  ('meta-workflow-bug-fix-v1', 'WORKFLOW_TYPE', 'BUG_FIX', 1, 'Bug Fix Workflow', 'Workflow optimized for defect correction.', 'Bug', '#ef4444', 'Engineering', '{"routingMode":"AUTO_ATTACH"}', '{"compatibleWorkItemTypes":["BUG_FIX"]}', '{}', '{}'),
  ('meta-node-start-v1', 'NODE_TYPE', 'START', 1, 'Start', 'Workflow entry point.', 'Play', '#16a34a', 'Common', '{}', '{"runtimeBaseType":"START"}', '{}', '{}'),
  ('meta-node-workbench-v1', 'NODE_TYPE', 'WORKBENCH_TASK', 1, 'Workbench', 'Agentic story-to-delivery stage loop.', 'Braces', '#8b5cf6', 'Agentic', '{}', '{"runtimeBaseType":"WORKBENCH_TASK","canCreateWorkItems":true}', '{}', '{}'),
  ('meta-node-timer-v1', 'NODE_TYPE', 'TIMER', 1, 'Timer', 'Server-time delay or scheduled wait.', 'Clock', '#f59e0b', 'Logic', '{}', '{"runtimeBaseType":"TIMER","canSchedule":true}', '{}', '{}'),
  ('meta-node-event-gateway-v1', 'NODE_TYPE', 'EVENT_GATEWAY', 1, 'Event Gateway', 'Route based on event type and payload.', 'Radio', '#06b6d4', 'Logic', '{}', '{"runtimeBaseType":"EVENT_GATEWAY","canWaitForEvents":true}', '{}', '{}')
ON CONFLICT DO NOTHING;
