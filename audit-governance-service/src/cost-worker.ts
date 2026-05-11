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
        latency_ms, finish_reason, cost_usd, rate_card_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      eventId, traceId, capabilityId, tenantId,
      p.provider, p.model, p.input_tokens, p.output_tokens, total,
      p.latency_ms ?? null, p.finish_reason ?? null,
      costUsd, rateCardId,
    ],
  );

  // Best-effort: bump active budgets if any apply. Doesn't enforce; that's
  // the /governance/budget/check endpoint's job at decision-time.
  if (costUsd !== null) {
    await bumpBudgets(capabilityId, tenantId, total, costUsd);
  }
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
