/**
 * M21 — cost calc worker.
 *
 * When an `llm.call.completed` audit_event lands, look up the active rate
 * card row for (provider, model) and write a denormalised llm_calls row
 * with cost_usd. If no rate card matches, llm_calls.cost_usd stays NULL
 * but the row still lands so token rollups work.
 */
import { query, queryOne } from "./db";
import { llmCallPayload } from "./types";

interface RateCardRow extends Record<string, unknown> {
  id: string;
  input_per_1k_usd: string;   // pg returns NUMERIC as string
  output_per_1k_usd: string;
}

export async function denormaliseLlmCall(eventId: string, traceId: string | null,
  capabilityId: string | null, tenantId: string | null,
  payloadIn: Record<string, unknown>): Promise<void> {
  const parsed = llmCallPayload.safeParse(payloadIn);
  if (!parsed.success) return;
  const p = parsed.data;
  const total = p.total_tokens ?? (p.input_tokens + p.output_tokens);

  // Pick the active rate card (effective_from <= now <= effective_to OR NULL).
  const rate = await queryOne<RateCardRow>(
    `SELECT id, input_per_1k_usd, output_per_1k_usd
     FROM audit_governance.rate_card
     WHERE provider = $1 AND model = $2
       AND effective_from <= now()
       AND (effective_to IS NULL OR effective_to > now())
     ORDER BY effective_from DESC LIMIT 1`,
    [p.provider, p.model],
  );

  let costUsd: number | null = null;
  let rateCardId: string | null = null;
  // M75 — which of the two independent price sources produced cost_usd.
  // rate_card is keyed (provider, model); the emitter's catalog is keyed by
  // alias and can price two aliases on one model differently, which rate_card
  // cannot express. rate_card WINS when it matches, so existing behaviour is
  // bit-for-bit unchanged; the catalog price only fills rows that would
  // otherwise have been silently unpriced.
  let priceSource: string | null = null;
  if (rate) {
    const inRate = parseFloat(rate.input_per_1k_usd);
    const outRate = parseFloat(rate.output_per_1k_usd);
    costUsd = (p.input_tokens / 1000) * inRate + (p.output_tokens / 1000) * outRate;
    rateCardId = rate.id;
    priceSource = "rate_card";
  } else if (typeof p.cost_usd === "number") {
    costUsd = p.cost_usd;
    priceSource = p.price_source ?? "emitter_catalog";
  }

  const inserted = await query<{ id: string }>(
    `INSERT INTO audit_governance.llm_calls
       (audit_event_id, trace_id, capability_id, tenant_id,
        provider, model, input_tokens, output_tokens, total_tokens,
        latency_ms, finish_reason, cost_usd, rate_card_id,
        actor_id, model_alias, task_tag, stage, purpose, endpoint,
        routing_source, degraded_from, degrade_reason, fallback_from,
        price_source, gateway_call_id,
        prompt_sha256, response_sha256, prompt_chars, response_chars)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
             $14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29)
     ON CONFLICT (gateway_call_id) WHERE gateway_call_id IS NOT NULL
       DO NOTHING
     RETURNING id`,
    [
      eventId, traceId, capabilityId, tenantId,
      p.provider, p.model, p.input_tokens, p.output_tokens, total,
      p.latency_ms ?? null, p.finish_reason ?? null,
      costUsd, rateCardId,
      // M75 identity + provenance. actor_id rides the payload rather than the
      // envelope because the envelope's actor_id is the audit_events notion of
      // "who" and is not always the LLM caller.
      p.actor_id ?? null, p.model_alias ?? null, p.task_tag ?? null,
      p.stage ?? null, p.purpose ?? null, p.endpoint ?? null,
      p.routing_source ?? null, p.degraded_from ?? null,
      p.degrade_reason ?? null, p.fallback_from ?? null,
      priceSource, p.gateway_call_id ?? null,
      p.prompt_sha256 ?? null, p.response_sha256 ?? null,
      p.prompt_chars ?? null, p.response_chars ?? null,
    ],
  );
  // ON CONFLICT DO NOTHING, not a raised unique violation: the m75 index
  // exists so a retried emission cannot double-count spend, and a quiet
  // no-op achieves that without turning an at-most-once emitter's retry
  // into a 500 on POST /events (which would also abort the SSE broadcast
  // and the rest of ingestOne for an event that is already recorded).
  //
  // A conflict means this exact gateway call is ALREADY accounted for, so
  // everything downstream of the row must be skipped too. Bumping budgets on
  // a duplicate would double-count the spend the unique index was added to
  // prevent — the row would be deduped while the budget silently was not.
  if (inserted.length === 0) return;

  // M65 Slice 1A — Populate token_savings_runs when the payload carries
  // prompt-cache or compression metrics. This used to live in
  // metrics-ledger as a separate POST from the upstream caller; moving
  // the denorm here means callers stop dual-writing and operators have
  // one canonical store for savings analytics.
  await maybeRecordSavings(eventId, capabilityId, tenantId, payloadIn, p, costUsd, rateCardId, inRateOrNull(rate), outRateOrNull(rate));

  // Best-effort: bump active budgets if any apply. Doesn't enforce; that's
  // the /governance/budget/check endpoint's job at decision-time.
  if (costUsd !== null) {
    await bumpBudgets(capabilityId, tenantId, total, costUsd);
  }
}

function inRateOrNull(rate: RateCardRow | null): number | null {
  return rate ? parseFloat(rate.input_per_1k_usd) : null;
}
function outRateOrNull(rate: RateCardRow | null): number | null {
  return rate ? parseFloat(rate.output_per_1k_usd) : null;
}

/**
 * M65 Slice 1A — Derive a `token_savings_runs` row from an
 * `llm.call.completed` audit event whose payload carries cache or
 * compression metrics. Skip silently when the payload doesn't have
 * those (the row stays absent — savings are only meaningful when
 * there's an actual optimization to measure).
 *
 * Payload fields recognised:
 *   - cached_input_tokens / cache_read_tokens / cache_write_tokens
 *     → "cache" optimization_mode
 *   - compression_original_tokens / compression_compressed_tokens
 *     → "compression" optimization_mode
 *   - session_id, agent_id, model_call_id, context_package_id, quality_score
 *     → metadata fields carried through to the savings row
 */
async function maybeRecordSavings(
  eventId: string,
  capabilityId: string | null,
  tenantId: string | null,
  payloadIn: Record<string, unknown>,
  p: { provider: string; model: string; input_tokens: number; output_tokens: number; latency_ms?: number | null },
  costUsd: number | null,
  rateCardId: string | null,
  inRate: number | null,
  outRate: number | null,
): Promise<void> {
  // Look for the optimization signal. We accept either flat fields
  // (cache_read_tokens at top level) or nested under
  // payload.optimization. Upstream emitters use both shapes today.
  const opt = (payloadIn.optimization && typeof payloadIn.optimization === "object")
    ? payloadIn.optimization as Record<string, unknown>
    : payloadIn;

  const cacheRead = numberOrZero(opt.cache_read_tokens ?? payloadIn.cache_read_tokens);
  const cacheWrite = numberOrZero(opt.cache_write_tokens ?? payloadIn.cache_write_tokens);
  const cachedInput = numberOrZero(opt.cached_input_tokens ?? payloadIn.cached_input_tokens);
  const compOriginal = numberOrZero(opt.compression_original_tokens);
  const compCompressed = numberOrZero(opt.compression_compressed_tokens);

  const hasCache = cacheRead > 0 || cacheWrite > 0 || cachedInput > 0;
  const hasCompression = compOriginal > 0 && compCompressed > 0 && compCompressed < compOriginal;
  if (!hasCache && !hasCompression) return;

  // Pick the mode. Both can be present; prefer compression (larger
  // savings signal) but record cache numbers if that's what we have.
  const mode = hasCompression ? "compression" : "cache";

  // Raw vs optimized input tokens:
  //  - compression: original vs compressed text
  //  - cache: input_tokens + cache_read (would-be) vs input_tokens actual
  const rawInput = hasCompression ? compOriginal : (p.input_tokens + cacheRead);
  const optimizedInput = hasCompression ? compCompressed : p.input_tokens;
  const tokensSaved = Math.max(0, rawInput - optimizedInput);
  const percentSaved = rawInput > 0 ? (tokensSaved / rawInput) : 0;

  const estimatedRawCost = inRate !== null
    ? (rawInput / 1000) * inRate + (p.output_tokens / 1000) * (outRate ?? 0)
    : 0;
  const estimatedOptimizedCost = costUsd ?? 0;
  const estimatedCostSaved = Math.max(0, estimatedRawCost - estimatedOptimizedCost);

  // session_id / agent_id sourced from the payload top-level (the
  // emitter sets them when the call is part of a workflow attempt).
  const sessionId = typeof payloadIn.session_id === "string" ? payloadIn.session_id
    : typeof payloadIn.run_id === "string" ? payloadIn.run_id
    : "unknown";
  const agentId = typeof payloadIn.agent_id === "string" ? payloadIn.agent_id : null;
  const contextPackageId = typeof payloadIn.context_package_id === "string" ? payloadIn.context_package_id : null;
  const modelCallId = typeof payloadIn.model_call_id === "string" ? payloadIn.model_call_id : null;
  const qualityScore = typeof payloadIn.quality_score === "number" ? payloadIn.quality_score : null;

  await query(
    `INSERT INTO audit_governance.token_savings_runs
       (audit_event_id, session_id, agent_id, context_package_id, model_call_id,
        optimization_mode, raw_input_tokens, optimized_input_tokens, output_tokens,
        tokens_saved, percent_saved, estimated_raw_cost, estimated_optimized_cost,
        estimated_cost_saved, provider, model_name, latency_ms, quality_score,
        capability_id, tenant_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
    [
      eventId, sessionId, agentId, contextPackageId, modelCallId,
      mode, rawInput, optimizedInput, p.output_tokens,
      tokensSaved, percentSaved, estimatedRawCost, estimatedOptimizedCost,
      estimatedCostSaved, p.provider, p.model, p.latency_ms ?? null, qualityScore,
      capabilityId, tenantId,
    ],
  );
  // rateCardId is intentionally not stored on the savings row — it's
  // already on the matched llm_calls row; join via audit_event_id if
  // an analyst needs it.
  void rateCardId;
}

function numberOrZero(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

async function bumpBudgets(capabilityId: string | null, tenantId: string | null,
  tokens: number, costUsd: number): Promise<void> {
  // Update `current_tokens` + `current_cost` on any budget rows whose period
  // window covers `now()` AND scope_id matches. ON CONFLICT is via UNIQUE
  // (scope_type, scope_id, period, period_start) so a missing budget is
  // simply a no-op (no row updated).
  if (capabilityId) {
    await query(
      `UPDATE audit_governance.budgets
       SET current_tokens = current_tokens + $1,
           current_cost   = current_cost + $2,
           updated_at     = now()
       WHERE scope_type = 'capability' AND scope_id = $3
         AND now() >= period_start AND now() < period_end`,
      [tokens, costUsd, capabilityId],
    );
  }
  if (tenantId) {
    await query(
      `UPDATE audit_governance.budgets
       SET current_tokens = current_tokens + $1,
           current_cost   = current_cost + $2,
           updated_at     = now()
       WHERE scope_type = 'tenant' AND scope_id = $3
         AND now() >= period_start AND now() < period_end`,
      [tokens, costUsd, tenantId],
    );
  }
}
