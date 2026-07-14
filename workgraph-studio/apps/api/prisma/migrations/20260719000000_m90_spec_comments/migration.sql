-- M90: Collaboration — comments/threads on the studio (async collaboration layer).

CREATE TABLE IF NOT EXISTS "spec_comments" (
    "id" TEXT NOT NULL,
    "workItemId" TEXT NOT NULL,
    "anchorKind" TEXT,
    "anchorId" TEXT,
    "body" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "mentions" JSONB NOT NULL DEFAULT '[]',
    "parentId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "tenantId" TEXT DEFAULT 'default',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "spec_comments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "spec_comments_workItemId_createdAt_idx" ON "spec_comments"("workItemId", "createdAt");
CREATE INDEX IF NOT EXISTS "spec_comments_workItemId_anchorKind_anchorId_idx" ON "spec_comments"("workItemId", "anchorKind", "anchorId");
CREATE INDEX IF NOT EXISTS "ix_spec_comments_tenant" ON "spec_comments"("tenantId");

DO $$ BEGIN
    ALTER TABLE "spec_comments"
        ADD CONSTRAINT "spec_comments_workItemId_fkey"
        FOREIGN KEY ("workItemId") REFERENCES "work_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
