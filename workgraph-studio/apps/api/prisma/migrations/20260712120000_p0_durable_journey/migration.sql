-- P0 durable user journey: planner drafts, dependencies/programs, approval
-- quorum/escalation, notifications, and workflow simulation/replay evidence.
-- The new tables are tenant-keyed; existing RLS deployments can add policies
-- in their tenant hardening migration without changing the application API.

ALTER TABLE "approval_requests"
  ADD COLUMN IF NOT EXISTS "quorumRequired" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "adminOverride" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "quorumMetAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "escalationPolicy" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS "escalationLevel" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "nextEscalationAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lastEscalatedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX IF NOT EXISTS "approval_decisions_requestId_decidedById_key"
  ON "approval_decisions"("requestId", "decidedById");

CREATE TABLE IF NOT EXISTS "work_item_dependencies" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "predecessorId" TEXT NOT NULL,
  "successorId" TEXT NOT NULL,
  "dependencyType" TEXT NOT NULL DEFAULT 'BLOCKS',
  "condition" JSONB,
  "createdById" TEXT,
  "tenantId" TEXT DEFAULT 'default',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "work_item_dependencies_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "work_item_dependencies_predecessor_fkey" FOREIGN KEY ("predecessorId") REFERENCES "work_items"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "work_item_dependencies_successor_fkey" FOREIGN KEY ("successorId") REFERENCES "work_items"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "work_item_dependencies_predecessorId_successorId_key" ON "work_item_dependencies"("predecessorId", "successorId");
CREATE INDEX IF NOT EXISTS "work_item_dependencies_tenantId_idx" ON "work_item_dependencies"("tenantId");
CREATE INDEX IF NOT EXISTS "work_item_dependencies_predecessorId_idx" ON "work_item_dependencies"("predecessorId");
CREATE INDEX IF NOT EXISTS "work_item_dependencies_successorId_idx" ON "work_item_dependencies"("successorId");

CREATE TABLE IF NOT EXISTS "work_programs" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "description" TEXT,
  "capabilityId" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdById" TEXT,
  "tenantId" TEXT DEFAULT 'default',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "work_programs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "work_programs_tenantId_idx" ON "work_programs"("tenantId");
CREATE INDEX IF NOT EXISTS "work_programs_capabilityId_status_idx" ON "work_programs"("capabilityId", "status");

CREATE TABLE IF NOT EXISTS "work_program_steps" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "programId" TEXT NOT NULL,
  "stepKey" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL DEFAULT 0,
  "titleTemplate" TEXT NOT NULL,
  "descriptionTemplate" TEXT,
  "workItemTypeKey" TEXT NOT NULL DEFAULT 'GENERAL',
  "targetCapabilityId" TEXT NOT NULL,
  "workflowTemplateId" TEXT,
  "routingMode" "WorkItemRoutingMode" NOT NULL DEFAULT 'MANUAL',
  "inputMapping" JSONB NOT NULL DEFAULT '{}',
  "dependsOnKeys" JSONB NOT NULL DEFAULT '[]',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "work_program_steps_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "work_program_steps_program_fkey" FOREIGN KEY ("programId") REFERENCES "work_programs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "work_program_steps_workflow_fkey" FOREIGN KEY ("workflowTemplateId") REFERENCES "workflow_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "work_program_steps_programId_stepKey_key" ON "work_program_steps"("programId", "stepKey");
CREATE INDEX IF NOT EXISTS "work_program_steps_workflowTemplateId_idx" ON "work_program_steps"("workflowTemplateId");
CREATE INDEX IF NOT EXISTS "work_program_steps_programId_ordinal_idx" ON "work_program_steps"("programId", "ordinal");

CREATE TABLE IF NOT EXISTS "work_program_runs" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "programId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'RUNNING',
  "input" JSONB NOT NULL DEFAULT '{}',
  "output" JSONB,
  "startedById" TEXT,
  "tenantId" TEXT DEFAULT 'default',
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "work_program_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "work_program_runs_program_fkey" FOREIGN KEY ("programId") REFERENCES "work_programs"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "work_program_runs_tenantId_status_idx" ON "work_program_runs"("tenantId", "status");
CREATE INDEX IF NOT EXISTS "work_program_runs_programId_startedAt_idx" ON "work_program_runs"("programId", "startedAt");

CREATE TABLE IF NOT EXISTS "work_program_run_steps" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "runId" TEXT NOT NULL,
  "stepId" TEXT NOT NULL,
  "workItemId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'QUEUED',
  "output" JSONB,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "work_program_run_steps_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "work_program_run_steps_run_fkey" FOREIGN KEY ("runId") REFERENCES "work_program_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "work_program_run_steps_step_fkey" FOREIGN KEY ("stepId") REFERENCES "work_program_steps"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "work_program_run_steps_work_item_fkey" FOREIGN KEY ("workItemId") REFERENCES "work_items"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "work_program_run_steps_runId_stepId_key" ON "work_program_run_steps"("runId", "stepId");
CREATE INDEX IF NOT EXISTS "work_program_run_steps_workItemId_idx" ON "work_program_run_steps"("workItemId");

CREATE TABLE IF NOT EXISTS "planner_sessions" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "capabilityId" TEXT NOT NULL,
  "createdById" TEXT NOT NULL,
  "title" TEXT,
  "story" TEXT,
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "intent" TEXT,
  "modelAlias" TEXT,
  "runtimePreference" TEXT,
  "governancePreset" TEXT,
  "messages" JSONB NOT NULL DEFAULT '[]',
  "milestones" JSONB NOT NULL DEFAULT '[]',
  "critic" JSONB,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "version" INTEGER NOT NULL DEFAULT 1,
  "tenantId" TEXT DEFAULT 'default',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "planner_sessions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "planner_sessions_tenant_created_updated_idx" ON "planner_sessions"("tenantId", "createdById", "updatedAt");
CREATE INDEX IF NOT EXISTS "planner_sessions_capability_status_idx" ON "planner_sessions"("capabilityId", "status");

CREATE TABLE IF NOT EXISTS "planner_session_revisions" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "sessionId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "messages" JSONB NOT NULL DEFAULT '[]',
  "milestones" JSONB NOT NULL DEFAULT '[]',
  "response" JSONB,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "planner_session_revisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "planner_session_revisions_session_fkey" FOREIGN KEY ("sessionId") REFERENCES "planner_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "planner_session_revisions_sessionId_version_key" ON "planner_session_revisions"("sessionId", "version");
CREATE INDEX IF NOT EXISTS "planner_session_revisions_sessionId_createdAt_idx" ON "planner_session_revisions"("sessionId", "createdAt");

CREATE TABLE IF NOT EXISTS "work_notifications" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "userId" TEXT,
  "teamId" TEXT,
  "tenantId" TEXT DEFAULT 'default',
  "kind" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "severity" TEXT NOT NULL DEFAULT 'info',
  "status" TEXT NOT NULL DEFAULT 'UNREAD',
  "entityType" TEXT,
  "entityId" TEXT,
  "href" TEXT,
  "payload" JSONB NOT NULL DEFAULT '{}',
  "dueAt" TIMESTAMP(3),
  "readAt" TIMESTAMP(3),
  "resolvedAt" TIMESTAMP(3),
  "snoozedUntil" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "work_notifications_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "work_notifications_tenant_user_status_idx" ON "work_notifications"("tenantId", "userId", "status", "createdAt");
CREATE INDEX IF NOT EXISTS "work_notifications_tenant_team_status_idx" ON "work_notifications"("tenantId", "teamId", "status", "createdAt");
CREATE INDEX IF NOT EXISTS "work_notifications_entity_idx" ON "work_notifications"("entityType", "entityId");

CREATE TABLE IF NOT EXISTS "workflow_checkpoints" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "instanceId" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "checkpointType" TEXT NOT NULL DEFAULT 'AUTO',
  "nodeId" TEXT,
  "nodeStates" JSONB NOT NULL DEFAULT '{}',
  "context" JSONB NOT NULL DEFAULT '{}',
  "traceId" TEXT,
  "reason" TEXT,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "workflow_checkpoints_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "workflow_checkpoints_instance_fkey" FOREIGN KEY ("instanceId") REFERENCES "workflow_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "workflow_checkpoints_instanceId_sequence_key" ON "workflow_checkpoints"("instanceId", "sequence");
CREATE INDEX IF NOT EXISTS "workflow_checkpoints_instance_created_idx" ON "workflow_checkpoints"("instanceId", "createdAt");
CREATE INDEX IF NOT EXISTS "workflow_checkpoints_traceId_idx" ON "workflow_checkpoints"("traceId");

CREATE TABLE IF NOT EXISTS "workflow_simulations" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "workflowTemplateId" TEXT NOT NULL,
  "createdById" TEXT,
  "tenantId" TEXT DEFAULT 'default',
  "status" TEXT NOT NULL DEFAULT 'COMPLETED',
  "input" JSONB NOT NULL DEFAULT '{}',
  "result" JSONB,
  "traceId" TEXT,
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "workflow_simulations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "workflow_simulations_workflow_fkey" FOREIGN KEY ("workflowTemplateId") REFERENCES "workflow_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "workflow_simulations_tenant_workflow_created_idx" ON "workflow_simulations"("tenantId", "workflowTemplateId", "createdAt");
CREATE INDEX IF NOT EXISTS "workflow_simulations_traceId_idx" ON "workflow_simulations"("traceId");

CREATE TABLE IF NOT EXISTS "workflow_replays" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "instanceId" TEXT NOT NULL,
  "checkpointId" TEXT,
  "requestedById" TEXT,
  "status" TEXT NOT NULL DEFAULT 'REQUESTED',
  "input" JSONB NOT NULL DEFAULT '{}',
  "result" JSONB,
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "workflow_replays_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "workflow_replays_instance_fkey" FOREIGN KEY ("instanceId") REFERENCES "workflow_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "workflow_replays_checkpoint_fkey" FOREIGN KEY ("checkpointId") REFERENCES "workflow_checkpoints"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "workflow_replays_instance_created_idx" ON "workflow_replays"("instanceId", "createdAt");
CREATE INDEX IF NOT EXISTS "workflow_replays_checkpoint_idx" ON "workflow_replays"("checkpointId");

CREATE TABLE IF NOT EXISTS "approval_escalations" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "requestId" TEXT NOT NULL,
  "level" INTEGER NOT NULL,
  "targetUserId" TEXT,
  "targetTeamId" TEXT,
  "targetRoleKey" TEXT,
  "targetSkillKey" TEXT,
  "reason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "approval_escalations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "approval_escalations_request_fkey" FOREIGN KEY ("requestId") REFERENCES "approval_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "approval_escalations_requestId_level_key" ON "approval_escalations"("requestId", "level");
CREATE INDEX IF NOT EXISTS "approval_escalations_targetUserId_idx" ON "approval_escalations"("targetUserId");
CREATE INDEX IF NOT EXISTS "approval_escalations_targetTeamId_idx" ON "approval_escalations"("targetTeamId");
