-- Runtime insights rely on per-node timing fields. Some dev databases were
-- created before these additive fields landed in Prisma, so keep this
-- migration idempotent for office-laptop Docker rebuilds and existing volumes.
ALTER TABLE "workflow_nodes"
  ADD COLUMN IF NOT EXISTS "startedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "completedAt" TIMESTAMP(3);
