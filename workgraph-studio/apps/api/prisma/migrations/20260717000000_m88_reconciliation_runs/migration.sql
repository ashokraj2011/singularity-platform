-- M88: Deterministic reconciliation — runs, per-requirement verdicts, findings.
-- Spec-to-Reconciliation Phase 4 (spec §15). Consumes the developer handoff + implementation
-- submissions (M87). The RECONCILIATION_STARTED/RECONCILIATION_COMPLETED event members were
-- added in M86.

DO $$ BEGIN
    CREATE TYPE "ReconciliationStatus" AS ENUM ('PENDING', 'RUNNING', 'PASSED', 'FAILED', 'PARTIAL', 'ERROR');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE "RequirementVerdictValue" AS ENUM ('PASS', 'PARTIAL', 'FAIL', 'NOT_APPLICABLE', 'NOT_VERIFIED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE "ReconciliationFindingSeverity" AS ENUM ('ERROR', 'WARNING', 'INFO');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "reconciliation_runs" (
    "id" TEXT NOT NULL,
    "workItemId" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "specificationVersionId" TEXT NOT NULL,
    "specificationHash" TEXT,
    "mode" TEXT NOT NULL DEFAULT 'DETERMINISTIC',
    "status" "ReconciliationStatus" NOT NULL DEFAULT 'PENDING',
    "summary" JSONB NOT NULL DEFAULT '{}',
    "traceId" TEXT,
    "startedById" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "tenantId" TEXT DEFAULT 'default',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "reconciliation_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "reconciliation_runs_workItemId_createdAt_idx" ON "reconciliation_runs"("workItemId", "createdAt");
CREATE INDEX IF NOT EXISTS "reconciliation_runs_submissionId_idx" ON "reconciliation_runs"("submissionId");
CREATE INDEX IF NOT EXISTS "ix_reconciliation_runs_tenant" ON "reconciliation_runs"("tenantId");

CREATE TABLE IF NOT EXISTS "requirement_verdicts" (
    "id" TEXT NOT NULL,
    "reconciliationRunId" TEXT NOT NULL,
    "requirementId" TEXT NOT NULL,
    "priority" TEXT,
    "verdict" "RequirementVerdictValue" NOT NULL,
    "claimStatus" TEXT,
    "rationale" TEXT,
    "evidence" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "requirement_verdicts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "requirement_verdicts_reconciliationRunId_requirementId_key"
    ON "requirement_verdicts"("reconciliationRunId", "requirementId");
CREATE INDEX IF NOT EXISTS "requirement_verdicts_reconciliationRunId_idx" ON "requirement_verdicts"("reconciliationRunId");

CREATE TABLE IF NOT EXISTS "reconciliation_findings" (
    "id" TEXT NOT NULL,
    "reconciliationRunId" TEXT NOT NULL,
    "requirementId" TEXT,
    "kind" TEXT NOT NULL,
    "severity" "ReconciliationFindingSeverity" NOT NULL DEFAULT 'WARNING',
    "message" TEXT NOT NULL,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "reconciliation_findings_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "reconciliation_findings_reconciliationRunId_idx" ON "reconciliation_findings"("reconciliationRunId");

-- Foreign keys (guarded so re-runs on an already-migrated DB are no-ops).
DO $$ BEGIN
    ALTER TABLE "reconciliation_runs"
        ADD CONSTRAINT "reconciliation_runs_submissionId_fkey"
        FOREIGN KEY ("submissionId") REFERENCES "implementation_submissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "reconciliation_runs"
        ADD CONSTRAINT "reconciliation_runs_workItemId_fkey"
        FOREIGN KEY ("workItemId") REFERENCES "work_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "requirement_verdicts"
        ADD CONSTRAINT "requirement_verdicts_reconciliationRunId_fkey"
        FOREIGN KEY ("reconciliationRunId") REFERENCES "reconciliation_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "reconciliation_findings"
        ADD CONSTRAINT "reconciliation_findings_reconciliationRunId_fkey"
        FOREIGN KEY ("reconciliationRunId") REFERENCES "reconciliation_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
