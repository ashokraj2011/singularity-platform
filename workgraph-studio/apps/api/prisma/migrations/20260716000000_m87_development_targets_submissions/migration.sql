-- M87: Developer handoff (development_targets) + implementation submissions.
-- Spec-to-Reconciliation Phase 3 (spec §5, §7, §14). The WorkItemEventType members these use
-- (DEVELOPER_PACKAGE_PUBLISHED, IMPLEMENTATION_SUBMITTED) were added in M86.

-- Developer handoff: the approved specification made developer-ready. One per Work Item.
CREATE TABLE IF NOT EXISTS "development_targets" (
    "id" TEXT NOT NULL,
    "workItemId" TEXT NOT NULL,
    "specificationVersionId" TEXT NOT NULL,
    "repository" TEXT NOT NULL,
    "component" TEXT,
    "baseBranch" TEXT NOT NULL,
    "baseCommitSha" TEXT NOT NULL,
    "requirementIds" JSONB NOT NULL DEFAULT '[]',
    "requiredEvidence" JSONB NOT NULL DEFAULT '[]',
    "forbiddenPaths" JSONB NOT NULL DEFAULT '[]',
    "reconciliationPolicy" JSONB NOT NULL DEFAULT '{}',
    "dueAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "publishedAt" TIMESTAMP(3),
    "tenantId" TEXT DEFAULT 'default',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "development_targets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "development_targets_workItemId_key" ON "development_targets"("workItemId");
CREATE INDEX IF NOT EXISTS "ix_development_targets_tenant" ON "development_targets"("tenantId");

-- Implementation submission: one immutable external attempt against the published handoff.
CREATE TABLE IF NOT EXISTS "implementation_submissions" (
    "id" TEXT NOT NULL,
    "workItemId" TEXT NOT NULL,
    "specificationVersionId" TEXT NOT NULL,
    "specificationHash" TEXT NOT NULL,
    "repository" TEXT NOT NULL,
    "baseCommitSha" TEXT NOT NULL,
    "headCommitSha" TEXT NOT NULL,
    "pullRequestNumber" INTEGER,
    "manifest" JSONB,
    "claims" JSONB NOT NULL DEFAULT '[]',
    "deviations" JSONB NOT NULL DEFAULT '[]',
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DISCOVERED',
    "tenantId" TEXT DEFAULT 'default',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "implementation_submissions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "implementation_submissions_workItemId_repository_headCommitSha_key"
    ON "implementation_submissions"("workItemId", "repository", "headCommitSha");
CREATE INDEX IF NOT EXISTS "implementation_submissions_workItemId_createdAt_idx"
    ON "implementation_submissions"("workItemId", "createdAt");
CREATE INDEX IF NOT EXISTS "ix_implementation_submissions_tenant"
    ON "implementation_submissions"("tenantId");

-- Foreign keys (guarded so re-runs on an already-migrated DB are no-ops).
DO $$ BEGIN
    ALTER TABLE "development_targets"
        ADD CONSTRAINT "development_targets_workItemId_fkey"
        FOREIGN KEY ("workItemId") REFERENCES "work_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "implementation_submissions"
        ADD CONSTRAINT "implementation_submissions_specificationVersionId_fkey"
        FOREIGN KEY ("specificationVersionId") REFERENCES "specification_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "implementation_submissions"
        ADD CONSTRAINT "implementation_submissions_workItemId_fkey"
        FOREIGN KEY ("workItemId") REFERENCES "work_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
