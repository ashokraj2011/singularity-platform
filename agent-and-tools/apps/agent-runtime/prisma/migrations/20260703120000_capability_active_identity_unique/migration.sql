-- Active capability identity hardening.
--
-- Product rule:
--   * appId, when present, uniquely identifies an active application capability.
--   * without appId, name + capabilityType uniquely identify an active capability.
--
-- Existing local/dev databases can contain accidental duplicate ACTIVE rows from
-- repeated bootstrap/sync runs. Before installing the invariant, retire the
-- later duplicates using the same cascade shape as capabilityService.archive().

WITH duplicate_capabilities AS (
  SELECT id
  FROM (
    SELECT
      id,
      row_number() OVER (
        PARTITION BY lower(btrim("appId"))
        ORDER BY "createdAt" ASC, id ASC
      ) AS rn
    FROM "Capability"
    WHERE status = 'ACTIVE'
      AND NULLIF(btrim(COALESCE("appId", '')), '') IS NOT NULL
  ) ranked_app
  WHERE rn > 1

  UNION

  SELECT id
  FROM (
    SELECT
      id,
      row_number() OVER (
        PARTITION BY
          lower(COALESCE(NULLIF(btrim("capabilityType"), ''), 'default')),
          lower(btrim("name"))
        ORDER BY "createdAt" ASC, id ASC
      ) AS rn
    FROM "Capability"
    WHERE status = 'ACTIVE'
      AND NULLIF(btrim(COALESCE("appId", '')), '') IS NULL
  ) ranked_name
  WHERE rn > 1
),
archived AS (
  UPDATE "Capability"
  SET status = 'ARCHIVED',
      "updatedAt" = CURRENT_TIMESTAMP
  WHERE id IN (SELECT id FROM duplicate_capabilities)
  RETURNING id
),
inactive_bindings AS (
  UPDATE "AgentCapabilityBinding"
  SET status = 'INACTIVE',
      "updatedAt" = CURRENT_TIMESTAMP
  WHERE "capabilityId" IN (SELECT id FROM archived)
    AND status <> 'ARCHIVED'
  RETURNING id
),
archived_templates AS (
  UPDATE "AgentTemplate"
  SET status = 'ARCHIVED',
      "updatedAt" = CURRENT_TIMESTAMP
  WHERE "capabilityId" IN (SELECT id FROM archived)
    AND status <> 'ARCHIVED'
  RETURNING id
),
archived_repositories AS (
  UPDATE "CapabilityRepository"
  SET status = 'ARCHIVED',
      "pollIntervalSec" = NULL,
      "updatedAt" = CURRENT_TIMESTAMP
  WHERE "capabilityId" IN (SELECT id FROM archived)
    AND status <> 'ARCHIVED'
  RETURNING id
),
archived_sources AS (
  UPDATE "CapabilityKnowledgeSource"
  SET status = 'ARCHIVED',
      "pollIntervalSec" = NULL,
      "updatedAt" = CURRENT_TIMESTAMP
  WHERE "capabilityId" IN (SELECT id FROM archived)
    AND status <> 'ARCHIVED'
  RETURNING id
),
archived_artifacts AS (
  UPDATE "CapabilityKnowledgeArtifact"
  SET status = 'ARCHIVED',
      "updatedAt" = CURRENT_TIMESTAMP
  WHERE "capabilityId" IN (SELECT id FROM archived)
    AND status = 'ACTIVE'
  RETURNING id
)
UPDATE "CapabilityLearningCandidate"
SET status = 'REJECTED',
    "reviewedAt" = COALESCE("reviewedAt", CURRENT_TIMESTAMP),
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "capabilityId" IN (SELECT id FROM archived)
  AND status = 'PENDING';

CREATE UNIQUE INDEX IF NOT EXISTS "Capability_active_appId_unique"
  ON "Capability" (lower(btrim("appId")))
  WHERE status = 'ACTIVE'
    AND NULLIF(btrim(COALESCE("appId", '')), '') IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "Capability_active_name_type_unique"
  ON "Capability" (
    lower(COALESCE(NULLIF(btrim("capabilityType"), ''), 'default')),
    lower(btrim("name"))
  )
  WHERE status = 'ACTIVE'
    AND NULLIF(btrim(COALESCE("appId", '')), '') IS NULL;
