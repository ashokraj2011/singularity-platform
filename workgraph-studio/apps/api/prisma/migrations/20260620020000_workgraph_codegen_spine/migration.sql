-- Workgraph-owned Code Generation / Foundry run spine.
--
-- The standalone Foundry tables are folded into Workgraph so SDLC
-- generation runs, artifacts, gaps, patch tasks, verifications, and receipts
-- live beside workflow execution evidence.

CREATE TABLE IF NOT EXISTS "codegen_specs" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "specName" TEXT NOT NULL,
  "version" TEXT NOT NULL DEFAULT '1.0.0',
  "kind" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'DRAFT',
  "yaml" TEXT NOT NULL,
  "canonicalJson" JSONB NOT NULL,
  "specHash" TEXT NOT NULL,
  "irJson" JSONB,
  "irHash" TEXT,
  "workItemId" TEXT,
  "createdById" TEXT,
  "tenantId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "codegen_specs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "codegen_specs_specName_version_key"
  ON "codegen_specs"("specName", "version");
CREATE INDEX IF NOT EXISTS "codegen_specs_state_createdAt_idx"
  ON "codegen_specs"("state", "createdAt");
CREATE INDEX IF NOT EXISTS "codegen_specs_specHash_idx"
  ON "codegen_specs"("specHash");
CREATE INDEX IF NOT EXISTS "codegen_specs_tenantId_idx"
  ON "codegen_specs"("tenantId");

CREATE TABLE IF NOT EXISTS "codegen_spec_lifecycle_events" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "specId" TEXT NOT NULL,
  "fromState" TEXT,
  "toState" TEXT NOT NULL,
  "actorId" TEXT,
  "reason" TEXT,
  "payload" JSONB,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "codegen_spec_lifecycle_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "codegen_spec_lifecycle_events_specId_fkey"
    FOREIGN KEY ("specId") REFERENCES "codegen_specs"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "codegen_spec_lifecycle_events_specId_occurredAt_idx"
  ON "codegen_spec_lifecycle_events"("specId", "occurredAt");

CREATE TABLE IF NOT EXISTS "codegen_repo_models" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "repoPath" TEXT NOT NULL,
  "language" TEXT NOT NULL,
  "framework" TEXT NOT NULL,
  "modelJson" JSONB NOT NULL,
  "modelHash" TEXT NOT NULL,
  "scannedById" TEXT,
  "tenantId" TEXT,
  "scannedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "codegen_repo_models_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "codegen_repo_models_repoPath_scannedAt_idx"
  ON "codegen_repo_models"("repoPath", "scannedAt");
CREATE INDEX IF NOT EXISTS "codegen_repo_models_modelHash_idx"
  ON "codegen_repo_models"("modelHash");
CREATE INDEX IF NOT EXISTS "codegen_repo_models_tenantId_idx"
  ON "codegen_repo_models"("tenantId");

CREATE TABLE IF NOT EXISTS "codegen_change_plans" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "repoModelId" TEXT NOT NULL,
  "enhancementSpecJson" JSONB NOT NULL,
  "enhancementSpecHash" TEXT NOT NULL,
  "planJson" JSONB NOT NULL,
  "planHash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PROPOSED',
  "tenantId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "appliedAt" TIMESTAMP(3),
  CONSTRAINT "codegen_change_plans_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "codegen_change_plans_repoModelId_fkey"
    FOREIGN KEY ("repoModelId") REFERENCES "codegen_repo_models"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "codegen_change_plans_repoModelId_idx"
  ON "codegen_change_plans"("repoModelId");
CREATE INDEX IF NOT EXISTS "codegen_change_plans_status_idx"
  ON "codegen_change_plans"("status");
CREATE INDEX IF NOT EXISTS "codegen_change_plans_tenantId_idx"
  ON "codegen_change_plans"("tenantId");

CREATE TABLE IF NOT EXISTS "codegen_runs" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "specId" TEXT NOT NULL,
  "irHash" TEXT NOT NULL,
  "templateVersion" TEXT NOT NULL,
  "generatorVersion" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'STARTED',
  "mode" TEXT NOT NULL DEFAULT 'GREENFIELD',
  "brownfieldPlanId" TEXT,
  "outputPath" TEXT,
  "workflowInstanceId" TEXT,
  "tenantId" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "codegen_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "codegen_runs_specId_fkey"
    FOREIGN KEY ("specId") REFERENCES "codegen_specs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "codegen_runs_brownfieldPlanId_fkey"
    FOREIGN KEY ("brownfieldPlanId") REFERENCES "codegen_change_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "codegen_runs_specId_startedAt_idx"
  ON "codegen_runs"("specId", "startedAt");
CREATE INDEX IF NOT EXISTS "codegen_runs_status_idx"
  ON "codegen_runs"("status");
CREATE INDEX IF NOT EXISTS "codegen_runs_mode_idx"
  ON "codegen_runs"("mode");
CREATE INDEX IF NOT EXISTS "codegen_runs_workflowInstanceId_idx"
  ON "codegen_runs"("workflowInstanceId");
CREATE INDEX IF NOT EXISTS "codegen_runs_tenantId_idx"
  ON "codegen_runs"("tenantId");

CREATE TABLE IF NOT EXISTS "codegen_artifacts" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "runId" TEXT NOT NULL,
  "path" TEXT NOT NULL,
  "contentHash" TEXT NOT NULL,
  "fileType" TEXT NOT NULL,
  "generatedBy" TEXT NOT NULL,
  "protected" BOOLEAN NOT NULL DEFAULT false,
  "content" TEXT,
  "sizeBytes" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "codegen_artifacts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "codegen_artifacts_runId_fkey"
    FOREIGN KEY ("runId") REFERENCES "codegen_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "codegen_artifacts_runId_path_key"
  ON "codegen_artifacts"("runId", "path");
CREATE INDEX IF NOT EXISTS "codegen_artifacts_runId_idx"
  ON "codegen_artifacts"("runId");

CREATE TABLE IF NOT EXISTS "codegen_gaps" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "runId" TEXT NOT NULL,
  "gapType" TEXT NOT NULL,
  "severity" TEXT NOT NULL DEFAULT 'medium',
  "filePath" TEXT,
  "className" TEXT,
  "methodName" TEXT,
  "regionId" TEXT,
  "description" TEXT NOT NULL,
  "recommendedResolution" TEXT,
  "llmEligible" BOOLEAN NOT NULL DEFAULT false,
  "resolved" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3),
  CONSTRAINT "codegen_gaps_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "codegen_gaps_runId_fkey"
    FOREIGN KEY ("runId") REFERENCES "codegen_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "codegen_gaps_runId_resolved_idx"
  ON "codegen_gaps"("runId", "resolved");
CREATE INDEX IF NOT EXISTS "codegen_gaps_gapType_idx"
  ON "codegen_gaps"("gapType");

CREATE TABLE IF NOT EXISTS "codegen_llm_patch_tasks" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "runId" TEXT NOT NULL,
  "gapId" TEXT,
  "taskType" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "targetFile" TEXT NOT NULL,
  "targetClass" TEXT,
  "targetMethod" TEXT,
  "regionId" TEXT NOT NULL,
  "allowedChanges" JSONB NOT NULL,
  "forbiddenChanges" JSONB NOT NULL,
  "promptHash" TEXT,
  "responseHash" TEXT,
  "cfCallId" TEXT,
  "bundleHash" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "dispatchedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "codegen_llm_patch_tasks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "codegen_llm_patch_tasks_runId_fkey"
    FOREIGN KEY ("runId") REFERENCES "codegen_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "codegen_llm_patch_tasks_runId_status_idx"
  ON "codegen_llm_patch_tasks"("runId", "status");
CREATE INDEX IF NOT EXISTS "codegen_llm_patch_tasks_gapId_idx"
  ON "codegen_llm_patch_tasks"("gapId");

CREATE TABLE IF NOT EXISTS "codegen_verifications" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "runId" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "result" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "codegen_verifications_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "codegen_verifications_runId_fkey"
    FOREIGN KEY ("runId") REFERENCES "codegen_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "codegen_verifications_runId_createdAt_idx"
  ON "codegen_verifications"("runId", "createdAt");

CREATE TABLE IF NOT EXISTS "codegen_receipts" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "runId" TEXT NOT NULL,
  "receiptJson" JSONB NOT NULL,
  "receiptHash" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "codegen_receipts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "codegen_receipts_runId_fkey"
    FOREIGN KEY ("runId") REFERENCES "codegen_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "codegen_receipts_runId_key"
  ON "codegen_receipts"("runId");
CREATE INDEX IF NOT EXISTS "codegen_receipts_receiptHash_idx"
  ON "codegen_receipts"("receiptHash");
