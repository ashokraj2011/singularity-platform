-- M-CR5: tenant ownership is part of every registry and evidence row.
-- Existing rows are assigned to the single-tenant default during migration.
ALTER TABLE "claims" ADD COLUMN IF NOT EXISTS "tenantId" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "claim_versions" ADD COLUMN IF NOT EXISTS "tenantId" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "evidence_objects" ADD COLUMN IF NOT EXISTS "tenantId" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "evidence_links" ADD COLUMN IF NOT EXISTS "tenantId" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "maturity_transitions" ADD COLUMN IF NOT EXISTS "tenantId" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "receipts" ADD COLUMN IF NOT EXISTS "tenantId" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "event_outbox" ADD COLUMN IF NOT EXISTS "tenantId" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "event_subscriptions" ADD COLUMN IF NOT EXISTS "tenantId" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "event_deliveries" ADD COLUMN IF NOT EXISTS "tenantId" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "knowledge_events" ADD COLUMN IF NOT EXISTS "tenantId" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "lowering_candidates" ADD COLUMN IF NOT EXISTS "tenantId" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "claim_relations" ADD COLUMN IF NOT EXISTS "tenantId" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "ambiguities" ADD COLUMN IF NOT EXISTS "tenantId" TEXT NOT NULL DEFAULT 'default';

DROP INDEX IF EXISTS "claims_canonicalKey_key";
DROP INDEX IF EXISTS "evidence_objects_contentHash_key";
DROP INDEX IF EXISTS "knowledge_events_contentHash_key";
DROP INDEX IF EXISTS "event_subscriptions_name_key";

CREATE UNIQUE INDEX IF NOT EXISTS "claims_tenantId_canonicalKey_key" ON "claims" ("tenantId", "canonicalKey");
CREATE UNIQUE INDEX IF NOT EXISTS "evidence_objects_tenantId_contentHash_key" ON "evidence_objects" ("tenantId", "contentHash");
CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_events_tenantId_contentHash_key" ON "knowledge_events" ("tenantId", "contentHash");
CREATE UNIQUE INDEX IF NOT EXISTS "event_subscriptions_tenantId_name_key" ON "event_subscriptions" ("tenantId", "name");

CREATE INDEX IF NOT EXISTS "claims_tenantId_idx" ON "claims" ("tenantId");
CREATE INDEX IF NOT EXISTS "knowledge_events_tenantId_idx" ON "knowledge_events" ("tenantId");
CREATE INDEX IF NOT EXISTS "ambiguities_tenantId_status_idx" ON "ambiguities" ("tenantId", "status");
