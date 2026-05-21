-- M52 — Add the 7 Code Context Budgeter layer types to PromptLayerType.
--
-- Run this ONCE against the prompt-composer database after pulling the
-- M52 changes:
--   psql -h <host> -U <user> -d <db> -f m52_code_context_layers.sql
--
-- Alternatively, run `pnpm prisma db push` from the prompt-composer
-- directory after this file is in place — Prisma will pick up the
-- schema delta and ALTER TYPE for you.
--
-- These are ADDITIVE enum values; no existing data needs to change.
-- The new values are only written when ComposeInput.codeContextPackage
-- is supplied on the request (Context Fabric activates the path for
-- Developer-style stages once the M52 orchestration lands in execute.py).

ALTER TYPE "PromptLayerType" ADD VALUE IF NOT EXISTS 'CODE_TASK_INTENT';
ALTER TYPE "PromptLayerType" ADD VALUE IF NOT EXISTS 'CODE_TARGET_SYMBOLS';
ALTER TYPE "PromptLayerType" ADD VALUE IF NOT EXISTS 'CODE_EDITABLE_SLICES';
ALTER TYPE "PromptLayerType" ADD VALUE IF NOT EXISTS 'CODE_DEPENDENCY_SLICES';
ALTER TYPE "PromptLayerType" ADD VALUE IF NOT EXISTS 'CODE_TYPE_CONTRACTS';
ALTER TYPE "PromptLayerType" ADD VALUE IF NOT EXISTS 'CODE_TEST_SLICES';
ALTER TYPE "PromptLayerType" ADD VALUE IF NOT EXISTS 'CODE_CONTEXT_RECEIPT';
