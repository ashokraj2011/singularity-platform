-- M99: Studio Board — ingestion. Artifacts dragged onto the board become thinking
-- objects; extraction stages claims at a new SOURCE_DOCUMENT evidence tier (a
-- document asserting X is weak evidence X is true — below executed-test, above
-- simulation). Plain idempotent DDL (same pattern as m97/m98; ADD VALUE mirrors m94).

ALTER TYPE "EvidenceTier" ADD VALUE IF NOT EXISTS 'SOURCE_DOCUMENT';

CREATE TABLE IF NOT EXISTS "ingested_artifacts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT DEFAULT 'default',
    "boardId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "storageRef" TEXT,
    "contentHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "parseSummary" JSONB NOT NULL DEFAULT '{}',
    "extractedClaims" JSONB NOT NULL DEFAULT '[]',
    "droppedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ingested_artifacts_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ingested_artifacts_boardId_contentHash_idx" ON "ingested_artifacts"("boardId", "contentHash");
CREATE INDEX IF NOT EXISTS "ix_ingested_artifacts_tenant" ON "ingested_artifacts"("tenantId");

DO $$ BEGIN
    ALTER TABLE "ingested_artifacts" ADD CONSTRAINT "ingested_artifacts_boardId_fkey" FOREIGN KEY ("boardId") REFERENCES "boards"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
