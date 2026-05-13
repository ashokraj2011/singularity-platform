CREATE TYPE "WorkflowBudgetEnforcementMode" AS ENUM (
  'PAUSE_FOR_APPROVAL',
  'FAIL_HARD',
  'WARN_ONLY'
);

CREATE TYPE "WorkflowRunBudgetStatus" AS ENUM (
  'ACTIVE',
  'WARNED',
  'PAUSED',
  'EXCEEDED',
  'EXHAUSTED'
);

CREATE TYPE "WorkflowRunBudgetEventType" AS ENUM (
  'SNAPSHOT_CREATED',
  'PRECHECK_CLAMPED',
  'PRECHECK_BLOCKED',
  'USAGE_RECORDED',
  'WARN_THRESHOLD',
  'BUDGET_EXCEEDED',
  'EXTRA_APPROVED',
  'UNPRICED_USAGE'
);

ALTER TABLE "workflow_templates"
  ADD COLUMN "budgetPolicy" JSONB;

CREATE TABLE "workflow_run_budgets" (
  "id"                    TEXT PRIMARY KEY,
  "instanceId"            TEXT NOT NULL,
  "templateId"            TEXT,
  "policy"                JSONB NOT NULL DEFAULT '{}',
  "maxInputTokens"        INTEGER,
  "maxOutputTokens"       INTEGER,
  "maxTotalTokens"        INTEGER,
  "maxEstimatedCost"      DOUBLE PRECISION,
  "warnAtPercent"         INTEGER NOT NULL DEFAULT 80,
  "enforcementMode"       "WorkflowBudgetEnforcementMode" NOT NULL DEFAULT 'PAUSE_FOR_APPROVAL',
  "consumedInputTokens"   INTEGER NOT NULL DEFAULT 0,
  "consumedOutputTokens"  INTEGER NOT NULL DEFAULT 0,
  "consumedTotalTokens"   INTEGER NOT NULL DEFAULT 0,
  "consumedEstimatedCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "pricingStatus"         TEXT NOT NULL DEFAULT 'PRICED',
  "status"                "WorkflowRunBudgetStatus" NOT NULL DEFAULT 'ACTIVE',
  "warningEmittedAt"      TIMESTAMP(3),
  "exceededAt"            TIMESTAMP(3),
  "pausedAt"              TIMESTAMP(3),
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "workflow_run_budgets_instanceId_fkey"
    FOREIGN KEY ("instanceId") REFERENCES "workflow_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "workflow_run_budgets_instanceId_key"
  ON "workflow_run_budgets"("instanceId");
CREATE INDEX "workflow_run_budgets_templateId_idx"
  ON "workflow_run_budgets"("templateId");
CREATE INDEX "workflow_run_budgets_status_idx"
  ON "workflow_run_budgets"("status");

CREATE TABLE "workflow_run_budget_events" (
  "id"                 TEXT PRIMARY KEY,
  "budgetId"           TEXT NOT NULL,
  "instanceId"         TEXT NOT NULL,
  "nodeId"             TEXT,
  "agentRunId"         TEXT,
  "cfCallId"           TEXT,
  "promptAssemblyId"   TEXT,
  "eventType"          "WorkflowRunBudgetEventType" NOT NULL,
  "inputTokensDelta"   INTEGER NOT NULL DEFAULT 0,
  "outputTokensDelta"  INTEGER NOT NULL DEFAULT 0,
  "totalTokensDelta"   INTEGER NOT NULL DEFAULT 0,
  "estimatedCostDelta" DOUBLE PRECISION,
  "pricingStatus"      TEXT NOT NULL DEFAULT 'PRICED',
  "metadata"           JSONB,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "workflow_run_budget_events_budgetId_fkey"
    FOREIGN KEY ("budgetId") REFERENCES "workflow_run_budgets"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "workflow_run_budget_events_instanceId_createdAt_idx"
  ON "workflow_run_budget_events"("instanceId", "createdAt");
CREATE INDEX "workflow_run_budget_events_nodeId_idx"
  ON "workflow_run_budget_events"("nodeId");
CREATE INDEX "workflow_run_budget_events_agentRunId_idx"
  ON "workflow_run_budget_events"("agentRunId");
CREATE INDEX "workflow_run_budget_events_cfCallId_idx"
  ON "workflow_run_budget_events"("cfCallId");
