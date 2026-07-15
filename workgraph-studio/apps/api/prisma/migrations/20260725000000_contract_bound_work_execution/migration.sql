-- Contract-bound Work Execution: additive migration.
-- Existing WorkItem/specification/reconciliation rows remain valid. New paths use
-- immutable bindings, scopes, handoffs, commands, and the finalization record.

DO $$ BEGIN ALTER TYPE "WorkItemStatus" ADD VALUE IF NOT EXISTS 'BLOCKED'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE "WorkItemStatus" ADD VALUE IF NOT EXISTS 'AWAITING_FINALIZATION'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE "WorkItemTargetStatus" ADD VALUE IF NOT EXISTS 'STARTING'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE "WorkItemTargetStatus" ADD VALUE IF NOT EXISTS 'ACCEPTED'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE "WorkItemTargetStatus" ADD VALUE IF NOT EXISTS 'BLOCKED'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE "WorkItemEventType" ADD VALUE IF NOT EXISTS 'SPECIFICATION_BOUND'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE "WorkItemEventType" ADD VALUE IF NOT EXISTS 'HANDOFF_PUBLISHED'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE "WorkItemEventType" ADD VALUE IF NOT EXISTS 'RECONCILIATION_CONTESTED'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE "WorkItemEventType" ADD VALUE IF NOT EXISTS 'RECONCILIATION_EVIDENCE_UPDATED'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE "WorkItemEventType" ADD VALUE IF NOT EXISTS 'WORK_ITEM_FINALIZATION_REQUESTED'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE "WorkItemEventType" ADD VALUE IF NOT EXISTS 'WORK_ITEM_FINALIZED'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE "WorkItemEventType" ADD VALUE IF NOT EXISTS 'WORK_ITEM_CANCELLATION_REQUESTED'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE "SpecificationStatus" ADD VALUE IF NOT EXISTS 'LOCKED'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE "SpecificationStatus" ADD VALUE IF NOT EXISTS 'GENERATING'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE "SpecificationStatus" ADD VALUE IF NOT EXISTS 'ACTIVE'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE "SpecificationStatus" ADD VALUE IF NOT EXISTS 'CHANGE_REQUESTED'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE "SpecificationProjectStatus" ADD VALUE IF NOT EXISTS 'DRAFT'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE "SpecificationProjectStatus" ADD VALUE IF NOT EXISTS 'IN_REVIEW'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE "SpecificationProjectStatus" ADD VALUE IF NOT EXISTS 'LOCKED'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE "SpecificationProjectStatus" ADD VALUE IF NOT EXISTS 'GENERATING'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE "SpecificationProjectStatus" ADD VALUE IF NOT EXISTS 'CHANGE_REQUESTED'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE "WorkItemOriginType" ADD VALUE IF NOT EXISTS 'SPEC_GENERATED'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE "ReconciliationStatus" ADD VALUE IF NOT EXISTS 'DECLARED_CONSISTENT'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE "ReconciliationStatus" ADD VALUE IF NOT EXISTS 'SEMANTICALLY_REVIEWED'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE "ReconciliationStatus" ADD VALUE IF NOT EXISTS 'VERIFIED_PASS'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE "ReconciliationStatus" ADD VALUE IF NOT EXISTS 'CANCELLED'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE "ReconciliationJobStatus" ADD VALUE IF NOT EXISTS 'DEAD_LETTERED'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE "ReconciliationState" AS ENUM ('UNVERIFIED','VERIFYING','VERIFIED','CONTESTED','NOT_VERIFIED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "DevelopmentScopeStatus" AS ENUM ('DRAFT','HANDOFF_PUBLISHED','IMPLEMENTING','SUBMITTED','RECONCILING','ACCEPTED','REWORK_REQUIRED','CANCELLED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "HandoffGenerationStatus" AS ENUM ('DRAFT','PUBLISHED','SUPERSEDED','CANCELLED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "FinalizationStatus" AS ENUM ('REQUESTED','ACCEPTED','COMPLETED','REJECTED','STALE'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "WorkCommandStatus" AS ENUM ('REQUESTED','IN_PROGRESS','COMPLETED','FAILED','STALE'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "GenerationPlanStatus" AS ENUM ('DRAFT','VALIDATED','APPLYING','PARTIAL','APPLIED','FAILED','STALE'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "workflow_instances" ADD COLUMN IF NOT EXISTS "graphGeneration" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "work_items" ADD COLUMN IF NOT EXISTS "reconciliationState" "ReconciliationState" NOT NULL DEFAULT 'UNVERIFIED';
ALTER TABLE "work_items" ADD COLUMN IF NOT EXISTS "completionPolicy" TEXT NOT NULL DEFAULT 'VERIFY_THEN_APPROVE';
ALTER TABLE "work_items" ADD COLUMN IF NOT EXISTS "finalizationGeneration" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "work_items" ADD COLUMN IF NOT EXISTS "specSourceRef" JSONB;

ALTER TABLE "specification_versions" ALTER COLUMN "workItemId" DROP NOT NULL;
ALTER TABLE "specification_versions" ADD COLUMN IF NOT EXISTS "specificationProjectId" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "specification_versions_specificationProjectId_version_key" ON "specification_versions"("specificationProjectId", "version");
CREATE INDEX IF NOT EXISTS "specification_versions_specificationProjectId_status_idx" ON "specification_versions"("specificationProjectId", "status");
DO $$ BEGIN
  ALTER TABLE "specification_versions" ADD CONSTRAINT "specification_versions_specificationProjectId_fkey"
    FOREIGN KEY ("specificationProjectId") REFERENCES "specification_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "implementation_submissions" ADD COLUMN IF NOT EXISTS "specificationBindingId" TEXT;
ALTER TABLE "implementation_submissions" ADD COLUMN IF NOT EXISTS "developmentScopeId" TEXT;
ALTER TABLE "implementation_submissions" ADD COLUMN IF NOT EXISTS "handoffGenerationId" TEXT;
ALTER TABLE "reconciliation_runs" ADD COLUMN IF NOT EXISTS "specificationBindingId" TEXT;
ALTER TABLE "reconciliation_runs" ADD COLUMN IF NOT EXISTS "developmentScopeId" TEXT;
ALTER TABLE "reconciliation_runs" ADD COLUMN IF NOT EXISTS "handoffGenerationId" TEXT;
ALTER TABLE "reconciliation_runs" ADD COLUMN IF NOT EXISTS "generation" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "reconciliation_runs" ADD COLUMN IF NOT EXISTS "reconciliationState" "ReconciliationState" NOT NULL DEFAULT 'UNVERIFIED';
ALTER TABLE "reconciliation_jobs" ADD COLUMN IF NOT EXISTS "generation" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "reconciliation_jobs" ADD COLUMN IF NOT EXISTS "leaseUntil" TIMESTAMP(3);
ALTER TABLE "reconciliation_jobs" ADD COLUMN IF NOT EXISTS "heartbeatAt" TIMESTAMP(3);
ALTER TABLE "reconciliation_jobs" ADD COLUMN IF NOT EXISTS "maxAttempts" INTEGER NOT NULL DEFAULT 3;
ALTER TABLE "reconciliation_jobs" ADD COLUMN IF NOT EXISTS "deadLetterReason" TEXT;

CREATE TABLE IF NOT EXISTS "work_item_specification_bindings" (
  "id" TEXT NOT NULL,
  "workItemId" TEXT NOT NULL,
  "specificationVersionId" TEXT NOT NULL,
  "bindingGeneration" INTEGER NOT NULL DEFAULT 1,
  "resolvedPackage" JSONB NOT NULL,
  "resolvedContentHash" TEXT NOT NULL,
  "requirementIds" JSONB NOT NULL DEFAULT '[]',
  "status" TEXT NOT NULL DEFAULT 'CURRENT',
  "boundById" TEXT,
  "boundAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "tenantId" TEXT DEFAULT 'default',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "work_item_specification_bindings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "work_item_specification_bindings_workItemId_bindingGeneration_key" ON "work_item_specification_bindings"("workItemId", "bindingGeneration");
CREATE INDEX IF NOT EXISTS "work_item_specification_bindings_workItemId_status_idx" ON "work_item_specification_bindings"("workItemId", "status");
CREATE INDEX IF NOT EXISTS "work_item_specification_bindings_tenantId_idx" ON "work_item_specification_bindings"("tenantId");

CREATE TABLE IF NOT EXISTS "development_scopes" (
  "id" TEXT NOT NULL,
  "workItemId" TEXT NOT NULL,
  "workItemTargetId" TEXT NOT NULL,
  "specificationBindingId" TEXT,
  "targetCapabilityId" TEXT NOT NULL,
  "repository" TEXT NOT NULL,
  "component" TEXT,
  "requirementIds" JSONB NOT NULL DEFAULT '[]',
  "mandatory" BOOLEAN NOT NULL DEFAULT TRUE,
  "status" "DevelopmentScopeStatus" NOT NULL DEFAULT 'DRAFT',
  "currentHandoffGenerationId" TEXT,
  "tenantId" TEXT DEFAULT 'default',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "development_scopes_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "development_scopes_workItemId_status_idx" ON "development_scopes"("workItemId", "status");
CREATE INDEX IF NOT EXISTS "development_scopes_workItemTargetId_idx" ON "development_scopes"("workItemTargetId");
CREATE INDEX IF NOT EXISTS "development_scopes_tenantId_idx" ON "development_scopes"("tenantId");

CREATE TABLE IF NOT EXISTS "handoff_generations" (
  "id" TEXT NOT NULL,
  "developmentScopeId" TEXT NOT NULL,
  "generation" INTEGER NOT NULL DEFAULT 1,
  "specificationBindingId" TEXT,
  "repository" TEXT NOT NULL,
  "component" TEXT,
  "baseBranch" TEXT NOT NULL,
  "baseCommitSha" TEXT NOT NULL,
  "requirementIds" JSONB NOT NULL DEFAULT '[]',
  "requiredEvidence" JSONB NOT NULL DEFAULT '[]',
  "forbiddenPaths" JSONB NOT NULL DEFAULT '[]',
  "reconciliationPolicy" JSONB NOT NULL DEFAULT '{}',
  "contentHash" TEXT NOT NULL,
  "status" "HandoffGenerationStatus" NOT NULL DEFAULT 'DRAFT',
  "publishedById" TEXT,
  "publishedAt" TIMESTAMP(3),
  "tenantId" TEXT DEFAULT 'default',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "handoff_generations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "handoff_generations_developmentScopeId_generation_key" ON "handoff_generations"("developmentScopeId", "generation");
CREATE INDEX IF NOT EXISTS "handoff_generations_status_createdAt_idx" ON "handoff_generations"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "handoff_generations_tenantId_idx" ON "handoff_generations"("tenantId");

DO $$ BEGIN
  ALTER TABLE "development_scopes" ADD CONSTRAINT "development_scopes_currentHandoffGenerationId_fkey"
    FOREIGN KEY ("currentHandoffGenerationId") REFERENCES "handoff_generations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "work_item_finalization_records" (
  "id" TEXT NOT NULL,
  "workItemId" TEXT NOT NULL,
  "finalizationGeneration" INTEGER NOT NULL,
  "status" "FinalizationStatus" NOT NULL DEFAULT 'REQUESTED',
  "actorId" TEXT,
  "finalOutput" JSONB,
  "evidenceDigest" TEXT,
  "reason" TEXT,
  "tenantId" TEXT DEFAULT 'default',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "work_item_finalization_records_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "work_item_finalization_records_workItemId_finalizationGeneration_key" ON "work_item_finalization_records"("workItemId", "finalizationGeneration");
CREATE INDEX IF NOT EXISTS "work_item_finalization_records_tenantId_status_idx" ON "work_item_finalization_records"("tenantId", "status");

CREATE TABLE IF NOT EXISTS "work_item_creation_commands" (
  "id" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "workItemId" TEXT,
  "state" "WorkCommandStatus" NOT NULL DEFAULT 'REQUESTED',
  "error" TEXT,
  "tenantId" TEXT DEFAULT 'default',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "work_item_creation_commands_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "work_item_creation_commands_idempotencyKey_key" ON "work_item_creation_commands"("idempotencyKey");
CREATE INDEX IF NOT EXISTS "work_item_creation_commands_tenantId_state_idx" ON "work_item_creation_commands"("tenantId", "state");

CREATE TABLE IF NOT EXISTS "workflow_start_commands" (
  "id" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "workItemTargetId" TEXT NOT NULL,
  "workflowInstanceId" TEXT,
  "state" "WorkCommandStatus" NOT NULL DEFAULT 'REQUESTED',
  "attempt" INTEGER NOT NULL DEFAULT 0,
  "leaseUntil" TIMESTAMP(3),
  "error" TEXT,
  "tenantId" TEXT DEFAULT 'default',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "workflow_start_commands_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "workflow_start_commands_idempotencyKey_key" ON "workflow_start_commands"("idempotencyKey");
CREATE INDEX IF NOT EXISTS "workflow_start_commands_workItemTargetId_state_idx" ON "workflow_start_commands"("workItemTargetId", "state");
CREATE INDEX IF NOT EXISTS "workflow_start_commands_tenantId_state_idx" ON "workflow_start_commands"("tenantId", "state");

CREATE TABLE IF NOT EXISTS "generation_plans" (
  "id" TEXT NOT NULL,
  "specificationProjectId" TEXT NOT NULL,
  "specificationVersionId" TEXT,
  "status" "GenerationPlanStatus" NOT NULL DEFAULT 'DRAFT',
  "contentHash" TEXT NOT NULL,
  "requestId" TEXT,
  "validation" JSONB NOT NULL DEFAULT '{}',
  "appliedRows" INTEGER NOT NULL DEFAULT 0,
  "totalRows" INTEGER NOT NULL DEFAULT 0,
  "createdById" TEXT,
  "tenantId" TEXT DEFAULT 'default',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "generation_plans_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "generation_plans_specificationProjectId_status_idx" ON "generation_plans"("specificationProjectId", "status");
CREATE INDEX IF NOT EXISTS "generation_plans_tenantId_idx" ON "generation_plans"("tenantId");

CREATE TABLE IF NOT EXISTS "generation_plan_rows" (
  "id" TEXT NOT NULL,
  "planId" TEXT NOT NULL,
  "rowKey" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "targetCapabilityId" TEXT NOT NULL,
  "childWorkflowTemplateId" TEXT,
  "repository" TEXT,
  "component" TEXT,
  "baseBranch" TEXT,
  "baseCommitSha" TEXT,
  "requirementIds" JSONB NOT NULL DEFAULT '[]',
  "requiredEvidence" JSONB NOT NULL DEFAULT '[]',
  "forbiddenPaths" JSONB NOT NULL DEFAULT '[]',
  "reconciliationPolicy" JSONB NOT NULL DEFAULT '{}',
  "dependencies" JSONB NOT NULL DEFAULT '[]',
  "workItemId" TEXT,
  "state" TEXT NOT NULL DEFAULT 'PENDING',
  "error" TEXT,
  "tenantId" TEXT DEFAULT 'default',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "generation_plan_rows_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "generation_plan_rows_planId_rowKey_key" ON "generation_plan_rows"("planId", "rowKey");
CREATE INDEX IF NOT EXISTS "generation_plan_rows_workItemId_idx" ON "generation_plan_rows"("workItemId");
CREATE INDEX IF NOT EXISTS "generation_plan_rows_tenantId_state_idx" ON "generation_plan_rows"("tenantId", "state");

DO $$ BEGIN ALTER TABLE "work_item_specification_bindings" ADD CONSTRAINT "work_item_specification_bindings_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "work_items"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "work_item_specification_bindings" ADD CONSTRAINT "work_item_specification_bindings_specificationVersionId_fkey" FOREIGN KEY ("specificationVersionId") REFERENCES "specification_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "development_scopes" ADD CONSTRAINT "development_scopes_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "work_items"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "development_scopes" ADD CONSTRAINT "development_scopes_workItemTargetId_fkey" FOREIGN KEY ("workItemTargetId") REFERENCES "work_item_targets"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "development_scopes" ADD CONSTRAINT "development_scopes_specificationBindingId_fkey" FOREIGN KEY ("specificationBindingId") REFERENCES "work_item_specification_bindings"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "handoff_generations" ADD CONSTRAINT "handoff_generations_developmentScopeId_fkey" FOREIGN KEY ("developmentScopeId") REFERENCES "development_scopes"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "handoff_generations" ADD CONSTRAINT "handoff_generations_specificationBindingId_fkey" FOREIGN KEY ("specificationBindingId") REFERENCES "work_item_specification_bindings"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "work_item_finalization_records" ADD CONSTRAINT "work_item_finalization_records_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "work_items"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "work_item_creation_commands" ADD CONSTRAINT "work_item_creation_commands_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "work_items"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "workflow_start_commands" ADD CONSTRAINT "workflow_start_commands_workItemTargetId_fkey" FOREIGN KEY ("workItemTargetId") REFERENCES "work_item_targets"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "workflow_start_commands" ADD CONSTRAINT "workflow_start_commands_workflowInstanceId_fkey" FOREIGN KEY ("workflowInstanceId") REFERENCES "workflow_instances"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "generation_plans" ADD CONSTRAINT "generation_plans_specificationProjectId_fkey" FOREIGN KEY ("specificationProjectId") REFERENCES "specification_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "generation_plans" ADD CONSTRAINT "generation_plans_specificationVersionId_fkey" FOREIGN KEY ("specificationVersionId") REFERENCES "specification_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "generation_plan_rows" ADD CONSTRAINT "generation_plan_rows_planId_fkey" FOREIGN KEY ("planId") REFERENCES "generation_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "generation_plan_rows" ADD CONSTRAINT "generation_plan_rows_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "work_items"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "implementation_submissions" ADD CONSTRAINT "implementation_submissions_specificationBindingId_fkey" FOREIGN KEY ("specificationBindingId") REFERENCES "work_item_specification_bindings"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "implementation_submissions" ADD CONSTRAINT "implementation_submissions_developmentScopeId_fkey" FOREIGN KEY ("developmentScopeId") REFERENCES "development_scopes"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "implementation_submissions" ADD CONSTRAINT "implementation_submissions_handoffGenerationId_fkey" FOREIGN KEY ("handoffGenerationId") REFERENCES "handoff_generations"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "reconciliation_runs" ADD CONSTRAINT "reconciliation_runs_specificationBindingId_fkey" FOREIGN KEY ("specificationBindingId") REFERENCES "work_item_specification_bindings"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "reconciliation_runs" ADD CONSTRAINT "reconciliation_runs_developmentScopeId_fkey" FOREIGN KEY ("developmentScopeId") REFERENCES "development_scopes"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "reconciliation_runs" ADD CONSTRAINT "reconciliation_runs_handoffGenerationId_fkey" FOREIGN KEY ("handoffGenerationId") REFERENCES "handoff_generations"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
