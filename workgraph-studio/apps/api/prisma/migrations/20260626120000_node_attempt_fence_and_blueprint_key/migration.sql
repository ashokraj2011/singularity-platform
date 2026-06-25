-- Finding #7 — per-node attempt fence. A monotonic counter on the node, copied onto the
-- result-bearing rows at dispatch, lets advance() reject a result from a superseded attempt
-- (e.g. an old client/Copilot subprocess result landing after a restart).
ALTER TABLE "workflow_nodes" ADD COLUMN "attempt" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "pending_executions" ADD COLUMN "attempt" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "agent_runs" ADD COLUMN "attempt" INTEGER;

-- Finding #12 — at most one LIVE BlueprintSession per workflow instance under multinode.
ALTER TABLE "blueprint_sessions" ADD COLUMN "multinodeInstanceKey" TEXT;

-- Partial UNIQUE index. Prisma can't express partial indexes in schema.prisma, so it lives
-- here as raw SQL (safe under `prisma migrate deploy`). Only multinode sessions set the key,
-- and the predicate drops the row once the session is COMPLETED/ABANDONED, so a re-run after
-- completion starts clean. Non-multinode sessions leave the key NULL and never collide.
CREATE UNIQUE INDEX "blueprint_sessions_live_multinode_uniq"
  ON "blueprint_sessions" ("multinodeInstanceKey")
  WHERE "multinodeInstanceKey" IS NOT NULL
    AND "status" NOT IN ('COMPLETED', 'ABANDONED');
