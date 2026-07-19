-- Layered world model — add the WORLD_MODEL_VIEW layer type.
--
-- Apply via `pnpm prisma db push` from the prompt-composer directory,
-- or directly:
--   psql -h <host> -U <user> -d <db> -f m10x_world_model_view_layers.sql
--
-- APPLY THIS BEFORE DEPLOYING THE CODE. The enum value is persisted on
-- PromptAssemblyLayer, so a composer that emits WORLD_MODEL_VIEW against a
-- database without the value will fail the insert on every request that carries
-- views. Applying it early is harmless: nothing emits the value until the code
-- ships, and nothing emits it even then until an operator builds views for a
-- capability and a caller passes them in.
--
-- ONE value covers all ten view kinds (core_summary, the seven role views,
-- domain, task_guide). The kind travels in the layer heading and inclusionReason
-- rather than the enum, so adding a view kind later needs no migration.

ALTER TYPE "PromptLayerType" ADD VALUE IF NOT EXISTS 'WORLD_MODEL_VIEW';
