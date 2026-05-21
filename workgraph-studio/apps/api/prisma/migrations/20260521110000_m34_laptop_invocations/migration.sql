ALTER TABLE "agent_runs"
  ADD COLUMN IF NOT EXISTS "origin" TEXT NOT NULL DEFAULT 'workflow',
  ADD COLUMN IF NOT EXISTS "client" TEXT,
  ADD COLUMN IF NOT EXISTS "traceId" TEXT,
  ADD COLUMN IF NOT EXISTS "cfCallId" TEXT,
  ADD COLUMN IF NOT EXISTS "promptAssemblyId" TEXT,
  ADD COLUMN IF NOT EXISTS "mcpServerId" TEXT,
  ADD COLUMN IF NOT EXISTS "mcpInvocationId" TEXT,
  ADD COLUMN IF NOT EXISTS "contextPackageId" TEXT,
  ADD COLUMN IF NOT EXISTS "modelCallId" TEXT,
  ADD COLUMN IF NOT EXISTS "laptopInvocationId" TEXT;

CREATE INDEX IF NOT EXISTS "agent_runs_origin_client_idx" ON "agent_runs"("origin", "client");
CREATE INDEX IF NOT EXISTS "agent_runs_traceId_idx" ON "agent_runs"("traceId");
CREATE INDEX IF NOT EXISTS "agent_runs_cfCallId_idx" ON "agent_runs"("cfCallId");
CREATE INDEX IF NOT EXISTS "agent_runs_promptAssemblyId_idx" ON "agent_runs"("promptAssemblyId");
CREATE INDEX IF NOT EXISTS "agent_runs_mcpInvocationId_idx" ON "agent_runs"("mcpInvocationId");
CREATE INDEX IF NOT EXISTS "agent_runs_contextPackageId_idx" ON "agent_runs"("contextPackageId");
CREATE INDEX IF NOT EXISTS "agent_runs_modelCallId_idx" ON "agent_runs"("modelCallId");

UPDATE "agent_runs" ar
SET
  "traceId" = COALESCE(ar."traceId", payload->>'traceId'),
  "cfCallId" = COALESCE(ar."cfCallId", payload->>'cfCallId'),
  "promptAssemblyId" = COALESCE(ar."promptAssemblyId", payload->>'promptAssemblyId'),
  "mcpServerId" = COALESCE(ar."mcpServerId", payload->>'mcpServerId'),
  "mcpInvocationId" = COALESCE(ar."mcpInvocationId", payload->>'mcpInvocationId'),
  "contextPackageId" = COALESCE(ar."contextPackageId", payload->>'contextPackageId'),
  "modelCallId" = COALESCE(ar."modelCallId", payload->>'modelCallId')
FROM (
  SELECT DISTINCT ON ("runId")
    "runId",
    "structuredPayload" AS payload
  FROM "agent_run_outputs"
  WHERE "structuredPayload" IS NOT NULL
  ORDER BY "runId", "createdAt" DESC
) aro
WHERE aro."runId" = ar.id;

CREATE TABLE IF NOT EXISTS "laptop_invocations" (
  "id" TEXT PRIMARY KEY,
  "workItemId" TEXT NOT NULL REFERENCES "work_items"("id") ON DELETE CASCADE,
  "agentRunId" TEXT NOT NULL UNIQUE REFERENCES "agent_runs"("id") ON DELETE CASCADE,
  "capabilityId" TEXT,
  "client" TEXT NOT NULL,
  "mode" TEXT NOT NULL DEFAULT 'direct-copilot',
  "status" TEXT NOT NULL DEFAULT 'STARTED',
  "userId" TEXT,
  "tenantId" TEXT,
  "mcpUrl" TEXT,
  "mcpTokenJti" TEXT,
  "repoUrl" TEXT,
  "branch" TEXT,
  "baseCommitSha" TEXT,
  "renderedPrompt" TEXT,
  "promptAssemblyId" TEXT,
  "envelopeAssemblyId" TEXT,
  "agentSpec" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "data" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "lastHeartbeatAt" TIMESTAMPTZ,
  "startedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "endedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "laptop_invocations_workItemId_idx" ON "laptop_invocations"("workItemId");
CREATE INDEX IF NOT EXISTS "laptop_invocations_agentRunId_idx" ON "laptop_invocations"("agentRunId");
CREATE INDEX IF NOT EXISTS "laptop_invocations_capabilityId_idx" ON "laptop_invocations"("capabilityId");
CREATE INDEX IF NOT EXISTS "laptop_invocations_status_lastHeartbeatAt_idx" ON "laptop_invocations"("status", "lastHeartbeatAt");

CREATE TABLE IF NOT EXISTS "laptop_questions" (
  "id" TEXT PRIMARY KEY,
  "invocationId" TEXT NOT NULL REFERENCES "laptop_invocations"("id") ON DELETE CASCADE,
  "workItemId" TEXT NOT NULL,
  "question" TEXT NOT NULL,
  "context" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "answer" TEXT,
  "askedById" TEXT,
  "answeredById" TEXT,
  "askedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "answeredAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "laptop_questions_invocationId_status_idx" ON "laptop_questions"("invocationId", "status");
CREATE INDEX IF NOT EXISTS "laptop_questions_workItemId_status_idx" ON "laptop_questions"("workItemId", "status");
CREATE INDEX IF NOT EXISTS "laptop_questions_status_createdAt_idx" ON "laptop_questions"("status", "createdAt");
