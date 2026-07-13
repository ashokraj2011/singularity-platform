-- Reusable, tenant-scoped Direct LLM loop strategies.
-- Secrets stay in runtime environment variables; definitions contain no keys.

CREATE TABLE IF NOT EXISTS "loop_strategies" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" TEXT,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "kind" TEXT NOT NULL DEFAULT 'PHASE',
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "currentVersion" INTEGER NOT NULL DEFAULT 1,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "loop_strategies_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "loop_strategies_tenant_status_idx"
  ON "loop_strategies"("tenantId", "status");
CREATE INDEX IF NOT EXISTS "loop_strategies_tenant_kind_idx"
  ON "loop_strategies"("tenantId", "kind");

CREATE TABLE IF NOT EXISTS "loop_strategy_versions" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "strategyId" TEXT NOT NULL,
  "tenantId" TEXT,
  "version" INTEGER NOT NULL,
  "definition" JSONB NOT NULL,
  "contentHash" TEXT NOT NULL,
  "createdById" TEXT,
  "publishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "loop_strategy_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "loop_strategy_versions_strategy_fk"
    FOREIGN KEY ("strategyId") REFERENCES "loop_strategies"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "loop_strategy_versions_strategy_version_key"
  ON "loop_strategy_versions"("strategyId", "version");
CREATE INDEX IF NOT EXISTS "loop_strategy_versions_tenant_strategy_version_idx"
  ON "loop_strategy_versions"("tenantId", "strategyId", "version");
