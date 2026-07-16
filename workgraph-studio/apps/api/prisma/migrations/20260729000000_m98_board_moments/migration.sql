-- M98: Studio Board — Moments. AI-authored, causally-narrated markers on the
-- timeline: detected deterministically (modules/studio/board-moments.ts) and
-- narrated by the Chronicler governed turn under the citation rule. Low-stakes
-- proposals (VISIBLE, 72h auto-confirm). Plain idempotent DDL (same as m97).

CREATE TABLE IF NOT EXISTS "board_moments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT DEFAULT 'default',
    "boardId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "detectorKey" TEXT NOT NULL,
    "eventSeqStart" BIGINT NOT NULL,
    "eventSeqEnd" BIGINT NOT NULL,
    "title" TEXT NOT NULL,
    "narrative" TEXT NOT NULL,
    "causalChain" JSONB NOT NULL DEFAULT '[]',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'VISIBLE',
    "editedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "board_moments_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "board_moments_boardId_branchId_eventSeqStart_idx" ON "board_moments"("boardId", "branchId", "eventSeqStart");
CREATE INDEX IF NOT EXISTS "ix_board_moments_tenant" ON "board_moments"("tenantId");

DO $$ BEGIN
    ALTER TABLE "board_moments" ADD CONSTRAINT "board_moments_boardId_fkey" FOREIGN KEY ("boardId") REFERENCES "boards"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    ALTER TABLE "board_moments" ADD CONSTRAINT "board_moments_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "board_branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
