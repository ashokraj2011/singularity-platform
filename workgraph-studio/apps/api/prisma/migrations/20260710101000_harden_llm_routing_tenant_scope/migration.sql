-- LLM routing configuration is operationally sensitive. Keep its ownership
-- explicit so strict-mode operators cannot read or mutate another tenant's
-- aliases/rules through the control-plane API.

ALTER TABLE "llm_connection"
  ADD COLUMN IF NOT EXISTS "tenantId" TEXT;

ALTER TABLE "llm_routing"
  ADD COLUMN IF NOT EXISTS "tenantId" TEXT;

-- Replace the old global uniqueness constraints with tenant-aware keys. NULL
-- tenant values remain legacy/global compatibility rows; strict-mode writes
-- always include a concrete tenantId.
DROP INDEX IF EXISTS "llm_connection_alias_key";
DROP INDEX IF EXISTS "llm_routing_touchPoint_scopeType_scopeId_key";

CREATE INDEX IF NOT EXISTS "llm_connection_tenantId_enabled_idx" ON "llm_connection"("tenantId", "enabled");
CREATE INDEX IF NOT EXISTS "llm_routing_tenantId_enabled_idx" ON "llm_routing"("tenantId", "enabled");
CREATE UNIQUE INDEX IF NOT EXISTS "llm_connection_tenantId_alias_key" ON "llm_connection"("tenantId", "alias");
CREATE UNIQUE INDEX IF NOT EXISTS "llm_routing_tenantId_touchPoint_scopeType_scopeId_key"
  ON "llm_routing"("tenantId", "touchPoint", "scopeType", "scopeId");
