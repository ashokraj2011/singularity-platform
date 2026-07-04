-- Legacy centralized code-symbol cache idempotency.
--
-- Platform-side CapabilityCodeSymbol rows are derived cache data. Re-running
-- extraction over the same repository files must not create duplicate symbols
-- for the same repositoryId + symbolHash. Keep the newest row and delete older
-- duplicate cache rows plus their embeddings before installing the invariant.

WITH duplicate_symbols AS (
  SELECT id
  FROM (
    SELECT
      id,
      row_number() OVER (
        PARTITION BY "repositoryId", lower(btrim("symbolHash"))
        ORDER BY "updatedAt" DESC, "createdAt" DESC, id DESC
      ) AS rn
    FROM "CapabilityCodeSymbol"
    WHERE NULLIF(btrim(COALESCE("symbolHash", '')), '') IS NOT NULL
  ) ranked
  WHERE rn > 1
),
deleted_embeddings AS (
  DELETE FROM "CapabilityCodeEmbedding"
  WHERE "symbolId" IN (SELECT id FROM duplicate_symbols)
  RETURNING id
)
DELETE FROM "CapabilityCodeSymbol"
WHERE id IN (SELECT id FROM duplicate_symbols);

CREATE UNIQUE INDEX IF NOT EXISTS "CapabilityCodeSymbol_repository_symbolHash_key"
  ON "CapabilityCodeSymbol" ("repositoryId", lower(btrim("symbolHash")))
  WHERE NULLIF(btrim(COALESCE("symbolHash", '')), '') IS NOT NULL;
