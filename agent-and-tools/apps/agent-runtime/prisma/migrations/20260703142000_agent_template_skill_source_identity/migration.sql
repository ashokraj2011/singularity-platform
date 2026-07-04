-- AgentTemplateSkill source-aware identity.
--
-- Agent profiles can bind the same reusable skill through multiple source
-- contexts (local, provider manifest, URL document, uploaded document). The old
-- unique key on (agentTemplateId, skillId) collapsed those distinct bindings.

WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY
        "agentTemplateId",
        "skillId",
        lower(btrim("sourceType")),
        lower(coalesce(nullif(btrim("sourceRef"), ''), '')),
        lower(coalesce(nullif(btrim("capabilityId"), ''), ''))
      ORDER BY "createdAt" DESC, id DESC
    ) AS rn
  FROM "AgentTemplateSkill"
)
DELETE FROM "AgentTemplateSkill" link
USING ranked
WHERE link.id = ranked.id
  AND ranked.rn > 1;

DROP INDEX IF EXISTS "AgentTemplateSkill_agentTemplateId_skillId_key";

CREATE INDEX IF NOT EXISTS "AgentTemplateSkill_template_skill_idx"
  ON "AgentTemplateSkill" ("agentTemplateId", "skillId");

CREATE UNIQUE INDEX IF NOT EXISTS "AgentTemplateSkill_source_identity_key"
  ON "AgentTemplateSkill" (
    "agentTemplateId",
    "skillId",
    lower(btrim("sourceType")),
    lower(coalesce(nullif(btrim("sourceRef"), ''), '')),
    lower(coalesce(nullif(btrim("capabilityId"), ''), ''))
  );
