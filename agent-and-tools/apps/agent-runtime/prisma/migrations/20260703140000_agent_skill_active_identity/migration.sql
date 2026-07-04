-- Agent Studio local/tool skills are catalog entries. Keep only one active
-- entry per normalized name + skill type + prompt-layer scope; old duplicate
-- rows remain as archived history.

WITH skill_links AS (
  SELECT "skillId", count(*)::int AS link_count
  FROM "AgentTemplateSkill"
  GROUP BY "skillId"
),
ranked AS (
  SELECT
    skill.id,
    row_number() OVER (
      PARTITION BY
        lower(btrim(skill.name)),
        lower(btrim(skill."skillType")),
        lower(coalesce(nullif(btrim(skill."promptLayerId"), ''), ''))
      ORDER BY
        COALESCE(skill_links.link_count, 0) DESC,
        skill."updatedAt" DESC,
        skill."createdAt" DESC,
        skill.id DESC
    ) AS rn
  FROM "AgentSkill" skill
  LEFT JOIN skill_links ON skill_links."skillId" = skill.id
  WHERE skill.status = 'ACTIVE'
    AND btrim(skill.name) <> ''
    AND btrim(skill."skillType") <> ''
)
UPDATE "AgentSkill" skill
SET
  status = 'ARCHIVED',
  "updatedAt" = now()
FROM ranked
WHERE skill.id = ranked.id
  AND ranked.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS "AgentSkill_active_identity_key"
  ON "AgentSkill" (
    lower(btrim(name)),
    lower(btrim("skillType")),
    lower(coalesce(nullif(btrim("promptLayerId"), ''), ''))
  )
  WHERE status = 'ACTIVE'
    AND btrim(name) <> ''
    AND btrim("skillType") <> '';

CREATE INDEX IF NOT EXISTS "AgentSkill_status_name_type_idx"
  ON "AgentSkill"(status, name, "skillType");
