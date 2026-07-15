-- M90: Unified Discovery & Elicitation (ADR 0006). One first-class capability that
-- consolidates the three legacy "handle the unknowns" mechanisms (workbench stage
-- questions, work-item clarifications, LLM open-questions) behind a single model +
-- service that can actively reduce unknowns via the governed LLM gateway / Copilot
-- (Context Fabric) and read-only MCP research tools.

DO $$ BEGIN
    CREATE TYPE "DiscoveryScopeType" AS ENUM ('WORKFLOW_STAGE', 'WORK_ITEM', 'RUN');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE "DiscoverySessionStatus" AS ENUM ('OPEN', 'RESOLVING', 'BLOCKED', 'RESOLVED', 'ABANDONED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE "DiscoveryQuestionKind" AS ENUM ('single_select', 'multi_select', 'freeform', 'clarification');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE "DiscoveryQuestionSource" AS ENUM ('configured', 'llm', 'copilot', 'human', 'agent');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE "DiscoveryQuestionStatus" AS ENUM ('OPEN', 'ANSWERED', 'DISMISSED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE "DiscoveryAssumptionStatus" AS ENUM ('PROPOSED', 'ACCEPTED', 'REJECTED', 'VALIDATED', 'INVALIDATED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "discovery_sessions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT DEFAULT 'default',
    "scopeType" "DiscoveryScopeType" NOT NULL,
    "scopeId" TEXT NOT NULL,
    "status" "DiscoverySessionStatus" NOT NULL DEFAULT 'OPEN',
    "touchPoint" TEXT DEFAULT 'DISCOVERY',
    "budget" JSONB,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "discovery_sessions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "discovery_sessions_tenantId_scopeType_scopeId_idx" ON "discovery_sessions"("tenantId", "scopeType", "scopeId");
CREATE INDEX IF NOT EXISTS "discovery_sessions_tenantId_status_idx" ON "discovery_sessions"("tenantId", "status");

CREATE TABLE IF NOT EXISTS "discovery_questions" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "tenantId" TEXT DEFAULT 'default',
    "text" TEXT NOT NULL,
    "kind" "DiscoveryQuestionKind" NOT NULL DEFAULT 'clarification',
    "source" "DiscoveryQuestionSource" NOT NULL DEFAULT 'human',
    "blocking" BOOLEAN NOT NULL DEFAULT false,
    "status" "DiscoveryQuestionStatus" NOT NULL DEFAULT 'OPEN',
    "options" JSONB,
    "answer" TEXT,
    "answeredById" TEXT,
    "answeredAt" TIMESTAMP(3),
    "proposedAnswer" TEXT,
    "confidence" DOUBLE PRECISION,
    "ordinal" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "discovery_questions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "discovery_questions_sessionId_status_idx" ON "discovery_questions"("sessionId", "status");
CREATE INDEX IF NOT EXISTS "discovery_questions_tenantId_idx" ON "discovery_questions"("tenantId");

CREATE TABLE IF NOT EXISTS "discovery_assumptions" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "tenantId" TEXT DEFAULT 'default',
    "text" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "status" "DiscoveryAssumptionStatus" NOT NULL DEFAULT 'PROPOSED',
    "validatedById" TEXT,
    "validatedAt" TIMESTAMP(3),
    "evidenceRef" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "discovery_assumptions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "discovery_assumptions_sessionId_status_idx" ON "discovery_assumptions"("sessionId", "status");
CREATE INDEX IF NOT EXISTS "discovery_assumptions_tenantId_idx" ON "discovery_assumptions"("tenantId");

DO $$ BEGIN
    ALTER TABLE "discovery_questions"
        ADD CONSTRAINT "discovery_questions_sessionId_fkey"
        FOREIGN KEY ("sessionId") REFERENCES "discovery_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "discovery_assumptions"
        ADD CONSTRAINT "discovery_assumptions_sessionId_fkey"
        FOREIGN KEY ("sessionId") REFERENCES "discovery_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
