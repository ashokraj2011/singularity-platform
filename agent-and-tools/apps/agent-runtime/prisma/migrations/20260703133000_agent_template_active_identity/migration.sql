-- Capability-scoped agent template names should be unique only for the
-- editable/live surface. Archived rows remain as history and should not block
-- recreating a profile with the same name.

WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY "capabilityId", lower(btrim(name))
      ORDER BY
        CASE status
          WHEN 'ACTIVE' THEN 0
          WHEN 'DRAFT' THEN 1
          WHEN 'INACTIVE' THEN 2
          ELSE 3
        END,
        "updatedAt" DESC,
        "createdAt" DESC,
        id DESC
    ) AS rn
  FROM "AgentTemplate"
  WHERE "capabilityId" IS NOT NULL
    AND status <> 'ARCHIVED'
    AND btrim(name) <> ''
)
UPDATE "AgentTemplate" template
SET
  status = 'ARCHIVED',
  "updatedAt" = now(),
  "lockedReason" = COALESCE(
    template."lockedReason",
    'Archived automatically while enforcing active capability agent-template identity.'
  )
FROM ranked
WHERE template.id = ranked.id
  AND ranked.rn > 1;

DROP INDEX IF EXISTS "AgentTemplate_capabilityId_name_key";

CREATE UNIQUE INDEX IF NOT EXISTS "AgentTemplate_active_capability_name_norm_key"
  ON "AgentTemplate" ("capabilityId", lower(btrim(name)))
  WHERE "capabilityId" IS NOT NULL
    AND status <> 'ARCHIVED'
    AND btrim(name) <> '';
