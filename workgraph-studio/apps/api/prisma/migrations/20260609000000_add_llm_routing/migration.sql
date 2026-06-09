-- LLM gateway routing: touch-point → connection (model alias), optionally scoped
-- to a user or capability. Written by the drag-drop admin canvas, resolved by the
-- surfaces at request time. IF NOT EXISTS keeps re-runs idempotent.
CREATE TABLE IF NOT EXISTS "llm_routing" (
  "id" TEXT NOT NULL,
  "touchPoint" TEXT NOT NULL,
  "scopeType" TEXT NOT NULL DEFAULT 'DEFAULT',
  "scopeId" TEXT NOT NULL DEFAULT '',
  "modelAlias" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "positionX" DOUBLE PRECISION,
  "positionY" DOUBLE PRECISION,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "llm_routing_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "llm_routing_touchPoint_scopeType_scopeId_key" ON "llm_routing" ("touchPoint","scopeType","scopeId");
CREATE INDEX IF NOT EXISTS "llm_routing_scopeType_scopeId_idx" ON "llm_routing" ("scopeType","scopeId");
