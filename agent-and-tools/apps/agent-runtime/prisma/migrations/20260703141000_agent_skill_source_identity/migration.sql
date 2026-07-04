-- Skill-source rows describe where a reusable AgentSkill comes from for a
-- capability. Rebinding the same source should update metadata/permissions,
-- not create duplicate active source rows.

WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY
        "skillId",
        lower(btrim("sourceType")),
        lower(coalesce(nullif(btrim("sourceRef"), ''), '')),
        lower(coalesce(nullif(btrim("capabilityId"), ''), ''))
      ORDER BY
        "updatedAt" DESC,
        "createdAt" DESC,
        id DESC
    ) AS rn
  FROM "AgentSkillSource"
  WHERE status = 'ACTIVE'
    AND btrim("skillId") <> ''
    AND btrim("sourceType") <> ''
)
UPDATE "AgentSkillSource" source
SET
  status = 'ARCHIVED',
  "updatedAt" = now()
FROM ranked
WHERE source.id = ranked.id
  AND ranked.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS "AgentSkillSource_active_identity_key"
  ON "AgentSkillSource" (
    "skillId",
    lower(btrim("sourceType")),
    lower(coalesce(nullif(btrim("sourceRef"), ''), '')),
    lower(coalesce(nullif(btrim("capabilityId"), ''), ''))
  )
  WHERE status = 'ACTIVE'
    AND btrim("skillId") <> ''
    AND btrim("sourceType") <> '';

CREATE INDEX IF NOT EXISTS "AgentSkillSource_status_skill_idx"
  ON "AgentSkillSource"(status, "skillId");
