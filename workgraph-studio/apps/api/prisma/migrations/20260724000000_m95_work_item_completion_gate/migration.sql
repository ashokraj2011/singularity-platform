-- M95 — Reconciliation completion gate.
-- Work item timeline events emitted when reconciliation auto-completes a work item
-- (PASSED) or reopens a previously completed one (non-PASSED). Idempotent; the new
-- values are not referenced in this transaction, so ADD VALUE is safe here.
ALTER TYPE "WorkItemEventType" ADD VALUE IF NOT EXISTS 'WORK_ITEM_COMPLETED';
ALTER TYPE "WorkItemEventType" ADD VALUE IF NOT EXISTS 'WORK_ITEM_REOPENED';
