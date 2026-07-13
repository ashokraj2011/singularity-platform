-- M86 — Work Item Spec-to-Reconciliation, Phase 1: specification versions.

-- New Work Item timeline event types (idempotent; a value can't be used in the same tx it's added,
-- and none are used below, so this is safe).
ALTER TYPE "WorkItemEventType" ADD VALUE IF NOT EXISTS 'SPEC_DRAFT_CREATED';
ALTER TYPE "WorkItemEventType" ADD VALUE IF NOT EXISTS 'SPEC_GENERATED';
ALTER TYPE "WorkItemEventType" ADD VALUE IF NOT EXISTS 'SPEC_VALIDATION_COMPLETED';
ALTER TYPE "WorkItemEventType" ADD VALUE IF NOT EXISTS 'SPEC_REVIEW_REQUESTED';
ALTER TYPE "WorkItemEventType" ADD VALUE IF NOT EXISTS 'SPEC_APPROVED';
ALTER TYPE "WorkItemEventType" ADD VALUE IF NOT EXISTS 'DEVELOPER_PACKAGE_PUBLISHED';
ALTER TYPE "WorkItemEventType" ADD VALUE IF NOT EXISTS 'IMPLEMENTATION_SUBMITTED';
ALTER TYPE "WorkItemEventType" ADD VALUE IF NOT EXISTS 'RECONCILIATION_STARTED';
ALTER TYPE "WorkItemEventType" ADD VALUE IF NOT EXISTS 'RECONCILIATION_COMPLETED';
ALTER TYPE "WorkItemEventType" ADD VALUE IF NOT EXISTS 'CODE_REWORK_REQUESTED';
ALTER TYPE "WorkItemEventType" ADD VALUE IF NOT EXISTS 'SPEC_AMENDMENT_CREATED';
ALTER TYPE "WorkItemEventType" ADD VALUE IF NOT EXISTS 'IMPLEMENTATION_ACCEPTED';

-- Specification status enum.
DO $$ BEGIN
  CREATE TYPE "SpecificationStatus" AS ENUM ('DRAFT','IN_REVIEW','CHANGES_REQUESTED','APPROVED','SUPERSEDED','REJECTED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "specification_versions" (
  "id"               TEXT NOT NULL,
  "workItemId"       TEXT NOT NULL,
  "version"          INTEGER NOT NULL,
  "revision"         INTEGER NOT NULL DEFAULT 1,
  "status"           "SpecificationStatus" NOT NULL DEFAULT 'DRAFT',
  "package"          JSONB NOT NULL,
  "renderedMarkdown" TEXT,
  "contentHash"      TEXT,
  "createdById"      TEXT,
  "approvedById"     TEXT,
  "approvedAt"       TIMESTAMP(3),
  "approvalComment"  TEXT,
  "supersedesId"     TEXT,
  "tenantId"         TEXT DEFAULT 'default',
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "specification_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "specification_versions_workItemId_fkey" FOREIGN KEY ("workItemId")
    REFERENCES "work_items"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "specification_versions_workItemId_version_key"
  ON "specification_versions"("workItemId", "version");
CREATE INDEX IF NOT EXISTS "specification_versions_workItemId_status_idx"
  ON "specification_versions"("workItemId", "status");
CREATE INDEX IF NOT EXISTS "ix_specification_versions_tenant"
  ON "specification_versions"("tenantId");
