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
  if (rate) {
    const inRate = parseFloat(rate.input_per_1k_usd);
    const outRate = parseFloat(rate.output_per_1k_usd);
    costUsd = (p.input_tokens / 1000) * inRate + (p.output_tokens / 1000) * outRate;
    rateCardId = rate.id;
  }

  await query(
    `INSERT INTO audit_governance.llm_calls
       (audit_event_id, trace_id, capability_id, tenant_id,
        provider, model, input_tokens, output_tokens, total_tokens,
        latency_ms, finish_reason, cost_usd, rate_card_id,
        degraded_from, degrade_reason, fallback_from)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [
      eventId, traceId, capabilityId, tenantId,
      p.provider, p.model, p.input_tokens, p.output_tokens, total,
      p.latency_ms ?? null, p.finish_reason ?? null,
      costUsd, rateCardId,
      // B3 — NULL means "not degraded", not "unknown". Persisted here so
      // "what did budget pressure downgrade this month" is one WHERE clause
      // rather than a log correlation against the budgets table by timestamp.
      p.degraded_from ?? null, p.degrade_reason ?? null,
      // B4 — availability, not budget. Deliberately a separate column: a vendor
      // outage and a spend decision must never read as the same event.
      p.fallback_from ?? null,
    ],
  );

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
