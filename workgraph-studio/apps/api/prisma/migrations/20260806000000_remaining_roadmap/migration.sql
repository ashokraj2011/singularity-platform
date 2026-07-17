-- Complete the idea-to-verified-check-in roadmap with durable drift, change-control,
-- replanning, capacity, actuals, and budget-control evidence.

ALTER TYPE "WorkItemOriginType" ADD VALUE IF NOT EXISTS 'AD_HOC';

CREATE TYPE "ChangeControlStatus" AS ENUM ('RECOMMENDED', 'OPEN', 'APPROVED', 'REJECTED', 'APPLIED');
CREATE TYPE "PlanAmendmentStatus" AS ENUM ('DRAFT', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'APPLIED');
CREATE TYPE "BudgetControlStatus" AS ENUM ('HEALTHY', 'WARNING', 'EXCEEDED', 'HARD_CAP');

ALTER TABLE "generation_plan_rows"
  ADD COLUMN "capacityCalendarId" TEXT,
  ADD COLUMN "capacityAllocationId" TEXT,
  ADD COLUMN "actualStartAt" TIMESTAMP(3),
  ADD COLUMN "actualFinishAt" TIMESTAMP(3),
  ADD COLUMN "actualHours" DOUBLE PRECISION,
  ADD COLUMN "actualCostUsd" DOUBLE PRECISION;

ALTER TABLE "project_budget_envelopes"
  ADD COLUMN "stageBudgets" JSONB NOT NULL DEFAULT '{}';

CREATE INDEX "generation_plan_rows_capacityCalendarId_idx" ON "generation_plan_rows"("capacityCalendarId");
CREATE INDEX "generation_plan_rows_capacityAllocationId_idx" ON "generation_plan_rows"("capacityAllocationId");

CREATE TABLE "generation_plan_amendments" (
  "id" TEXT NOT NULL,
  "planId" TEXT NOT NULL,
  "generation" INTEGER NOT NULL,
  "status" "PlanAmendmentStatus" NOT NULL DEFAULT 'DRAFT',
  "reason" TEXT NOT NULL,
  "requestedStartAt" TIMESTAMP(3),
  "proposedSchedule" JSONB NOT NULL DEFAULT '[]',
  "previousScheduleHash" TEXT NOT NULL,
  "proposedScheduleHash" TEXT NOT NULL,
  "createdById" TEXT NOT NULL,
  "approvedById" TEXT,
  "approvedAt" TIMESTAMP(3),
  "appliedAt" TIMESTAMP(3),
  "tenantId" TEXT DEFAULT 'default',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "generation_plan_amendments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "generation_plan_amendments_planId_fkey" FOREIGN KEY ("planId") REFERENCES "generation_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "generation_plan_amendments_planId_generation_key" ON "generation_plan_amendments"("planId", "generation");
CREATE INDEX "generation_plan_amendments_tenantId_status_idx" ON "generation_plan_amendments"("tenantId", "status");

CREATE TABLE "project_budget_events" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "evidenceKey" TEXT NOT NULL,
  "scopeType" TEXT NOT NULL,
  "scopeId" TEXT,
  "stage" TEXT,
  "status" "BudgetControlStatus" NOT NULL,
  "percentUsed" DOUBLE PRECISION NOT NULL,
  "tokenUsed" INTEGER NOT NULL DEFAULT 0,
  "costUsedUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "thresholdPercent" INTEGER,
  "action" TEXT NOT NULL,
  "traceId" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "tenantId" TEXT DEFAULT 'default',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "project_budget_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_budget_events_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "specification_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "project_budget_events_evidenceKey_key" ON "project_budget_events"("evidenceKey");
CREATE INDEX "project_budget_events_projectId_createdAt_idx" ON "project_budget_events"("projectId", "createdAt");
CREATE INDEX "project_budget_events_tenantId_status_idx" ON "project_budget_events"("tenantId", "status");

CREATE TABLE "tenant_budget_envelopes" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "costLimitUsd" DOUBLE PRECISION,
  "tokenLimit" INTEGER,
  "warningPercent" INTEGER NOT NULL DEFAULT 80,
  "hardCapPercent" INTEGER NOT NULL DEFAULT 120,
  "economyModelAlias" TEXT,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tenant_budget_envelopes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "tenant_budget_envelopes_tenantId_key" ON "tenant_budget_envelopes"("tenantId");
CREATE INDEX "tenant_budget_envelopes_status_idx" ON "tenant_budget_envelopes"("status");

CREATE TABLE "claim_drift_signals" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "claimId" TEXT NOT NULL,
  "reconciliationRunId" TEXT,
  "beforeMean" DOUBLE PRECISION NOT NULL,
  "afterMean" DOUBLE PRECISION NOT NULL,
  "delta" DOUBLE PRECISION NOT NULL,
  "direction" TEXT NOT NULL,
  "threshold" DOUBLE PRECISION NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "traceId" TEXT,
  "tenantId" TEXT DEFAULT 'default',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "claim_drift_signals_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "claim_drift_signals_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "specification_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "claim_drift_signals_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "claims"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "claim_drift_signals_reconciliationRunId_fkey" FOREIGN KEY ("reconciliationRunId") REFERENCES "reconciliation_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "claim_drift_signals_reconciliationRunId_claimId_key" ON "claim_drift_signals"("reconciliationRunId", "claimId");
CREATE INDEX "claim_drift_signals_projectId_createdAt_idx" ON "claim_drift_signals"("projectId", "createdAt");
CREATE INDEX "claim_drift_signals_tenantId_status_idx" ON "claim_drift_signals"("tenantId", "status");

CREATE TABLE "specification_change_requests" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "driftSignalId" TEXT,
  "specificationVersionId" TEXT,
  "title" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "status" "ChangeControlStatus" NOT NULL DEFAULT 'RECOMMENDED',
  "requestedById" TEXT,
  "decidedById" TEXT,
  "decidedAt" TIMESTAMP(3),
  "appliedAt" TIMESTAMP(3),
  "traceId" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "tenantId" TEXT DEFAULT 'default',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "specification_change_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "specification_change_requests_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "specification_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "specification_change_requests_driftSignalId_fkey" FOREIGN KEY ("driftSignalId") REFERENCES "claim_drift_signals"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "specification_change_requests_specificationVersionId_fkey" FOREIGN KEY ("specificationVersionId") REFERENCES "specification_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "specification_change_requests_projectId_status_createdAt_idx" ON "specification_change_requests"("projectId", "status", "createdAt");
CREATE INDEX "specification_change_requests_tenantId_status_idx" ON "specification_change_requests"("tenantId", "status");

-- Tenant data must remain protected even when application filters regress.
ALTER TABLE "generation_plan_amendments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "generation_plan_amendments" FORCE ROW LEVEL SECURITY;
ALTER TABLE "project_budget_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "project_budget_events" FORCE ROW LEVEL SECURITY;
ALTER TABLE "tenant_budget_envelopes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_budget_envelopes" FORCE ROW LEVEL SECURITY;
ALTER TABLE "claim_drift_signals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "claim_drift_signals" FORCE ROW LEVEL SECURITY;
ALTER TABLE "specification_change_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "specification_change_requests" FORCE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation_policy" ON "generation_plan_amendments"
  USING ("tenantId" = public.workgraph_current_tenant_id())
  WITH CHECK ("tenantId" = public.workgraph_current_tenant_id());
CREATE POLICY "tenant_isolation_policy" ON "project_budget_events"
  USING ("tenantId" = public.workgraph_current_tenant_id())
  WITH CHECK ("tenantId" = public.workgraph_current_tenant_id());
CREATE POLICY "tenant_isolation_policy" ON "tenant_budget_envelopes"
  USING ("tenantId" = public.workgraph_current_tenant_id())
  WITH CHECK ("tenantId" = public.workgraph_current_tenant_id());
CREATE POLICY "tenant_isolation_policy" ON "claim_drift_signals"
  USING ("tenantId" = public.workgraph_current_tenant_id())
  WITH CHECK ("tenantId" = public.workgraph_current_tenant_id());
CREATE POLICY "tenant_isolation_policy" ON "specification_change_requests"
  USING ("tenantId" = public.workgraph_current_tenant_id())
  WITH CHECK ("tenantId" = public.workgraph_current_tenant_id());
