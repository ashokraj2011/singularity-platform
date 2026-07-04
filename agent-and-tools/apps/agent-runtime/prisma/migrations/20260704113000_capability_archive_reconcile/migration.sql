-- Reconcile archived capability lifecycle state after identity/source
-- hardening migrations. Earlier migrations can retire duplicate capabilities
-- before newer learning-worker/grounding tables exist; this pass makes every
-- archived capability look exactly like the runtime archive path:
-- no active polling, no active artifacts, no pending review work, no worker
-- lease, and an explicit ARCHIVED grounding status for the UI.

WITH archived AS (
  SELECT id
  FROM "Capability"
  WHERE status = 'ARCHIVED'
)
UPDATE "AgentCapabilityBinding"
SET status = 'INACTIVE',
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "capabilityId" IN (SELECT id FROM archived)
  AND status <> 'ARCHIVED';

WITH archived AS (
  SELECT id
  FROM "Capability"
  WHERE status = 'ARCHIVED'
)
UPDATE "AgentTemplate"
SET status = 'ARCHIVED',
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "capabilityId" IN (SELECT id FROM archived)
  AND status <> 'ARCHIVED';

WITH archived AS (
  SELECT id
  FROM "Capability"
  WHERE status = 'ARCHIVED'
)
UPDATE "CapabilityRepository"
SET status = 'ARCHIVED',
    "pollIntervalSec" = NULL,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "capabilityId" IN (SELECT id FROM archived)
  AND (status <> 'ARCHIVED' OR "pollIntervalSec" IS NOT NULL);

WITH archived AS (
  SELECT id
  FROM "Capability"
  WHERE status = 'ARCHIVED'
)
UPDATE "CapabilityKnowledgeSource"
SET status = 'ARCHIVED',
    "pollIntervalSec" = NULL,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "capabilityId" IN (SELECT id FROM archived)
  AND (status <> 'ARCHIVED' OR "pollIntervalSec" IS NOT NULL);

WITH archived AS (
  SELECT id
  FROM "Capability"
  WHERE status = 'ARCHIVED'
)
UPDATE "CapabilityKnowledgeArtifact"
SET status = 'ARCHIVED',
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "capabilityId" IN (SELECT id FROM archived)
  AND status = 'ACTIVE';

WITH archived AS (
  SELECT id
  FROM "Capability"
  WHERE status = 'ARCHIVED'
)
UPDATE "CapabilityLearningCandidate"
SET status = 'REJECTED',
    "reviewedBy" = COALESCE("reviewedBy", 'system:archive-reconcile'),
    "reviewedAt" = COALESCE("reviewedAt", CURRENT_TIMESTAMP),
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "capabilityId" IN (SELECT id FROM archived)
  AND status = 'PENDING';

WITH archived AS (
  SELECT id
  FROM "Capability"
  WHERE status = 'ARCHIVED'
)
DELETE FROM "CapabilityLearningWorkerLock"
WHERE "capabilityId" IN (SELECT id FROM archived);

INSERT INTO "CapabilityLearningStatus" (
  "id",
  "capabilityId",
  "status",
  "message",
  "lastAttemptAt",
  "lastFailureCode",
  "lastFailureMessage",
  "diagnostics",
  "createdAt",
  "updatedAt"
)
SELECT
  gen_random_uuid()::text,
  c.id,
  'ARCHIVED',
  'Capability is archived; repository grounding is read-only.',
  CURRENT_TIMESTAMP,
  NULL,
  NULL,
  jsonb_build_object(
    'archiveReconciled', true,
    'archiveReconciledAt', CURRENT_TIMESTAMP,
    'archiveCancelledLearningWorker', true
  ),
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "Capability" c
WHERE c.status = 'ARCHIVED'
ON CONFLICT ("capabilityId") DO UPDATE
SET status = 'ARCHIVED',
    message = EXCLUDED.message,
    "lastAttemptAt" = EXCLUDED."lastAttemptAt",
    "lastFailureCode" = NULL,
    "lastFailureMessage" = NULL,
    diagnostics = COALESCE("CapabilityLearningStatus".diagnostics, '{}'::jsonb)
      || jsonb_build_object(
        'archiveReconciled', true,
        'archiveReconciledAt', CURRENT_TIMESTAMP,
        'archiveCancelledLearningWorker', true
      ),
    "updatedAt" = CURRENT_TIMESTAMP;
