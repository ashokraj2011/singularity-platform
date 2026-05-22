-- M65 Slice 1A — token_savings_runs migrated from metrics-ledger.
--
-- Single source of truth move. metrics-ledger's SQLite token_savings_runs
-- becomes audit-gov's Postgres token_savings_runs so operators query one
-- place. Schema preserved verbatim (column names + types) so the
-- migration is straight port + new audit_event_id back-reference.
--
-- Going forward, the cost-worker classifies `llm.call.completed` audit
-- events that carry cache_read_tokens / cache_write_tokens / compression
-- metrics in payload, computes the raw vs optimized delta, and writes
-- one savings row per event. Legacy POSTs from /chat/respond
-- (deprecated, sunset 2026-07-01) continue to land in metrics-ledger
-- until that endpoint is removed.

SET search_path = audit_governance, public;

CREATE TABLE IF NOT EXISTS token_savings_runs (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- M65 — back-reference to the audit_event that spawned this row.
  -- Nullable because legacy back-fills from metrics-ledger may not have
  -- a matching event. ON DELETE SET NULL so a purged audit_event
  -- doesn't cascade-kill the savings record.
  audit_event_id           UUID REFERENCES audit_events(id) ON DELETE SET NULL,
  session_id               TEXT NOT NULL,
  agent_id                 TEXT,
  context_package_id       TEXT,
  model_call_id            TEXT,
  optimization_mode        TEXT NOT NULL,
  raw_input_tokens         INTEGER NOT NULL,
  optimized_input_tokens   INTEGER NOT NULL,
  output_tokens            INTEGER NOT NULL DEFAULT 0,
  tokens_saved             INTEGER NOT NULL,
  percent_saved            NUMERIC(7, 4) NOT NULL,
  estimated_raw_cost       NUMERIC(12, 6) NOT NULL DEFAULT 0,
  estimated_optimized_cost NUMERIC(12, 6) NOT NULL DEFAULT 0,
  estimated_cost_saved     NUMERIC(12, 6) NOT NULL DEFAULT 0,
  provider                 TEXT,
  model_name               TEXT,
  latency_ms               INTEGER,
  quality_score            NUMERIC(6, 4),
  capability_id            TEXT,
  tenant_id                TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_token_savings_session
  ON token_savings_runs(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_token_savings_agent
  ON token_savings_runs(agent_id, created_at DESC)
  WHERE agent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_token_savings_capability
  ON token_savings_runs(capability_id, created_at DESC)
  WHERE capability_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_token_savings_optimization_mode
  ON token_savings_runs(optimization_mode, created_at DESC);
