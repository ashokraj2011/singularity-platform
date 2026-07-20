/** M21 — canonical event payload accepted by POST /events. */
import { z } from "zod";

export const eventSchema = z.object({
  trace_id:       z.string().optional(),
  source_service: z.string().min(1),
  kind:           z.string().min(1),
  subject_type:   z.string().optional(),
  subject_id:     z.string().optional(),
  actor_id:       z.string().optional(),
  capability_id:  z.string().optional(),
  tenant_id:      z.string().optional(),
  severity:       z.enum(["info", "warn", "error", "audit"]).optional(),
  payload:        z.record(z.unknown()).optional(),
});
export type Event = z.infer<typeof eventSchema>;

/** payload shape of `llm.call.completed` events. The cost worker reads these
 *  fields when denormalising into llm_calls.
 *
 *  IMPORTANT — this schema is a SILENT gate. cost-worker.ts safeParses the
 *  payload and returns quietly when it fails, so a field that is not declared
 *  here is stripped without a word, and a field declared too strictly takes the
 *  ENTIRE cost row down with it. That is why:
 *
 *    - every M75 field below is optional (a legacy emitter that sends only the
 *      original seven fields keeps working unchanged), and
 *    - the shape-constrained ones carry `.catch(undefined)` so a malformed
 *      value degrades that one column to NULL instead of dropping the row.
 *      Losing gateway_call_id is an inconvenience; losing the spend is not.
 *
 *  Never add a prompt or response TEXT field here. llm_calls is aggregated;
 *  fingerprints and char counts are what belong on it (see m75 migration).
 */
export const llmCallPayload = z.object({
  provider:       z.string(),
  model:          z.string(),
  input_tokens:   z.number().int().nonnegative(),
  output_tokens:  z.number().int().nonnegative(),
  total_tokens:   z.number().int().nonnegative().optional(),
  latency_ms:     z.number().int().nonnegative().optional(),
  finish_reason:  z.string().optional(),

  // ── M75 identity ─────────────────────────────────────────────────────────
  // ATTRIBUTION, NOT AUTHORIZATION — the gateway sits behind one shared bearer
  // so any caller can claim any actor. Never found isolation on this.
  actor_id:        z.string().optional(),

  // ── M75 routing provenance ───────────────────────────────────────────────
  model_alias:     z.string().optional(),
  task_tag:        z.string().optional(),
  stage:           z.string().optional(),
  purpose:         z.string().optional(),
  endpoint:        z.string().optional(),
  routing_source:  z.string().optional(),
  degraded_from:   z.string().optional(),
  degrade_reason:  z.string().optional(),
  fallback_from:   z.string().optional(),

  // ── M75 price provenance ─────────────────────────────────────────────────
  // The emitter's own catalog price. Used only when this schema's rate_card
  // has no row for (provider, model) — see cost-worker. price_source records
  // which of the two produced cost_usd, so a disagreement is visible rather
  // than mysterious.
  cost_usd:        z.number().nonnegative().optional().catch(undefined),
  price_source:    z.string().optional(),

  // ── M75 correlation ──────────────────────────────────────────────────────
  // Minted by the gateway, echoed on its response, unique-indexed here. Lets
  // the trace event and the cost row join EXACTLY instead of heuristically by
  // trace_id + timestamp proximity.
  gateway_call_id: z.string().uuid().optional().catch(undefined),

  // ── M75 content fingerprints (NEVER content) ─────────────────────────────
  prompt_sha256:   z.string().optional(),
  response_sha256: z.string().optional(),
  prompt_chars:    z.number().int().nonnegative().optional().catch(undefined),
  response_chars:  z.number().int().nonnegative().optional().catch(undefined),
});

export const approvalCreateSchema = z.object({
  id:             z.string().min(8),                  // continuation_token
  trace_id:       z.string().optional(),
  capability_id:  z.string().optional(),
  tenant_id:      z.string().optional(),
  source_service: z.string().default("mcp-server"),
  tool_name:      z.string().min(1),
  tool_args:      z.record(z.unknown()).default({}),
  risk_level:     z.string().optional(),
  requested_by:   z.string().optional(),
  expires_at:     z.string().optional(),              // ISO timestamp
  // M21.5 — authoritative LoopState envelope so mcp-server can resume after
  // a restart. Opaque blob, audit-gov doesn't inspect it.
  continuation_payload: z.record(z.unknown()).optional(),
});

export const approvalDecideSchema = z.object({
  decision:        z.enum(["approved", "rejected"]),
  decided_by:      z.string().optional(),
  decision_reason: z.string().optional(),
});

export const budgetUpsertSchema = z.object({
  scope_type:    z.enum(["tenant", "capability"]),
  scope_id:      z.string().min(1),
  period:        z.enum(["day", "week", "month"]),
  tokens_max:    z.number().int().positive().nullable().optional(),
  cost_max_usd:  z.number().nonnegative().nullable().optional(),
});

export const rateLimitUpsertSchema = z.object({
  scope_type:    z.enum(["tenant", "capability"]),
  scope_id:      z.string().min(1),
  period_seconds: z.number().int().positive(),
  max_calls:     z.number().int().positive(),
});

export const authzDecisionSchema = z.object({
  trace_id:      z.string().optional(),
  actor_id:      z.string().min(1),
  resource_type: z.string().min(1),
  resource_id:   z.string().optional(),
  action:        z.string().min(1),
  decision:      z.enum(["allow", "deny"]),
  reason:        z.string().optional(),
  decided_by:    z.string().optional(),
});
