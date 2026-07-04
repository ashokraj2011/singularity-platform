-- Agent/capability binding idempotency.
--
-- A capability should have at most one non-archived binding for a given
-- agentTemplateId. Retries and partial bootstrap reruns should update/reuse
-- that binding instead of creating duplicate agent rows in Capability detail,
-- Prompt Composer context, or runtime execution routing.

WITH duplicate_bindings AS (
  SELECT id
  FROM (
    SELECT
      id,
      row_number() OVER (
        PARTITION BY "capabilityId", "agentTemplateId"
        ORDER BY
          CASE status
            WHEN 'ACTIVE' THEN 0
            WHEN 'DRAFT' THEN 1
            WHEN 'INACTIVE' THEN 2
            ELSE 3
          END ASC,
          "updatedAt" DESC,
          "createdAt" DESC,
          id DESC
      ) AS rn
    FROM "AgentCapabilityBinding"
    WHERE status <> 'ARCHIVED'
  ) ranked
  WHERE rn > 1
)
UPDATE "AgentCapabilityBinding"
SET status = 'ARCHIVED',
    "updatedAt" = CURRENT_TIMESTAMP
WHERE id IN (SELECT id FROM duplicate_bindings);

CREATE UNIQUE INDEX IF NOT EXISTS "AgentCapabilityBinding_active_template_key"
  ON "AgentCapabilityBinding" ("capabilityId", "agentTemplateId")
  WHERE status <> 'ARCHIVED';
