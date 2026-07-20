-- B3 — routing provenance on llm_calls.
--
-- llm_calls records WHAT a call cost and WHICH model served it. It has never
-- recorded WHY that model was chosen, which was fine while the answer was
-- always "because a *_MODEL_ALIAS env var said so" — that is a deploy-time
-- constant, discoverable from the config.
--
-- Budget degradation breaks that assumption. The gateway can now serve a call
-- on a cheaper tier than the policy nominally routes it to, and the decision is
-- made per-call from spend state that changes through the day. Without these
-- columns, "why is this month's output worse than last month's" is answerable
-- only by correlating log lines against a budget table by timestamp, which is
-- to say: not answerable.
--
--   degraded_from   the tier the call WOULD have used. NULL on a normal call,
--                   so `WHERE degraded_from IS NOT NULL` is the whole query.
--   degrade_reason  the one-line explanation, including the observed budget
--                   percentage — an operator needs to distinguish "degraded
--                   because spend is genuinely high" from "degraded because the
--                   only spend we can SEE is the MCP-relayed subset".
--
-- NULL means "not degraded", not "unknown". Every writer sets these explicitly.
--
-- Idempotent (IF NOT EXISTS) so re-running is safe, matching the other
-- migrations in this directory. The same columns are added to db/init.sql so a
-- fresh database and a migrated one converge — if you change one, change both.

ALTER TABLE audit_governance.llm_calls
  ADD COLUMN IF NOT EXISTS degraded_from  TEXT,
  ADD COLUMN IF NOT EXISTS degrade_reason TEXT;

-- Partial index: degradations are meant to be RARE, so indexing only the
-- non-NULL rows keeps this near-free while making "show me everything that got
-- degraded" a cheap query rather than a sequential scan of every LLM call ever.
CREATE INDEX IF NOT EXISTS idx_llm_calls_degraded
  ON audit_governance.llm_calls (created_at DESC)
  WHERE degraded_from IS NOT NULL;
