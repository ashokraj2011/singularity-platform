-- M100: Studio Board — AgentVerdicts. Agents get voice not votes: CHALLENGE /
-- ENDORSE / FLAG on a human artifact, never changing its status. The anti-nag rule
-- ("one OPEN verdict per target per agent per stance") is a PARTIAL unique index on
-- status='OPEN', so resolved verdicts don't block a fresh one. Plain idempotent DDL.

CREATE TABLE IF NOT EXISTS "agent_verdicts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT DEFAULT 'default',
    "boardId" TEXT,
    "targetType" TEXT NOT NULL,
    "targetRef" TEXT NOT NULL,
    "actorType" TEXT NOT NULL DEFAULT 'AGENT',
    "agentRole" TEXT NOT NULL,
    "stance" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "evidenceRefs" JSONB NOT NULL DEFAULT '[]',
    "resolvesWith" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.6,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdById" TEXT,
    "answeredById" TEXT,
    "answerNote" TEXT,
    "traceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    CONSTRAINT "agent_verdicts_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "agent_verdicts_tenantId_boardId_status_idx" ON "agent_verdicts"("tenantId", "boardId", "status");
CREATE INDEX IF NOT EXISTS "agent_verdicts_targetType_targetRef_status_idx" ON "agent_verdicts"("targetType", "targetRef", "status");
-- Anti-nag: at most one OPEN verdict per (target, agent role, stance).
CREATE UNIQUE INDEX IF NOT EXISTS "agent_verdicts_open_unique" ON "agent_verdicts"("targetType", "targetRef", "agentRole", "stance") WHERE "status" = 'OPEN';
