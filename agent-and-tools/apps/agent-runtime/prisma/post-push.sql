-- M15 — pgvector follow-ups that prisma db push can't manage.
-- Runs after `prisma db push` on container start. All statements are idempotent.

CREATE EXTENSION IF NOT EXISTS vector;

-- Drop stale JSON-vector code-embedding rows (M14 v0 stored vectors as text).
-- This is the documented "drop + re-extract" backfill strategy from M15.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "CapabilityCodeEmbedding"
    WHERE embedding IS NULL AND "vectorId" IS NOT NULL
  ) THEN
    DELETE FROM "CapabilityCodeEmbedding" WHERE embedding IS NULL AND "vectorId" IS NOT NULL;
  END IF;
END $$;

-- HNSW indexes for cosine similarity. m=16, ef_construction=64 are pgvector defaults.
CREATE INDEX IF NOT EXISTS idx_codeembedding_embedding
  ON "CapabilityCodeEmbedding" USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS idx_knowledgeartifact_embedding
  ON "CapabilityKnowledgeArtifact" USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS idx_distilledmemory_embedding
  ON "DistilledMemory" USING hnsw (embedding vector_cosine_ops);

-- Agent template version history. Prisma db push owns this in fresh
-- databases, but this idempotent block keeps older local/docker databases in
-- step without forcing unrelated unique-index warnings.
CREATE TABLE IF NOT EXISTS "AgentTemplateVersion" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "agentTemplateId" TEXT NOT NULL REFERENCES "AgentTemplate"("id"),
  "version" INTEGER NOT NULL,
  "changeSummary" TEXT,
  "snapshot" JSONB NOT NULL,
  "createdBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "AgentTemplateVersion_agentTemplateId_version_key"
  ON "AgentTemplateVersion"("agentTemplateId", "version");

CREATE INDEX IF NOT EXISTS "AgentTemplateVersion_agentTemplateId_createdAt_idx"
  ON "AgentTemplateVersion"("agentTemplateId", "createdAt");
