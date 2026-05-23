-- M71 — StagePolicy + StagePhasePolicy tables.
--
-- Adds the governance contract that context-fabric loads at runtime to
-- enforce phase ordering, tool allowlists, and receipt schemas. Replaces
-- the prompt-side phase nudges added in M68/M70.x with a single
-- chokepoint in context-fabric. See:
--   singularity_governed_coding_loop_spec.md §6 (state machine)
--   singularity_governed_coding_loop_spec.md §7 (phase contracts)
--   singularity_governed_coding_loop_spec.md §8 (StagePolicy YAML)
--
-- Idempotent — uses IF NOT EXISTS so re-running is safe.

CREATE TABLE IF NOT EXISTS "StagePolicy" (
  "id"                  TEXT NOT NULL,
  "stageKey"            TEXT NOT NULL,
  "agentRole"           TEXT,
  "version"             INTEGER NOT NULL DEFAULT 1,
  "status"              TEXT NOT NULL DEFAULT 'ACTIVE',
  "description"         TEXT,
  "approvalModel"       JSONB NOT NULL DEFAULT '{}'::jsonb,
  "limits"              JSONB NOT NULL DEFAULT '{}'::jsonb,
  "contextPolicy"       JSONB NOT NULL DEFAULT '{}'::jsonb,
  "editPolicy"          JSONB NOT NULL DEFAULT '{}'::jsonb,
  "verificationPolicy"  JSONB NOT NULL DEFAULT '{}'::jsonb,
  "riskPolicy"          JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL,

  CONSTRAINT "StagePolicy_pkey" PRIMARY KEY ("id")
);

-- (stageKey, agentRole, version) is the natural key for a policy revision.
-- A NULL agentRole is treated as a distinct "any-role" row.
CREATE UNIQUE INDEX IF NOT EXISTS "StagePolicy_stageKey_agentRole_version_key"
  ON "StagePolicy" ("stageKey", "agentRole", "version");

CREATE INDEX IF NOT EXISTS "StagePolicy_stageKey_status_idx"
  ON "StagePolicy" ("stageKey", "status");

CREATE TABLE IF NOT EXISTS "StagePhasePolicy" (
  "id"                    TEXT NOT NULL,
  "stagePolicyId"         TEXT NOT NULL,
  "phase"                 TEXT NOT NULL,
  "allowedTools"          TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "forbiddenTools"        TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "requiredOutputSchema"  JSONB NOT NULL DEFAULT '{}'::jsonb,
  "maxInputTokens"        INTEGER,
  "maxOutputTokens"       INTEGER,
  "maxToolCalls"          INTEGER,
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"             TIMESTAMP(3) NOT NULL,

  CONSTRAINT "StagePhasePolicy_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StagePhasePolicy_stagePolicyId_fkey"
    FOREIGN KEY ("stagePolicyId") REFERENCES "StagePolicy"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "StagePhasePolicy_stagePolicyId_phase_key"
  ON "StagePhasePolicy" ("stagePolicyId", "phase");

CREATE INDEX IF NOT EXISTS "StagePhasePolicy_phase_idx"
  ON "StagePhasePolicy" ("phase");
