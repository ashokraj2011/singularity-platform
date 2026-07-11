-- Harden event operations and observability joins with explicit tenant keys.
-- Nullable columns preserve legacy/global rows during migration; strict-mode
-- write paths populate them for all new rows.

ALTER TABLE "event_log"
  ADD COLUMN IF NOT EXISTS "traceId" TEXT,
  ADD COLUMN IF NOT EXISTS "tenantId" TEXT;

ALTER TABLE "event_outbox"
  ADD COLUMN IF NOT EXISTS "tenantId" TEXT;

ALTER TABLE "event_subscriptions"
  ADD COLUMN IF NOT EXISTS "tenantId" TEXT;

UPDATE "event_log"
   SET "traceId" = COALESCE(payload->>'traceId', payload->>'trace_id')
 WHERE "traceId" IS NULL
   AND payload IS NOT NULL;

UPDATE "event_log"
   SET "tenantId" = COALESCE(payload->>'tenantId', payload->>'tenant_id')
 WHERE "tenantId" IS NULL
   AND payload IS NOT NULL;

CREATE INDEX IF NOT EXISTS "event_log_traceId_idx" ON "event_log"("traceId");
CREATE INDEX IF NOT EXISTS "event_log_tenantId_occurredAt_idx" ON "event_log"("tenantId", "occurredAt" DESC);
CREATE INDEX IF NOT EXISTS "event_outbox_tenantId_emittedAt_idx" ON "event_outbox"("tenantId", "emittedAt");
CREATE INDEX IF NOT EXISTS "event_subscriptions_tenantId_isActive_idx" ON "event_subscriptions"("tenantId", "isActive");
