-- M75 — llm_calls: identity, routing provenance, and content fingerprints.
--
-- llm_calls already had the right cost shape (tokens, latency, finish_reason,
-- cost_usd, tenant_id) but three things were missing before it could answer
-- "what did this user's LLM traffic cost today":
--
--   1. WHO. There was no actor column on any LLM record anywhere in the
--      platform, so per-user attribution was not merely unindexed — it was
--      unrepresentable.
--   2. WHICH ALIAS + WHY. `model` records what ran; it does not record which
--      alias was asked for, what task it served, or whether policy substituted
--      something other than the caller's first choice.
--   3. WHAT WAS SENT. Not the text — a fingerprint. Enough for dedup, replay
--      verification and cache analysis without putting prompt bodies in a table
--      that gets aggregated.
--
-- Deliberately NOT added: prompt or response text. llm_calls is queried in
-- aggregate; text would make every rollup drag megabytes and hold retention
-- policy hostage to the noisiest column. Text is already captured elsewhere
-- (masked + capped in audit_events; unmasked + uncapped in
-- PromptAssemblyLayer.contentSnapshot — the latter being a security item, not a
-- logging one).
--
-- Every statement is idempotent: bin/docker-core.sh and bin/bare-metal.sh
-- re-apply every file in this directory on each boot with ON_ERROR_STOP=1, so a
-- non-repeatable statement here is a startup failure, not a one-time error.

SET search_path = audit_governance, public;

-- ── Identity ───────────────────────────────────────────────────────────────
-- actor_id is ATTRIBUTION, NOT AUTHORIZATION. The gateway sits behind one
-- shared bearer, so any caller can claim any actor. Good enough to answer "what
-- did this cost"; categorically not good enough to found isolation on. Nothing
-- should build RLS on this column.
--
-- Convention: never NULL once the emitter ships. A human actor is a user id; a
-- background call is 'system:<service-name>'. That way NULL keeps meaning
-- "somebody forgot to propagate it" rather than blurring into "no human".
ALTER TABLE llm_calls ADD COLUMN IF NOT EXISTS actor_id        TEXT;

-- ── Routing provenance ─────────────────────────────────────────────────────
ALTER TABLE llm_calls ADD COLUMN IF NOT EXISTS model_alias     TEXT;
ALTER TABLE llm_calls ADD COLUMN IF NOT EXISTS task_tag        TEXT;
ALTER TABLE llm_calls ADD COLUMN IF NOT EXISTS stage           TEXT;
ALTER TABLE llm_calls ADD COLUMN IF NOT EXISTS purpose         TEXT;
ALTER TABLE llm_calls ADD COLUMN IF NOT EXISTS endpoint        TEXT;

-- How the model was chosen: 'caller_pin' | 'policy' | 'default' | 'fallback'.
ALTER TABLE llm_calls ADD COLUMN IF NOT EXISTS routing_source  TEXT;

-- Budget-aware degradation must be legible after the fact. Silent quality
-- regression is the hardest failure mode in this design to debug, so when
-- budget pressure downgrades a tier we record what the caller would otherwise
-- have got and why. NULL = no degradation occurred.
ALTER TABLE llm_calls ADD COLUMN IF NOT EXISTS degraded_from   TEXT;
ALTER TABLE llm_calls ADD COLUMN IF NOT EXISTS degrade_reason  TEXT;

-- Availability failover within a tier (distinct from degradation: same tier,
-- different provider, because the first candidate was not ready).
ALTER TABLE llm_calls ADD COLUMN IF NOT EXISTS fallback_from   TEXT;

-- ── Price provenance ───────────────────────────────────────────────────────
-- Two independent price sources exist: the gateway's per-alias catalog and this
-- schema's rate_card, keyed (provider, model). They can disagree — the catalog
-- can price two aliases pointing at the same model differently, which
-- rate_card's key cannot express. Recording which one produced cost_usd is what
-- makes the disagreement visible instead of mysterious.
--   'gateway_catalog' | 'rate_card' | NULL (unpriced)
ALTER TABLE llm_calls ADD COLUMN IF NOT EXISTS price_source    TEXT;

-- ── Correlation ────────────────────────────────────────────────────────────
-- Minted by the gateway and echoed on its response, so the phase-machine trace
-- event (governed.llm_response) and this cost row join EXACTLY, rather than
-- heuristically by trace_id + timestamp proximity.
ALTER TABLE llm_calls ADD COLUMN IF NOT EXISTS gateway_call_id UUID;

-- ── Content fingerprints ───────────────────────────────────────────────────
ALTER TABLE llm_calls ADD COLUMN IF NOT EXISTS prompt_sha256   TEXT;
ALTER TABLE llm_calls ADD COLUMN IF NOT EXISTS response_sha256 TEXT;
ALTER TABLE llm_calls ADD COLUMN IF NOT EXISTS prompt_chars    INTEGER;
ALTER TABLE llm_calls ADD COLUMN IF NOT EXISTS response_chars  INTEGER;

-- ── Indexes ────────────────────────────────────────────────────────────────
-- "What did this user cost today" and "what did this tenant cost today" are the
-- two queries this table now exists to answer; both are time-ordered.
CREATE INDEX IF NOT EXISTS idx_llm_calls_actor_time
  ON llm_calls(actor_id, created_at DESC)
  WHERE actor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_llm_calls_tenant_time
  ON llm_calls(tenant_id, created_at DESC)
  WHERE tenant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_llm_calls_task_tag_time
  ON llm_calls(task_tag, created_at DESC)
  WHERE task_tag IS NOT NULL;
-- Partial + unique: one cost row per gateway call. Makes a duplicated emission
-- a constraint violation rather than double-counted spend. Partial because
-- pre-M75 rows (and any laptop emitter that cannot mint one) carry NULL, and
-- NULLs must not collide with each other.
CREATE UNIQUE INDEX IF NOT EXISTS idx_llm_calls_gateway_call
  ON llm_calls(gateway_call_id)
  WHERE gateway_call_id IS NOT NULL;
