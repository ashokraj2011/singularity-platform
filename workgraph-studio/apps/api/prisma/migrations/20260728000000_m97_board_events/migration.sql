-- M97: Studio Board — event-sourcing backbone. Append-only, per-branch event log
-- with a gap-free monotonic eventSeq (BoardBranch.headEventSeq is the fence,
-- allocated under SELECT … FOR UPDATE) + periodic snapshots. State is a pure fold
-- over events (modules/studio/board-events.ts). Plain DDL — prisma db push covers
-- bare-metal, this file covers Docker migrate deploy (same pattern as m86–m96).
-- Event/actor/mode/status are TEXT (not enums) so new event types need no migration.

CREATE TABLE IF NOT EXISTS "boards" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdById" TEXT,
    "tenantId" TEXT DEFAULT 'default',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "boards_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "boards_projectId_idx" ON "boards"("projectId");
CREATE INDEX IF NOT EXISTS "ix_boards_tenant" ON "boards"("tenantId");

CREATE TABLE IF NOT EXISTS "board_branches" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT DEFAULT 'default',
    "boardId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parentBranchId" TEXT,
    "forkEventSeq" BIGINT,
    "headEventSeq" BIGINT NOT NULL DEFAULT 0,
    "mode" TEXT NOT NULL DEFAULT 'HUMAN',
    "purpose" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "explorationBudget" JSONB NOT NULL DEFAULT '{}',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mergedAt" TIMESTAMP(3),
    CONSTRAINT "board_branches_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "board_branches_boardId_name_key" ON "board_branches"("boardId", "name");
CREATE INDEX IF NOT EXISTS "board_branches_tenantId_boardId_status_idx" ON "board_branches"("tenantId", "boardId", "status");

CREATE TABLE IF NOT EXISTS "board_events" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT DEFAULT 'default',
    "boardId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "eventSeq" BIGINT NOT NULL,
    "eventType" TEXT NOT NULL,
    "objectIds" JSONB NOT NULL DEFAULT '[]',
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "agentRole" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "causedBy" JSONB NOT NULL DEFAULT '[]',
    "coalesceKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "board_events_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "board_events_branchId_eventSeq_key" ON "board_events"("branchId", "eventSeq");
CREATE INDEX IF NOT EXISTS "board_events_boardId_branchId_eventSeq_idx" ON "board_events"("boardId", "branchId", "eventSeq");
CREATE INDEX IF NOT EXISTS "board_events_boardId_eventType_createdAt_idx" ON "board_events"("boardId", "eventType", "createdAt");

CREATE TABLE IF NOT EXISTS "board_snapshots" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT DEFAULT 'default',
    "boardId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "eventSeq" BIGINT NOT NULL,
    "state" JSONB NOT NULL,
    "stateHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "board_snapshots_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "board_snapshots_branchId_eventSeq_key" ON "board_snapshots"("branchId", "eventSeq");

DO $$ BEGIN
    ALTER TABLE "boards" ADD CONSTRAINT "boards_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "specification_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    ALTER TABLE "board_branches" ADD CONSTRAINT "board_branches_boardId_fkey" FOREIGN KEY ("boardId") REFERENCES "boards"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    ALTER TABLE "board_events" ADD CONSTRAINT "board_events_boardId_fkey" FOREIGN KEY ("boardId") REFERENCES "boards"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    ALTER TABLE "board_events" ADD CONSTRAINT "board_events_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "board_branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    ALTER TABLE "board_snapshots" ADD CONSTRAINT "board_snapshots_boardId_fkey" FOREIGN KEY ("boardId") REFERENCES "boards"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    ALTER TABLE "board_snapshots" ADD CONSTRAINT "board_snapshots_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "board_branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
