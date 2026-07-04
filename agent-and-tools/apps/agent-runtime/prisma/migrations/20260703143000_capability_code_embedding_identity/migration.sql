-- CapabilityCodeEmbedding is a derived platform-side semantic cache.
-- Existing read paths treat "any embedding for this symbol" as complete, so
-- enforce one current embedding row per CapabilityCodeSymbol and remove
-- duplicate cache rows produced by concurrent check-then-create refreshes.

WITH duplicate_embeddings AS (
  SELECT id
  FROM (
    SELECT
      id,
      row_number() OVER (
        PARTITION BY "symbolId"
        ORDER BY
          CASE WHEN embedding IS NOT NULL THEN 0 ELSE 1 END,
          "createdAt" DESC,
          id DESC
      ) AS rn
    FROM "CapabilityCodeEmbedding"
  ) ranked
  WHERE rn > 1
)
DELETE FROM "CapabilityCodeEmbedding"
WHERE id IN (SELECT id FROM duplicate_embeddings);

CREATE UNIQUE INDEX IF NOT EXISTS "CapabilityCodeEmbedding_symbolId_key"
  ON "CapabilityCodeEmbedding" ("symbolId");

CREATE INDEX IF NOT EXISTS "CapabilityCodeEmbedding_embeddingModel_idx"
  ON "CapabilityCodeEmbedding" ("embeddingModel");
