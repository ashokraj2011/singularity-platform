-- B4 — availability failover provenance on llm_calls.
--
-- m76 added degraded_from/degrade_reason for BUDGET degradation. This adds the
-- other reason a call can be served by a model nobody asked for, and the two
-- are deliberately separate columns rather than one "why" field:
--
--   degraded_from   BUDGET. A different, CHEAPER TIER. Quality dropped on
--                   purpose, because the platform decided to spend less.
--   fallback_from   AVAILABILITY. The SAME tier, ideally a different provider,
--                   because the first one was down. Quality is unchanged; what
--                   changed is who answered.
--
-- Collapsing them would make "our models got worse this month" and "our vendor
-- had a bad afternoon" the same row, and those two findings lead an operator to
-- opposite actions: one is a policy conversation, the other is a vendor one.
--
-- NULL means "served by the first choice", not "unknown".
--
-- Idempotent, and mirrored into db/init.sql — if you change one, change both.

ALTER TABLE audit_governance.llm_calls
  ADD COLUMN IF NOT EXISTS fallback_from TEXT;

-- Partial, like the degradation index: failovers should be rare, and a provider
-- outage is exactly when you want "what failed over, and when did it start"
-- to be a fast query rather than a scan.
CREATE INDEX IF NOT EXISTS idx_llm_calls_failover
  ON audit_governance.llm_calls (created_at DESC)
  WHERE fallback_from IS NOT NULL;
