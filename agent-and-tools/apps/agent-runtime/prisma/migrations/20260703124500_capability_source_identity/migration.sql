-- Capability source identity hardening.
--
-- Repeated repo/link attachment should update or reuse the active source row,
-- not create duplicate polling/sync work. This keeps learning refresh,
-- source review, and prompt grounding deterministic.

WITH duplicate_repositories AS (
  SELECT id
  FROM (
    SELECT
      id,
      row_number() OVER (
        PARTITION BY
          "capabilityId",
          lower(btrim("repoUrl")),
          lower(COALESCE(NULLIF(btrim("defaultBranch"), ''), 'main')),
          lower(COALESCE(NULLIF(btrim("repositoryType"), ''), 'GITHUB'))
        ORDER BY "updatedAt" DESC, "createdAt" DESC, id DESC
      ) AS rn
    FROM "CapabilityRepository"
    WHERE status = 'ACTIVE'
      AND NULLIF(btrim(COALESCE("repoUrl", '')), '') IS NOT NULL
  ) ranked
  WHERE rn > 1
)
UPDATE "CapabilityRepository"
SET status = 'ARCHIVED',
    "pollIntervalSec" = NULL,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE id IN (SELECT id FROM duplicate_repositories);

WITH duplicate_knowledge_sources AS (
  SELECT id
  FROM (
    SELECT
      id,
      row_number() OVER (
        PARTITION BY
          "capabilityId",
          lower(btrim("url")),
          lower(COALESCE(NULLIF(btrim("artifactType"), ''), 'DOC'))
        ORDER BY "updatedAt" DESC, "createdAt" DESC, id DESC
      ) AS rn
    FROM "CapabilityKnowledgeSource"
    WHERE status = 'ACTIVE'
      AND NULLIF(btrim(COALESCE("url", '')), '') IS NOT NULL
  ) ranked
  WHERE rn > 1
)
UPDATE "CapabilityKnowledgeSource"
SET status = 'ARCHIVED',
    "pollIntervalSec" = NULL,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE id IN (SELECT id FROM duplicate_knowledge_sources);

CREATE UNIQUE INDEX IF NOT EXISTS "CapabilityRepository_active_source_key"
  ON "CapabilityRepository" (
    "capabilityId",
    lower(btrim("repoUrl")),
    lower(COALESCE(NULLIF(btrim("defaultBranch"), ''), 'main')),
    lower(COALESCE(NULLIF(btrim("repositoryType"), ''), 'GITHUB'))
  )
  WHERE status = 'ACTIVE'
    AND NULLIF(btrim(COALESCE("repoUrl", '')), '') IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "CapabilityKnowledgeSource_active_source_key"
  ON "CapabilityKnowledgeSource" (
    "capabilityId",
    lower(btrim("url")),
    lower(COALESCE(NULLIF(btrim("artifactType"), ''), 'DOC'))
  )
  WHERE status = 'ACTIVE'
    AND NULLIF(btrim(COALESCE("url", '')), '') IS NOT NULL;
