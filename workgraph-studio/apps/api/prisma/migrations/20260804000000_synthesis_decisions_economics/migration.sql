ALTER TABLE "concept_cards"
  ADD COLUMN IF NOT EXISTS "claimRefs" JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS "decision_dossiers" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "problem" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "claimRefs" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "resolvesTensions" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "acceptedOptionId" TEXT,
  "approvalRequestId" TEXT,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "createdById" TEXT NOT NULL,
  "decidedById" TEXT,
  "decidedAt" TIMESTAMP(3),
  "supersedesId" TEXT,
  "tenantId" TEXT DEFAULT 'default',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "decision_dossiers_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "decision_dossiers_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "specification_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "decision_options" (
  "id" TEXT NOT NULL,
  "dossierId" TEXT NOT NULL,
  "conceptCardId" TEXT,
  "title" TEXT NOT NULL,
  "summary" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "claimRefs" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "tradeoffs" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "estimatedHours" DOUBLE PRECISION,
  "estimatedCostLow" DOUBLE PRECISION,
  "estimatedCostHigh" DOUBLE PRECISION,
  "estimatedTokens" INTEGER,
  "riskScore" INTEGER,
  "createdById" TEXT,
  "tenantId" TEXT DEFAULT 'default',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "decision_options_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "decision_options_dossierId_fkey" FOREIGN KEY ("dossierId") REFERENCES "decision_dossiers"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

ALTER TABLE "generation_plan_rows"
  ADD COLUMN IF NOT EXISTS "decisionRefs" JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS "claimRefs" JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS "estimatedHours" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "rateBand" TEXT,
  ADD COLUMN IF NOT EXISTS "estimatedCostLow" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "estimatedCostHigh" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "estimatedTokens" INTEGER,
  ADD COLUMN IF NOT EXISTS "projectedStartAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "projectedFinishAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "criticalPath" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "project_budget_envelopes" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "budgetLow" DOUBLE PRECISION,
  "budgetHigh" DOUBLE PRECISION,
  "tokenLimit" INTEGER,
  "warningPercent" INTEGER NOT NULL DEFAULT 80,
  "hardCapPercent" INTEGER NOT NULL DEFAULT 120,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "overrideApprovalId" TEXT,
  "createdById" TEXT,
  "tenantId" TEXT DEFAULT 'default',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "project_budget_envelopes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_budget_envelopes_projectId_key" UNIQUE ("projectId"),
  CONSTRAINT "project_budget_envelopes_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "specification_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "project_token_ledger" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "evidenceKey" TEXT NOT NULL,
  "workflowInstanceId" TEXT,
  "workflowNodeId" TEXT,
  "artifactId" TEXT,
  "stage" TEXT,
  "provider" TEXT,
  "model" TEXT,
  "inputTokens" INTEGER NOT NULL DEFAULT 0,
  "outputTokens" INTEGER NOT NULL DEFAULT 0,
  "totalTokens" INTEGER NOT NULL DEFAULT 0,
  "estimatedCostUsd" DOUBLE PRECISION,
  "traceId" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "tenantId" TEXT DEFAULT 'default',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "project_token_ledger_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_token_ledger_evidenceKey_key" UNIQUE ("evidenceKey"),
  CONSTRAINT "project_token_ledger_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "specification_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "decision_dossiers_projectId_status_updatedAt_idx" ON "decision_dossiers"("projectId", "status", "updatedAt");
CREATE INDEX IF NOT EXISTS "decision_dossiers_tenantId_status_idx" ON "decision_dossiers"("tenantId", "status");
CREATE INDEX IF NOT EXISTS "decision_options_dossierId_status_idx" ON "decision_options"("dossierId", "status");
CREATE INDEX IF NOT EXISTS "decision_options_tenantId_idx" ON "decision_options"("tenantId");
CREATE INDEX IF NOT EXISTS "project_budget_envelopes_tenantId_status_idx" ON "project_budget_envelopes"("tenantId", "status");
CREATE INDEX IF NOT EXISTS "project_token_ledger_projectId_createdAt_idx" ON "project_token_ledger"("projectId", "createdAt");
CREATE INDEX IF NOT EXISTS "project_token_ledger_tenantId_stage_idx" ON "project_token_ledger"("tenantId", "stage");
