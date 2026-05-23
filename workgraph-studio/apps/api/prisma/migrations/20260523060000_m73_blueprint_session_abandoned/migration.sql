-- Task #81 — terminal status for sessions whose workitem got detached.
-- See work-items.service.ts:detachWorkItemFromWorkflow + blueprint.router.ts
-- GET /sessions for the read-side filter that depends on this value.
--
-- ADD VALUE is non-transactional in PG; the IF NOT EXISTS guard keeps the
-- migration idempotent if it's been partially applied on a long-running env.
ALTER TYPE "BlueprintSessionStatus" ADD VALUE IF NOT EXISTS 'ABANDONED';
