-- Source-backed capability knowledge must be idempotent.
--
-- Re-running bootstrap review, repository-profile refresh, or URL/file sync
-- should update/reuse the active artifact for the same source identity rather
-- than creating repeated cards/prompts for the same knowledge source.
-- Manual artifacts without sourceRef remain history-preserving inserts.

WITH duplicate_artifacts AS (
  SELECT id
  FROM (
    SELECT
      id,
      row_number() OVER (
        PARTITION BY
          "capabilityId",
          lower(btrim("artifactType")),
          lower(btrim("title")),
          lower(COALESCE(NULLIF(btrim("sourceType"), ''), '')),
          lower(btrim("sourceRef"))
        ORDER BY "updatedAt" DESC, "createdAt" DESC, id DESC
      ) AS rn
    FROM "CapabilityKnowledgeArtifact"
    WHERE status = 'ACTIVE'
      AND NULLIF(btrim(COALESCE("sourceRef", '')), '') IS NOT NULL
  ) ranked
  WHERE rn > 1
)
UPDATE "CapabilityKnowledgeArtifact"
SET status = 'ARCHIVED',
    "updatedAt" = CURRENT_TIMESTAMP
WHERE id IN (SELECT id FROM duplicate_artifacts);

CREATE UNIQUE INDEX IF NOT EXISTS "CapabilityKnowledgeArtifact_active_source_key"
  ON "CapabilityKnowledgeArtifact" (
    "capabilityId",
    lower(btrim("artifactType")),
    lower(btrim("title")),
    lower(COALESCE(NULLIF(btrim("sourceType"), ''), '')),
    lower(btrim("sourceRef"))
  )
  WHERE status = 'ACTIVE'
    AND NULLIF(btrim(COALESCE("sourceRef", '')), '') IS NOT NULL;
