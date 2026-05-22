-- M63 — Splunk-like activity viewer support.
--
-- Two additive changes to audit_events. Idempotent so the same file
-- can run against fresh DBs (alongside init.sql) or live DBs that
-- already have data:
--
--   1. search_vector (Slice A) — generated tsvector column over
--      kind / subject_type / subject_id / payload, with a GIN index.
--      Enables /api/v1/audit/search free-text queries that hit the
--      index instead of full-scanning + jsonb-stringifying every row.
--
--   2. risk_level (Slice D) — operator-facing risk dimension
--      complementing the existing severity column. Severity asks
--      "did it succeed"; risk asks "if this went wrong, how bad."
--      A successful code_change is severity=info / risk=high.
--      A failed embedding call is severity=error / risk=low.
--
-- Apply via:
--   docker exec singularity-audit-postgres psql -U postgres -d audit_gov \
--     -f /docker-entrypoint-initdb.d/migrations/m63_search_and_risk.sql
--
-- OR re-baseline the container with the file mounted into init.

SET search_path = audit_governance, public;

-- ─── Slice A — Search vector ──────────────────────────────────────────────
--
-- Postgres generated column: computed at INSERT/UPDATE, stored on disk,
-- index-able. Weights: A (highest) for `kind` since operators usually
-- search by event type first; B for subject_type+subject_id; C for the
-- payload jsonb text. Coalesce'd to '' to defend against NULLs.
ALTER TABLE audit_events
  ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(kind, '')), 'A') ||
    setweight(to_tsvector('english',
      coalesce(subject_type, '') || ' ' || coalesce(subject_id, '')), 'B') ||
    setweight(to_tsvector('english',
      coalesce(source_service, '') || ' ' ||
      coalesce(actor_id, '') || ' ' ||
      coalesce(capability_id, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(payload::text, '')), 'C')
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_audit_events_search
  ON audit_events USING GIN (search_vector);

-- ─── Slice D — risk_level ─────────────────────────────────────────────────
ALTER TABLE audit_events
  ADD COLUMN IF NOT EXISTS risk_level TEXT;

-- Partial index — risk filtering is much more selective when filtering
-- by high/critical only (the vast majority of events are low/medium).
CREATE INDEX IF NOT EXISTS idx_audit_events_risk_time
  ON audit_events(risk_level, created_at DESC)
  WHERE risk_level IN ('high', 'critical');

-- Backfill existing rows with a best-effort classifier based on kind.
-- The runtime classifier (Slice D in TS) does the same logic going
-- forward; this just lights up the column for rows already in the DB.
UPDATE audit_events
SET risk_level = CASE
  WHEN kind IN ('code_change', 'code_change.applied',
                'workflow.branch.pushed', 'workflow.deploy.applied')             THEN 'high'
  WHEN kind IN ('formal_verify.failed', 'governance.precheck.denied',
                'budget.exhausted', 'rate_limit.exceeded',
                'authz.decision.deny', 'security.violation')                     THEN 'critical'
  WHEN kind IN ('tool.filesystem.access.sensitive',
                'approval.requested', 'governance.escalation')                   THEN 'high'
  WHEN kind IN ('llm.call.completed', 'tool.embedding.completed',
                'tool.filesystem.access')                                         THEN 'low'
  WHEN severity = 'error'                                                         THEN 'medium'
  WHEN severity = 'warn'                                                          THEN 'medium'
  ELSE 'low'
END
WHERE risk_level IS NULL;
