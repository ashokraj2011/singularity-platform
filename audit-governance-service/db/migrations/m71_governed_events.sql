-- M71 Slice H — Index for governed-loop event filtering.
--
-- context-fabric's governed module emits these event types via the existing
-- audit-gov ingest (no new tables, no new columns — event_type is already
-- a TEXT column that accepts arbitrary strings):
--
--   governed.tool_refused             — PhaseToolForbidden hit
--   governed.tool_dispatched          — successful /mcp/tool-run
--   governed.tool_dispatch_failed     — network / 5xx talking to mcp-server
--   governed.phase_output_invalid     — receipt schema violated
--   governed.phase_transition_refused — advance_phase() rejected
--   governed.phase_completed          — receipt validated + state advanced
--   governed.llm_request              — turn started (Slice C(b))
--   governed.llm_response             — turn returned (Slice C(b))
--   governed.stage_aborted            — multi-turn driver bailed (Slice F)
--
-- The only schema work is an index that makes filtering by these prefixes
-- fast. The existing search router (M63 Slice A) already accepts arbitrary
-- event_type values via the request schema, so no application-layer change
-- is needed.
--
-- Idempotent — uses IF NOT EXISTS.

-- Partial index covering only the governed.* events. Cheap because it's
-- bounded by event_type matching the prefix, and most audit traffic isn't
-- governed-loop events. Operators querying "all PhaseToolForbidden refusals
-- in the last 24h" land here.
--
-- Guarded with a table-existence check because this migration may run
-- BEFORE the base schema in fresh-bootstrap installs (the audit-gov service
-- creates its tables on first start via its own ORM migrations; we don't
-- want this index migration to fail in CI when run against an empty DB).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'audit_events'
      AND table_schema = current_schema()
  ) THEN
    RAISE NOTICE 'audit_events table not present yet; M71 index migration is a no-op until base schema lands';
    RETURN;
  END IF;

  CREATE INDEX IF NOT EXISTS idx_audit_events_governed
    ON audit_events(event_type, created_at DESC)
    WHERE event_type LIKE 'governed.%';

  COMMENT ON INDEX idx_audit_events_governed IS
    'M71 — supports per-event-type queries against context-fabric governed-loop emissions';
END
$$;
