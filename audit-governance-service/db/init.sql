-- M21 — Audit & Governance Service schema.
--
-- Single canonical destination for audit events + governance state across the
-- platform. Joined to other services strictly by `trace_id`. No FKs out to
-- other services' DBs (the service runs against its own Postgres).

CREATE SCHEMA IF NOT EXISTS audit_governance;
SET search_path = audit_governance, public;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ─── audit_events ──────────────────────────────────────────────────────────
-- Canonical event record. One row per emitted event from any service.
CREATE TABLE IF NOT EXISTS audit_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trace_id        TEXT,
  source_service  TEXT NOT NULL,                  -- workgraph-api, mcp-server, …
  kind            TEXT NOT NULL,                  -- llm.call.completed, tool.invocation.created, …
  subject_type    TEXT,                           -- WorkflowInstance, AgentRun, ToolInvocation, …
  subject_id      TEXT,
  actor_id        TEXT,                           -- user id when relevant
  capability_id   TEXT,
  tenant_id       TEXT,
  severity        TEXT NOT NULL DEFAULT 'info',   -- info | warn | error | audit
  payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_events_trace        ON audit_events(trace_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_kind_time    ON audit_events(kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_capability   ON audit_events(capability_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_source_time  ON audit_events(source_service, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_subject      ON audit_events(subject_type, subject_id);

-- ─── llm_calls (denormalised for cost rollups) ─────────────────────────────
-- Written by the cost-calc worker when an `llm.call.completed` audit_event
-- lands. Keeping it separate from audit_events means cost queries don't have
-- to filter + jsonb-extract every time.
CREATE TABLE IF NOT EXISTS llm_calls (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_event_id  UUID NOT NULL REFERENCES audit_events(id) ON DELETE CASCADE,
  trace_id        TEXT,
  capability_id   TEXT,
  tenant_id       TEXT,
  provider        TEXT NOT NULL,
  model           TEXT NOT NULL,
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  total_tokens    INTEGER NOT NULL DEFAULT 0,
  latency_ms      INTEGER,
  finish_reason   TEXT,
  cost_usd        NUMERIC(12, 6),                -- NULL when no rate-card row matched
  rate_card_id    UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_llm_calls_capability_time ON llm_calls(capability_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_llm_calls_trace           ON llm_calls(trace_id);
CREATE INDEX IF NOT EXISTS idx_llm_calls_provider_model  ON llm_calls(provider, model);

-- ─── rate_card ─────────────────────────────────────────────────────────────
-- Provider × model → $ per 1k tokens. effective_from/_to lets pricing change
-- over time without rewriting historical cost.
CREATE TABLE IF NOT EXISTS rate_card (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider          TEXT NOT NULL,
  model             TEXT NOT NULL,
  input_per_1k_usd  NUMERIC(10, 6) NOT NULL,
  output_per_1k_usd NUMERIC(10, 6) NOT NULL,
  effective_from    TIMESTAMPTZ NOT NULL DEFAULT '2024-01-01',
  effective_to      TIMESTAMPTZ,
  source            TEXT,                         -- 'seed', 'manual', 'imported', …
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rate_card_lookup ON rate_card(provider, model, effective_from DESC);

-- ─── approvals (relocated PendingApproval — Tier 2 governance authority) ──
-- The eventual single source of truth for who approved what. M9.z's in-memory
-- map will mirror to / read from this in M21.5.
CREATE TABLE IF NOT EXISTS approvals (
  id                  TEXT PRIMARY KEY,           -- continuation_token in mcp-server's terms
  trace_id            TEXT,
  capability_id       TEXT,
  tenant_id           TEXT,
  source_service      TEXT NOT NULL,              -- usually 'mcp-server'
  tool_name           TEXT NOT NULL,
  tool_args           JSONB NOT NULL DEFAULT '{}'::jsonb,
  risk_level          TEXT,
  requested_by        TEXT,
  requested_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- M21 + M21.5: status lifecycle now has 'consumed' so /consume marks the
  -- continuation_payload as fetched-by-mcp-server (single-use semantics).
  status              TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected | consumed | expired
  decided_by          TEXT,
  decided_at          TIMESTAMPTZ,
  decision_reason     TEXT,
  expires_at          TIMESTAMPTZ,
  -- M21.5 — authoritative LoopState envelope so mcp-server can resume after
  -- a restart. JSON blob; opaque to audit-gov but persisted alongside the
  -- approval row.
  continuation_payload JSONB,
  consumed_at         TIMESTAMPTZ
);

-- M21.5 — additive column for existing audit-gov DBs that pre-date this.
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS continuation_payload JSONB;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS consumed_at         TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_approvals_status_capability ON approvals(status, capability_id);
CREATE INDEX IF NOT EXISTS idx_approvals_trace             ON approvals(trace_id);

-- ─── budgets (per-tenant or per-capability token / cost cap) ──────────────
CREATE TABLE IF NOT EXISTS budgets (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_type      TEXT NOT NULL,                  -- tenant | capability
  scope_id        TEXT NOT NULL,
  period          TEXT NOT NULL,                  -- day | week | month
  tokens_max      INTEGER,
  cost_max_usd    NUMERIC(12, 2),
  current_tokens  INTEGER NOT NULL DEFAULT 0,
  current_cost    NUMERIC(12, 6) NOT NULL DEFAULT 0,
  period_start    TIMESTAMPTZ NOT NULL,
  period_end      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (scope_type, scope_id, period, period_start)
);

-- ─── rate_limits (per-tenant or per-capability call rate) ────────────────
CREATE TABLE IF NOT EXISTS rate_limits (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_type      TEXT NOT NULL,                  -- tenant | capability
  scope_id        TEXT NOT NULL,
  period_seconds  INTEGER NOT NULL,               -- e.g. 60 = per-minute
  max_calls       INTEGER NOT NULL,
  current_calls   INTEGER NOT NULL DEFAULT 0,
  window_start    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (scope_type, scope_id, period_seconds)
);

-- ─── authz_decisions (denormalised audit_events extract for IAM denials) ──
CREATE TABLE IF NOT EXISTS authz_decisions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_event_id  UUID REFERENCES audit_events(id) ON DELETE CASCADE,
  trace_id        TEXT,
  actor_id        TEXT NOT NULL,
  resource_type   TEXT NOT NULL,
  resource_id     TEXT,
  action          TEXT NOT NULL,                  -- view | edit | start | invoke | …
  decision        TEXT NOT NULL,                  -- allow | deny
  reason          TEXT,
  decided_by      TEXT,                           -- 'iam' | 'workgraph-legacy' | …
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_authz_actor_time     ON authz_decisions(actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_authz_resource       ON authz_decisions(resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_authz_decision_time  ON authz_decisions(decision, created_at DESC);

-- ─── Seed: a tiny default rate card so the cost calc has data on day 1 ────
INSERT INTO rate_card (provider, model, input_per_1k_usd, output_per_1k_usd, source) VALUES
  ('openai',    'gpt-4o-mini',       0.000150, 0.000600, 'seed'),
  ('openai',    'gpt-4o',            0.002500, 0.010000, 'seed'),
  ('openai',    'gpt-4-turbo',       0.010000, 0.030000, 'seed'),
  ('openai',    'text-embedding-3-small', 0.000020, 0.000000, 'seed'),
  ('anthropic', 'claude-3-5-sonnet-20241022', 0.003000, 0.015000, 'seed'),
  ('anthropic', 'claude-3-5-haiku-20241022',  0.001000, 0.005000, 'seed'),
  ('anthropic', 'claude-sonnet-4-6', 0.003000, 0.015000, 'seed'),
  ('copilot',   'gpt-4o-mini',       0.000150, 0.000600, 'seed'),
  ('copilot',   'gpt-4o',            0.002500, 0.010000, 'seed'),
  ('mock',      'mock-fast',         0.000000, 0.000000, 'seed')
ON CONFLICT DO NOTHING;
