-- M89: Dynamic reconciliation — the runner-facing job queue + a `verified` flag on verdicts.
-- Spec-to-Reconciliation Phase 6 (spec §15, "Layer 2"). Consumes the deterministic run (M88).

DO $$ BEGIN
    CREATE TYPE "ReconciliationJobStatus" AS ENUM ('PENDING', 'CLAIMED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A verdict is "verified" once backed by actual test execution, not just declared evidence.
ALTER TABLE "requirement_verdicts" ADD COLUMN IF NOT EXISTS "verified" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "reconciliation_jobs" (
    "id" TEXT NOT NULL,
    "reconciliationRunId" TEXT NOT NULL,
    "workItemId" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "status" "ReconciliationJobStatus" NOT NULL DEFAULT 'PENDING',
    "repository" TEXT NOT NULL,
    "baseCommitSha" TEXT NOT NULL,
    "headCommitSha" TEXT NOT NULL,
    "testPlan" JSONB NOT NULL DEFAULT '[]',
    "claimToken" TEXT,
    "claimedBy" TEXT,
    "claimedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "result" JSONB,
    "error" TEXT,
    "tenantId" TEXT DEFAULT 'default',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "reconciliation_jobs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "reconciliation_jobs_reconciliationRunId_key" ON "reconciliation_jobs"("reconciliationRunId");
CREATE INDEX IF NOT EXISTS "reconciliation_jobs_status_createdAt_idx" ON "reconciliation_jobs"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "reconciliation_jobs_workItemId_idx" ON "reconciliation_jobs"("workItemId");
CREATE INDEX IF NOT EXISTS "ix_reconciliation_jobs_tenant" ON "reconciliation_jobs"("tenantId");

DO $$ BEGIN
    ALTER TABLE "reconciliation_jobs"
        ADD CONSTRAINT "reconciliation_jobs_reconciliationRunId_fkey"
        FOREIGN KEY ("reconciliationRunId") REFERENCES "reconciliation_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
