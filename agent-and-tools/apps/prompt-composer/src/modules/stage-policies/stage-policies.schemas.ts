/**
 * M71 — Request/response schemas for stage-policy resolution.
 *
 * context-fabric loads policies at the start of each /execute call:
 *   POST /api/v1/stage-policies/resolve  { stageKey, agentRole?, phase? }
 *
 * Without `phase` the whole policy (all phases) comes back so the caller
 * can cache it for the stage. With `phase` only that phase's allowlist +
 * required output schema comes back — useful for narrow per-turn checks.
 *
 * Spec: singularity_governed_coding_loop_spec.md §8 (StagePolicy YAML)
 */
import { z } from "zod";

/**
 * Canonical phase enum from §6.1. Kept here as a runtime check so admin
 * upserts can't write garbage (e.g. "verify" instead of "VERIFY") into the
 * StagePhasePolicy.phase column.
 */
export const PHASES = [
  "PLAN",
  "EXPLORE",
  "ACT",
  "VERIFY",
  "REPAIR",
  "SELF_REVIEW",
  "FINALIZE",
] as const;
export type Phase = (typeof PHASES)[number];

export const resolveStagePolicySchema = z.object({
  stageKey:  z.string().min(1, "stageKey required"),
  agentRole: z.string().min(1).optional(),
  // When set, the response narrows to that single phase.
  phase:     z.enum(PHASES).optional(),
});
export type ResolveStagePolicyInput = z.infer<typeof resolveStagePolicySchema>;

const phasePolicySchema = z.object({
  phase:                z.enum(PHASES),
  allowedTools:         z.array(z.string()).default([]),
  forbiddenTools:       z.array(z.string()).default([]),
  requiredOutputSchema: z.record(z.unknown()).default({}),
  maxInputTokens:       z.number().int().nullable().optional(),
  maxOutputTokens:      z.number().int().nullable().optional(),
  maxToolCalls:         z.number().int().nullable().optional(),
});
export type PhasePolicyInput = z.infer<typeof phasePolicySchema>;

/**
 * Admin upsert payload for a complete stage policy. `phases` carries the
 * per-phase rows; the upsert is all-or-nothing (existing phase rows for
 * this policy are deleted and replaced) to keep policy revisions atomic.
 */
export const upsertStagePolicySchema = z.object({
  stageKey:           z.string().min(1),
  agentRole:          z.string().min(1).nullable().optional(),
  version:            z.number().int().positive().default(1),
  status:             z.enum(["ACTIVE", "DRAFT", "RETIRED"]).default("ACTIVE"),
  description:        z.string().optional(),
  approvalModel:      z.record(z.unknown()).default({}),
  limits:             z.record(z.unknown()).default({}),
  contextPolicy:      z.record(z.unknown()).default({}),
  editPolicy:         z.record(z.unknown()).default({}),
  verificationPolicy: z.record(z.unknown()).default({}),
  riskPolicy:         z.record(z.unknown()).default({}),
  phases:             z.array(phasePolicySchema).default([]),
});
export type UpsertStagePolicyInput = z.infer<typeof upsertStagePolicySchema>;

/**
 * The shape context-fabric receives. When `phase` was supplied in the
 * request, `phases` is filtered to that single row — but the top-level
 * policy fields (approval/limits/context/edit/verification/risk) are
 * always returned because they're stage-wide.
 */
export interface ResolveStagePolicyResult {
  policyId:           string;
  stageKey:           string;
  agentRole:          string | null;
  version:            number;
  status:             string;
  approvalModel:      Record<string, unknown>;
  limits:             Record<string, unknown>;
  contextPolicy:      Record<string, unknown>;
  editPolicy:         Record<string, unknown>;
  verificationPolicy: Record<string, unknown>;
  riskPolicy:         Record<string, unknown>;
  phases: Array<{
    phase:                Phase;
    allowedTools:         string[];
    forbiddenTools:       string[];
    requiredOutputSchema: Record<string, unknown>;
    maxInputTokens:       number | null;
    maxOutputTokens:      number | null;
    maxToolCalls:         number | null;
  }>;
}
