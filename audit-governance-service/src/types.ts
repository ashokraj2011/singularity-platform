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
 *  fields when denormalising into llm_calls. */
export const llmCallPayload = z.object({
  provider:       z.string(),
  model:          z.string(),
  input_tokens:   z.number().int().nonnegative(),
  output_tokens:  z.number().int().nonnegative(),
  total_tokens:   z.number().int().nonnegative().optional(),
  latency_ms:     z.number().int().nonnegative().optional(),
  finish_reason:  z.string().optional(),
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
