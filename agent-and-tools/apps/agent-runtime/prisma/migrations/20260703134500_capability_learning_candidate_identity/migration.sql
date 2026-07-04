-- Bootstrap/learning refresh should not spam the same review candidate over
-- and over. Keep reviewed evidence, mark exact duplicate rows as SUPERSEDED,
-- then enforce one live candidate per normalized identity + content hash.

WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY
        "capabilityId",
        lower(btrim("groupKey")),
        lower(btrim("artifactType")),
        lower(btrim(title)),
        lower(btrim(coalesce("sourceType", ''))),
        lower(btrim(coalesce("sourceRef", ''))),
        md5(content)
      ORDER BY
        CASE status
          WHEN 'MATERIALIZED' THEN 0
          WHEN 'REJECTED' THEN 1
          WHEN 'PENDING' THEN 2
          ELSE 3
        END,
        "updatedAt" DESC,
        "createdAt" DESC,
        id DESC
    ) AS rn
  FROM "CapabilityLearningCandidate"
  WHERE status <> 'SUPERSEDED'
    AND btrim("groupKey") <> ''
    AND btrim("artifactType") <> ''
    AND btrim(title) <> ''
    AND btrim(content) <> ''
)
UPDATE "CapabilityLearningCandidate" candidate
SET
  status = 'SUPERSEDED',
  "reviewedBy" = COALESCE(candidate."reviewedBy", 'system:dedupe'),
  "reviewedAt" = COALESCE(candidate."reviewedAt", now()),
  "updatedAt" = now()
FROM ranked
WHERE candidate.id = ranked.id
  AND ranked.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS "CapabilityLearningCandidate_live_identity_hash_key"
  ON "CapabilityLearningCandidate" (
    "capabilityId",
    lower(btrim("groupKey")),
    lower(btrim("artifactType")),
    lower(btrim(title)),
    lower(btrim(coalesce("sourceType", ''))),
    lower(btrim(coalesce("sourceRef", ''))),
    md5(content)
  )
  WHERE status <> 'SUPERSEDED'
    AND btrim("groupKey") <> ''
    AND btrim("artifactType") <> ''
    AND btrim(title) <> ''
    AND btrim(content) <> '';
