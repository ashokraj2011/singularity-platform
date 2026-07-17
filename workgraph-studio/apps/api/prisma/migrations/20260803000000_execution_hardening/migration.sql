-- Execution hardening: auditable spec edits and explicit stale evidence.
ALTER TYPE "WorkItemEventType" ADD VALUE IF NOT EXISTS 'SPEC_DRAFT_EDITED';
ALTER TYPE "WorkItemEventType" ADD VALUE IF NOT EXISTS 'RECONCILIATION_INVALIDATED';
ALTER TYPE "ReconciliationState" ADD VALUE IF NOT EXISTS 'STALE';
