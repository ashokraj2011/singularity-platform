-- D3 — tenancy + gateway correlation for stored prompt text.
--
-- Generated with:
--   npx prisma migrate diff \
--     --from-schema-datamodel <pre-change schema.prisma> \
--     --to-schema-datamodel prisma/schema.prisma --script
--
-- `IF NOT EXISTS` guards added by hand on top of that output: this service
-- applies migrations through bin/startup.sh, whose contract is that every
-- migration file only ADDS and is safe to re-run. See the comment block at
-- the top of that script.
--
-- Strictly additive — two nullable columns and two indexes. No DROP, no
-- data rewrite, and no NOT NULL added to any existing column, so this is
-- safe to apply to a live table while the old code is still running.
--
-- `tenantId` is NULLABLE and intentionally NOT backfilled: rows written
-- before this migration carry no recoverable tenant, and there is no
-- trustworthy source to derive one from after the fact. A guessed tenant on
-- audit data is worse than an honest NULL.
--
-- `gatewayCallId` is written by nobody yet. It exists so that once the LLM
-- gateway mints a call id and echoes it on its response, an operator can walk
-- prompt → cost by joining audit_governance.llm_calls.gateway_call_id
-- directly, instead of guessing the match from traceId + timestamp proximity.

-- AlterTable
ALTER TABLE "PromptAssembly" ADD COLUMN IF NOT EXISTS "gatewayCallId" TEXT;
ALTER TABLE "PromptAssembly" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;

-- CreateIndex
-- Composite rather than a bare tenantId index: the access pattern that
-- matters is time-ordered per-tenant reads ("this tenant's recent
-- assemblies"), which this serves directly.
CREATE INDEX IF NOT EXISTS "PromptAssembly_tenantId_createdAt_idx" ON "PromptAssembly"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PromptAssembly_gatewayCallId_idx" ON "PromptAssembly"("gatewayCallId");
