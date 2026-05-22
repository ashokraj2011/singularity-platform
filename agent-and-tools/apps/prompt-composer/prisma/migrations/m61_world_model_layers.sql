-- M61 Slice F — Add the CapabilityWorldModel layer types.
--
-- Apply via `pnpm prisma db push` from the prompt-composer directory,
-- or directly:
--   psql -h <host> -U <user> -d <db> -f m61_world_model_layers.sql
--
-- These ADDITIVE enum values are emitted by the compose service when
-- ComposeInput.worldModel is supplied. They render above the M52
-- CODE_* layers so capability-wide ambient context (agent rules,
-- test commands, README summary, architecture slice) precedes the
-- task-specific code slices.

ALTER TYPE "PromptLayerType" ADD VALUE IF NOT EXISTS 'CODE_AGENT_RULES';
ALTER TYPE "PromptLayerType" ADD VALUE IF NOT EXISTS 'CODE_WORLD_MODEL';
