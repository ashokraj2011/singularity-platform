-- Singularity demo seed — audit-governance DB (`audit_governance`)
--
-- Apply AFTER audit-governance-service/db/init.sql has created the schema.
--
--   psql -d audit_governance -f seed/03-audit-governance.sql
--
-- Lands one demo budget + one rate-limit + a couple of synthetic audit_events
-- so /audit and /cost in the SPA have content on first open.

SET search_path = audit_governance, public;

BEGIN;

-- ── Demo budget (capability-scoped, daily, generous) ──────────────────────
INSERT INTO budgets
  (scope_type, scope_id, period, tokens_max, cost_max_usd,
   period_start, period_end,
   current_tokens, current_cost,
   created_at, updated_at)
VALUES (
  'capability',
  '11111111-2222-3333-4444-555555555555',
  'day',
  100000,            -- 100k tokens / day
  10.00,             --   $10 / day
  date_trunc('day', now()),
  date_trunc('day', now()) + interval '1 day',
  0,
  0,
  now(), now()
)
ON CONFLICT (scope_type, scope_id, period, period_start) DO UPDATE
  SET tokens_max = EXCLUDED.tokens_max,
      cost_max_usd = EXCLUDED.cost_max_usd,
      updated_at = now();

-- ── Demo rate-limit (capability-scoped, 60 calls / minute) ────────────────
INSERT INTO rate_limits
  (scope_type, scope_id, period_seconds, max_calls,
   current_calls, window_start, created_at)
VALUES (
  'capability',
  '11111111-2222-3333-4444-555555555555',
  60,
  60,
  0,
  now(),
  now()
)
ON CONFLICT (scope_type, scope_id, period_seconds) DO UPDATE
  SET max_calls = EXCLUDED.max_calls;

-- ── Demo audit events (so /audit isn't empty on a cold open) ──────────────
-- We pin the LLM event's audit_events.id so llm_calls.audit_event_id below has
-- a stable FK target. Inserts are skipped if already present (re-runs).
INSERT INTO audit_events
  (id, trace_id, capability_id, source_service, kind,
   subject_type, subject_id, actor_id, severity, payload, created_at)
SELECT
  '00000000-0000-0000-0000-00000000ae01'::uuid,
  'demo-trace-seed-1',
  '11111111-2222-3333-4444-555555555555',
  'agent-runtime',
  'agent.template.derived',
  'AgentTemplate',
  '00000000-0000-0000-0000-0000000000d2',
  'seed', 'info',
  '{"name":"Demo-DEV","baseTemplateId":"00000000-0000-0000-0000-0000000000d2","roleType":"DEVELOPER"}'::jsonb,
  now() - interval '5 minutes'
WHERE NOT EXISTS (SELECT 1 FROM audit_events WHERE id = '00000000-0000-0000-0000-00000000ae01');

INSERT INTO audit_events
  (id, trace_id, capability_id, source_service, kind,
   subject_type, subject_id, actor_id, severity, payload, created_at)
SELECT
  '00000000-0000-0000-0000-00000000ae02'::uuid,
  'demo-trace-seed-1',
  '11111111-2222-3333-4444-555555555555',
  'mcp-server',
  'llm.call.completed',
  'LlmCall',
  '00000000-0000-0000-0000-00000000ae02',
  NULL, 'info',
  '{"provider":"mock","model":"mock-fast","input_tokens":42,"output_tokens":86,"total_tokens":128,"cost_usd":0.0001,"latency_ms":340}'::jsonb,
  now() - interval '4 minutes'
WHERE NOT EXISTS (SELECT 1 FROM audit_events WHERE id = '00000000-0000-0000-0000-00000000ae02');

INSERT INTO audit_events
  (id, trace_id, capability_id, source_service, kind,
   subject_type, subject_id, actor_id, severity, payload, created_at)
SELECT
  '00000000-0000-0000-0000-00000000ae03'::uuid,
  'demo-trace-seed-1',
  '11111111-2222-3333-4444-555555555555',
  'context-fabric',
  'cf.execute.completed',
  'CfCallLog',
  '00000000-0000-0000-0000-00000000ae03',
  NULL, 'info',
  '{"status":"COMPLETED","total_tokens":128,"steps_taken":1}'::jsonb,
  now() - interval '3 minutes'
WHERE NOT EXISTS (SELECT 1 FROM audit_events WHERE id = '00000000-0000-0000-0000-00000000ae03');

-- ── Mirror llm_calls so /cost shows real numbers ──────────────────────────
INSERT INTO llm_calls
  (id, audit_event_id, trace_id, capability_id,
   provider, model,
   input_tokens, output_tokens, total_tokens,
   cost_usd, latency_ms, created_at)
SELECT
  gen_random_uuid(),
  '00000000-0000-0000-0000-00000000ae02'::uuid,
  'demo-trace-seed-1',
  '11111111-2222-3333-4444-555555555555',
  'mock', 'mock-fast',
  42, 86, 128,
  0.0001, 340,
  now() - interval '4 minutes'
WHERE NOT EXISTS (SELECT 1 FROM llm_calls WHERE trace_id = 'demo-trace-seed-1');

COMMIT;

-- Verify
SELECT 'budgets'        AS t, COUNT(*) FROM budgets
UNION ALL SELECT 'rate_limits',     COUNT(*) FROM rate_limits
UNION ALL SELECT 'audit_events',    COUNT(*) FROM audit_events
UNION ALL SELECT 'llm_calls',       COUNT(*) FROM llm_calls
UNION ALL SELECT 'rate_card',       COUNT(*) FROM rate_card;
