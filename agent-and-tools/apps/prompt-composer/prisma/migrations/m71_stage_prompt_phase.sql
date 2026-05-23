-- M71 Slice E — Per-phase prompt bindings.
--
-- Adds a nullable `phase` column to StagePromptBinding so a single (stage,
-- role) tuple can have one stage-level binding (phase NULL) plus N phase-
-- specific overrides (one per phase). The resolver in stage-prompts.service.ts
-- prefers phase-specific → falls back to stage-level → falls back to the
-- generic loop.stage binding.
--
-- The unique constraint uses NULLS NOT DISTINCT (PG 15+) so two stage-level
-- rows for the same (stageKey, agentRole) collide. Without NULLS NOT
-- DISTINCT, Postgres treats every NULL as distinct, which would let us
-- silently duplicate stage-level bindings.
--
-- Idempotent (re-running is safe).

ALTER TABLE "StagePromptBinding"
  ADD COLUMN IF NOT EXISTS "phase" TEXT;

-- Drop the old (stageKey, agentRole) unique; add (stageKey, agentRole, phase)
-- with NULLS NOT DISTINCT. The old name was prisma's auto-generated for
-- @@unique([stageKey, agentRole]) — which prisma emits as a UNIQUE INDEX,
-- not a UNIQUE CONSTRAINT, so DROP INDEX (not DROP CONSTRAINT) is the right
-- verb. The @@map annotation in schema.prisma keeps the new name stable.
DROP INDEX IF EXISTS "StagePromptBinding_stageKey_agentRole_key";

-- Some installs might also have it stored as a constraint depending on PG
-- version + how prisma emitted; cover both bases.
ALTER TABLE "StagePromptBinding"
  DROP CONSTRAINT IF EXISTS "StagePromptBinding_stageKey_agentRole_key";

-- The new unique. NULLS NOT DISTINCT is the key bit.
CREATE UNIQUE INDEX IF NOT EXISTS "StagePromptBinding_stageKey_agentRole_phase_key"
  ON "StagePromptBinding" ("stageKey", "agentRole", "phase")
  NULLS NOT DISTINCT;

-- Index for the resolver's stageKey + agentRole lookup path.
CREATE INDEX IF NOT EXISTS "StagePromptBinding_stageKey_agentRole_idx"
  ON "StagePromptBinding" ("stageKey", "agentRole");
