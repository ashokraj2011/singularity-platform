-- Enterprise workflow authorization hardening.
-- Existing rows stay usable through the default tenant and legacy permission
-- table; new access grants and authorization snapshots are additive.

ALTER TABLE "workflow_templates"
  ADD COLUMN IF NOT EXISTS "tenantId" TEXT DEFAULT 'default';

UPDATE "workflow_templates"
SET "tenantId" = 'default'
WHERE "tenantId" IS NULL;

CREATE INDEX IF NOT EXISTS "workflow_templates_tenantId_idx"
  ON "workflow_templates"("tenantId");

CREATE TABLE IF NOT EXISTS "workflow_access_grants" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "workflowId" TEXT NOT NULL,
  "tenantId" TEXT DEFAULT 'default',
  "subjectType" TEXT NOT NULL,
  "subjectId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "effect" TEXT NOT NULL DEFAULT 'ALLOW',
  "startsAt" TIMESTAMP(3),
  "endsAt" TIMESTAMP(3),
  "createdById" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "workflow_access_grants_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "workflow_access_grants_workflowId_fkey"
    FOREIGN KEY ("workflowId") REFERENCES "workflow_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "workflow_access_grants_workflow_subject_action_key"
  ON "workflow_access_grants"("workflowId", "subjectType", "subjectId", "action");
CREATE INDEX IF NOT EXISTS "workflow_access_grants_tenant_subject_idx"
  ON "workflow_access_grants"("tenantId", "subjectType", "subjectId");
CREATE INDEX IF NOT EXISTS "workflow_access_grants_workflow_action_idx"
  ON "workflow_access_grants"("workflowId", "action", "effect");

CREATE TABLE IF NOT EXISTS "workflow_authorization_snapshots" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "instanceId" TEXT NOT NULL,
  "tenantId" TEXT,
  "actorIamUserId" TEXT,
  "actorWorkGraphId" TEXT,
  "runOwnerId" TEXT,
  "workflowId" TEXT,
  "capabilityId" TEXT,
  "policyVersion" TEXT NOT NULL DEFAULT 'v1',
  "effectiveRoles" JSONB NOT NULL DEFAULT '[]',
  "effectivePermissions" JSONB NOT NULL DEFAULT '[]',
  "resourceGrants" JSONB NOT NULL DEFAULT '[]',
  "snapshotDigest" TEXT NOT NULL,
  "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "workflow_authorization_snapshots_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "workflow_authorization_snapshots_instanceId_key" UNIQUE ("instanceId"),
  CONSTRAINT "workflow_authorization_snapshots_instanceId_fkey"
    FOREIGN KEY ("instanceId") REFERENCES "workflow_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "workflow_authz_snapshots_tenant_actor_idx"
  ON "workflow_authorization_snapshots"("tenantId", "actorIamUserId");
CREATE INDEX IF NOT EXISTS "workflow_authz_snapshots_workflow_idx"
  ON "workflow_authorization_snapshots"("workflowId");
