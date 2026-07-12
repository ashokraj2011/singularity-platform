-- Roadmap gap closure: durable debugging, collaboration, governance policy
-- versions, capacity planning, runtime device policy, and independent evidence.
-- All new records are tenant-keyed. Secrets and provider credentials remain
-- outside these tables.

ALTER TABLE "governance_waivers"
  ADD COLUMN IF NOT EXISTS "revokedBy" TEXT,
  ADD COLUMN IF NOT EXISTS "revokedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "revocationReason" TEXT;

ALTER TABLE "work_notifications"
  ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'PLATFORM',
  ADD COLUMN IF NOT EXISTS "threadKey" TEXT,
  ADD COLUMN IF NOT EXISTS "why" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS "deliveryPolicy" JSONB NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS "work_notifications_tenant_thread_created_idx"
  ON "work_notifications"("tenantId", "threadKey", "createdAt");

CREATE TABLE IF NOT EXISTS "workflow_run_clones" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "sourceInstanceId" TEXT NOT NULL,
  "cloneInstanceId" TEXT,
  "sourceCheckpointId" TEXT,
  "requestedById" TEXT,
  "tenantId" TEXT DEFAULT 'default',
  "reason" TEXT,
  "status" TEXT NOT NULL DEFAULT 'REQUESTED',
  "isolatedContext" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "error" TEXT,
  CONSTRAINT "workflow_run_clones_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "workflow_run_clones_tenant_source_created_idx"
  ON "workflow_run_clones"("tenantId", "sourceInstanceId", "createdAt");
CREATE INDEX IF NOT EXISTS "workflow_run_clones_clone_idx"
  ON "workflow_run_clones"("cloneInstanceId");

CREATE TABLE IF NOT EXISTS "workflow_template_migrations" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "templateId" TEXT NOT NULL,
  "fromVersion" INTEGER NOT NULL,
  "toVersion" INTEGER NOT NULL,
  "nodeMap" JSONB NOT NULL DEFAULT '{}',
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "warnings" JSONB NOT NULL DEFAULT '[]',
  "createdById" TEXT,
  "tenantId" TEXT DEFAULT 'default',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "appliedAt" TIMESTAMP(3),
  CONSTRAINT "workflow_template_migrations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "workflow_template_migrations_template_versions_key"
  ON "workflow_template_migrations"("templateId", "fromVersion", "toVersion");
CREATE INDEX IF NOT EXISTS "workflow_template_migrations_tenant_template_created_idx"
  ON "workflow_template_migrations"("tenantId", "templateId", "createdAt");

CREATE TABLE IF NOT EXISTS "workflow_time_travel_snapshots" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "instanceId" TEXT NOT NULL,
  "checkpointId" TEXT,
  "nodeId" TEXT,
  "tenantId" TEXT DEFAULT 'default',
  "context" JSONB NOT NULL DEFAULT '{}',
  "nodeStates" JSONB NOT NULL DEFAULT '{}',
  "routingDecisions" JSONB NOT NULL DEFAULT '[]',
  "promptReferences" JSONB NOT NULL DEFAULT '[]',
  "policySnapshot" JSONB NOT NULL DEFAULT '{}',
  "artifactReferences" JSONB NOT NULL DEFAULT '[]',
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "workflow_time_travel_snapshots_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "workflow_time_travel_tenant_instance_created_idx"
  ON "workflow_time_travel_snapshots"("tenantId", "instanceId", "createdAt");
CREATE INDEX IF NOT EXISTS "workflow_time_travel_checkpoint_idx"
  ON "workflow_time_travel_snapshots"("checkpointId");

CREATE TABLE IF NOT EXISTS "workflow_compensation_executions" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "instanceId" TEXT NOT NULL,
  "nodeId" TEXT NOT NULL,
  "actionKey" TEXT NOT NULL,
  "tenantId" TEXT DEFAULT 'default',
  "status" TEXT NOT NULL DEFAULT 'REQUESTED',
  "config" JSONB NOT NULL DEFAULT '{}',
  "result" JSONB,
  "requestedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "error" TEXT,
  CONSTRAINT "workflow_compensation_executions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "workflow_compensation_tenant_instance_created_idx"
  ON "workflow_compensation_executions"("tenantId", "instanceId", "createdAt");
CREATE INDEX IF NOT EXISTS "workflow_compensation_node_status_idx"
  ON "workflow_compensation_executions"("nodeId", "status");

CREATE TABLE IF NOT EXISTS "work_comments" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" TEXT DEFAULT 'default',
  "entityType" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "authorId" TEXT NOT NULL,
  "parentId" TEXT,
  "body" TEXT NOT NULL,
  "mentions" JSONB NOT NULL DEFAULT '[]',
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3),
  "resolvedBy" TEXT,
  CONSTRAINT "work_comments_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "work_comments_tenant_entity_created_idx"
  ON "work_comments"("tenantId", "entityType", "entityId", "createdAt");
CREATE INDEX IF NOT EXISTS "work_comments_tenant_author_created_idx"
  ON "work_comments"("tenantId", "authorId", "createdAt");

CREATE TABLE IF NOT EXISTS "notification_preferences" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" TEXT DEFAULT 'default',
  "userId" TEXT NOT NULL,
  "categories" JSONB NOT NULL DEFAULT '{}',
  "channels" JSONB NOT NULL DEFAULT '["IN_APP"]',
  "digestMode" TEXT NOT NULL DEFAULT 'IMMEDIATE',
  "quietHours" JSONB NOT NULL DEFAULT '{}',
  "severityMin" TEXT NOT NULL DEFAULT 'info',
  "timezone" TEXT NOT NULL DEFAULT 'UTC',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "notification_preferences_tenant_user_key"
  ON "notification_preferences"("tenantId", "userId");
ALTER TABLE "notification_preferences"
  ADD COLUMN IF NOT EXISTS "categories" JSONB NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS "notification_subscriptions" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" TEXT DEFAULT 'default',
  "userId" TEXT,
  "teamId" TEXT,
  "entityType" TEXT,
  "entityId" TEXT,
  "capabilityId" TEXT,
  "workflowId" TEXT,
  "severityMin" TEXT NOT NULL DEFAULT 'info',
  "channels" JSONB NOT NULL DEFAULT '["IN_APP"]',
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "notification_subscriptions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "notification_subscriptions_tenant_user_enabled_idx"
  ON "notification_subscriptions"("tenantId", "userId", "enabled");
CREATE INDEX IF NOT EXISTS "notification_subscriptions_tenant_entity_idx"
  ON "notification_subscriptions"("tenantId", "entityType", "entityId");
CREATE INDEX IF NOT EXISTS "notification_subscriptions_tenant_capability_workflow_idx"
  ON "notification_subscriptions"("tenantId", "capabilityId", "workflowId");

CREATE TABLE IF NOT EXISTS "notification_deliveries" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "notificationId" TEXT NOT NULL,
  "tenantId" TEXT DEFAULT 'default',
  "channel" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "providerId" TEXT,
  "lastError" TEXT,
  "nextAttemptAt" TIMESTAMP(3),
  "deliveredAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "notification_deliveries_notification_channel_key"
  ON "notification_deliveries"("notificationId", "channel");
CREATE INDEX IF NOT EXISTS "notification_deliveries_tenant_status_retry_idx"
  ON "notification_deliveries"("tenantId", "status", "nextAttemptAt");

CREATE TABLE IF NOT EXISTS "notification_audit" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "notificationId" TEXT NOT NULL,
  "tenantId" TEXT DEFAULT 'default',
  "actorId" TEXT,
  "action" TEXT NOT NULL,
  "channel" TEXT,
  "details" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "notification_audit_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "notification_audit_tenant_notification_created_idx"
  ON "notification_audit"("tenantId", "notificationId", "createdAt");

CREATE TABLE IF NOT EXISTS "out_of_office_delegations" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" TEXT DEFAULT 'default',
  "principalUserId" TEXT NOT NULL,
  "delegateUserId" TEXT NOT NULL,
  "startsAt" TIMESTAMP(3) NOT NULL,
  "endsAt" TIMESTAMP(3) NOT NULL,
  "reason" TEXT,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" TIMESTAMP(3),
  CONSTRAINT "out_of_office_delegations_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ooo_tenant_principal_window_idx"
  ON "out_of_office_delegations"("tenantId", "principalUserId", "startsAt", "endsAt");
CREATE INDEX IF NOT EXISTS "ooo_tenant_delegate_status_idx"
  ON "out_of_office_delegations"("tenantId", "delegateUserId", "status");

CREATE TABLE IF NOT EXISTS "governance_policies" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" TEXT DEFAULT 'default',
  "name" TEXT NOT NULL,
  "description" TEXT,
  "capabilityId" TEXT,
  "workflowId" TEXT,
  "workItemTypeKey" TEXT,
  "mode" TEXT NOT NULL DEFAULT 'ADVISORY',
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "currentVersion" INTEGER NOT NULL DEFAULT 1,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "governance_policies_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "governance_policies_tenant_status_mode_idx"
  ON "governance_policies"("tenantId", "status", "mode");
CREATE INDEX IF NOT EXISTS "governance_policies_tenant_capability_workflow_idx"
  ON "governance_policies"("tenantId", "capabilityId", "workflowId");

CREATE TABLE IF NOT EXISTS "governance_policy_versions" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "policyId" TEXT NOT NULL,
  "tenantId" TEXT DEFAULT 'default',
  "version" INTEGER NOT NULL,
  "mode" TEXT NOT NULL,
  "rules" JSONB NOT NULL DEFAULT '[]',
  "snapshot" JSONB NOT NULL DEFAULT '{}',
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "activatedAt" TIMESTAMP(3),
  CONSTRAINT "governance_policy_versions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "governance_policy_versions_policy_version_key"
  ON "governance_policy_versions"("policyId", "version");
CREATE INDEX IF NOT EXISTS "governance_policy_versions_tenant_policy_created_idx"
  ON "governance_policy_versions"("tenantId", "policyId", "createdAt");

CREATE TABLE IF NOT EXISTS "governance_policy_evaluations" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "policyId" TEXT NOT NULL,
  "policyVersion" INTEGER NOT NULL,
  "tenantId" TEXT DEFAULT 'default',
  "instanceId" TEXT,
  "nodeId" TEXT,
  "workItemId" TEXT,
  "mode" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "evidence" JSONB NOT NULL DEFAULT '{}',
  "missing" JSONB NOT NULL DEFAULT '[]',
  "result" JSONB NOT NULL DEFAULT '{}',
  "evaluatedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "governance_policy_evaluations_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "governance_policy_evaluations_tenant_policy_created_idx"
  ON "governance_policy_evaluations"("tenantId", "policyId", "createdAt");
CREATE INDEX IF NOT EXISTS "governance_policy_evaluations_tenant_instance_node_idx"
  ON "governance_policy_evaluations"("tenantId", "instanceId", "nodeId");

CREATE TABLE IF NOT EXISTS "capacity_calendars" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" TEXT DEFAULT 'default',
  "ownerType" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "timezone" TEXT NOT NULL DEFAULT 'UTC',
  "weeklyHours" JSONB NOT NULL DEFAULT '{}',
  "holidays" JSONB NOT NULL DEFAULT '[]',
  "wipLimit" INTEGER,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "capacity_calendars_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "capacity_calendars_tenant_owner_key"
  ON "capacity_calendars"("tenantId", "ownerType", "ownerId");

CREATE TABLE IF NOT EXISTS "capacity_allocations" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" TEXT DEFAULT 'default',
  "calendarId" TEXT NOT NULL,
  "workItemId" TEXT,
  "programStepId" TEXT,
  "capabilityId" TEXT,
  "skillKey" TEXT,
  "startAt" TIMESTAMP(3) NOT NULL,
  "endAt" TIMESTAMP(3) NOT NULL,
  "estimatedHours" DOUBLE PRECISION NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PLANNED',
  "risk" TEXT NOT NULL DEFAULT 'LOW',
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "capacity_allocations_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "capacity_allocations_tenant_calendar_window_idx"
  ON "capacity_allocations"("tenantId", "calendarId", "startAt", "endAt");
CREATE INDEX IF NOT EXISTS "capacity_allocations_tenant_work_item_idx"
  ON "capacity_allocations"("tenantId", "workItemId");
CREATE INDEX IF NOT EXISTS "capacity_allocations_tenant_capability_skill_idx"
  ON "capacity_allocations"("tenantId", "capabilityId", "skillKey");

CREATE TABLE IF NOT EXISTS "planning_forecasts" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" TEXT DEFAULT 'default',
  "plannerSessionId" TEXT,
  "capabilityId" TEXT,
  "scenario" JSONB NOT NULL DEFAULT '{}',
  "status" TEXT NOT NULL DEFAULT 'COMPLETED',
  "result" JSONB NOT NULL DEFAULT '{}',
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "planning_forecasts_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "planning_forecasts_tenant_session_created_idx"
  ON "planning_forecasts"("tenantId", "plannerSessionId", "createdAt");

CREATE TABLE IF NOT EXISTS "runtime_policies" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" TEXT DEFAULT 'default',
  "name" TEXT NOT NULL,
  "minVersion" TEXT,
  "allowedPaths" JSONB NOT NULL DEFAULT '[]',
  "consentMode" TEXT NOT NULL DEFAULT 'PER_ACTION',
  "autoUpdate" BOOLEAN NOT NULL DEFAULT true,
  "killSwitch" BOOLEAN NOT NULL DEFAULT false,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "runtime_policies_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "runtime_policies_tenant_name_key"
  ON "runtime_policies"("tenantId", "name");

CREATE TABLE IF NOT EXISTS "runtime_devices" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" TEXT DEFAULT 'default',
  "userId" TEXT NOT NULL,
  "runtimeId" TEXT NOT NULL,
  "deviceName" TEXT NOT NULL,
  "platform" TEXT NOT NULL,
  "version" TEXT,
  "status" TEXT NOT NULL DEFAULT 'ENROLLED',
  "policyId" TEXT,
  "workspaceProfiles" JSONB NOT NULL DEFAULT '[]',
  "lastSeenAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "runtime_devices_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "runtime_devices_runtime_id_key" ON "runtime_devices"("runtimeId");
CREATE INDEX IF NOT EXISTS "runtime_devices_tenant_user_status_idx" ON "runtime_devices"("tenantId", "userId", "status");
CREATE INDEX IF NOT EXISTS "runtime_devices_tenant_policy_idx" ON "runtime_devices"("tenantId", "policyId");

CREATE TABLE IF NOT EXISTS "runtime_consents" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" TEXT DEFAULT 'default',
  "runtimeId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "scope" TEXT NOT NULL,
  "decision" TEXT NOT NULL,
  "reason" TEXT,
  "expiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "runtime_consents_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "runtime_consents_tenant_runtime_created_idx" ON "runtime_consents"("tenantId", "runtimeId", "createdAt");
CREATE INDEX IF NOT EXISTS "runtime_consents_tenant_user_action_scope_idx" ON "runtime_consents"("tenantId", "userId", "action", "scope");

CREATE TABLE IF NOT EXISTS "grounding_evidence" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" TEXT DEFAULT 'default',
  "instanceId" TEXT,
  "nodeId" TEXT,
  "agentRunId" TEXT,
  "sourceType" TEXT NOT NULL,
  "sourceUri" TEXT,
  "contentHash" TEXT,
  "retrievedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "influenceScore" DOUBLE PRECISION,
  "outcome" TEXT,
  "feedback" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "grounding_evidence_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "grounding_evidence_tenant_instance_node_retrieved_idx" ON "grounding_evidence"("tenantId", "instanceId", "nodeId", "retrievedAt");
CREATE INDEX IF NOT EXISTS "grounding_evidence_tenant_hash_idx" ON "grounding_evidence"("tenantId", "contentHash");

CREATE TABLE IF NOT EXISTS "code_impact_snapshots" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" TEXT DEFAULT 'default',
  "instanceId" TEXT,
  "nodeId" TEXT,
  "workItemId" TEXT,
  "commitSha" TEXT,
  "query" TEXT,
  "provider" TEXT NOT NULL DEFAULT 'LEXICAL',
  "files" JSONB NOT NULL DEFAULT '[]',
  "callGraph" JSONB NOT NULL DEFAULT '{}',
  "matches" JSONB NOT NULL DEFAULT '[]',
  "riskScore" DOUBLE PRECISION,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "code_impact_snapshots_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "code_impact_snapshots_tenant_instance_created_idx" ON "code_impact_snapshots"("tenantId", "instanceId", "createdAt");
CREATE INDEX IF NOT EXISTS "code_impact_snapshots_tenant_commit_idx" ON "code_impact_snapshots"("tenantId", "commitSha");

CREATE TABLE IF NOT EXISTS "independent_verifications" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" TEXT DEFAULT 'default',
  "instanceId" TEXT,
  "nodeId" TEXT,
  "workItemId" TEXT,
  "commitSha" TEXT,
  "environment" TEXT,
  "command" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'REQUESTED',
  "result" JSONB NOT NULL DEFAULT '{}',
  "testSummary" JSONB NOT NULL DEFAULT '{}',
  "coverage" JSONB NOT NULL DEFAULT '{}',
  "riskScore" DOUBLE PRECISION,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "requestedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "independent_verifications_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "independent_verifications_tenant_instance_created_idx" ON "independent_verifications"("tenantId", "instanceId", "createdAt");
CREATE INDEX IF NOT EXISTS "independent_verifications_tenant_commit_idx" ON "independent_verifications"("tenantId", "commitSha");

CREATE TABLE IF NOT EXISTS "verification_findings" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "verificationId" TEXT NOT NULL,
  "tenantId" TEXT DEFAULT 'default',
  "filePath" TEXT,
  "ruleKey" TEXT,
  "severity" TEXT NOT NULL DEFAULT 'INFO',
  "message" TEXT NOT NULL,
  "evidence" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "verification_findings_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "verification_findings_tenant_verification_severity_idx" ON "verification_findings"("tenantId", "verificationId", "severity");
