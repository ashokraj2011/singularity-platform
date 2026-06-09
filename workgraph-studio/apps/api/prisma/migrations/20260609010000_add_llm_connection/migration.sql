-- LLM connections added via the routing admin UI (gateway + model). Keys stay in
-- env (credentialEnv = the var name). Idempotent.
CREATE TABLE IF NOT EXISTS "llm_connection" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "baseUrl" TEXT,
  "model" TEXT NOT NULL,
  "alias" TEXT NOT NULL,
  "credentialEnv" TEXT,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "llm_connection_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "llm_connection_alias_key" ON "llm_connection" ("alias");
