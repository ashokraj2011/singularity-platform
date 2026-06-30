/**
 * M36.1 — request/response schemas for stage-prompt resolution.
 *
 * Callers (workgraph-api blueprint runner, loop runner, etc.) pass:
 *   - stageKey   — canonical stage key, e.g. "blueprint.architect", "loop.develop"
 *   - agentRole  — optional role narrowing, e.g. "DEVELOPER", "QA"
 *   - vars       — Mustache substitution context for the task template
 *
 * Composer responds with the rendered task body + a system-prompt fragment
 * (assembled from the bound PromptProfile's role layer + output contract).
 * The caller passes both to /compose-and-respond — no prompt text crosses
 * the workgraph-api boundary.
 */
import { z } from "zod";

// M71 Slice E — canonical phase enum, mirrors StagePhasePolicy.phase + the
// PHASES const in stage-policies.schemas.ts. Kept here as a runtime check so
// the resolver can't be asked for a garbage phase like "verify".
export const PROMPT_PHASES = [
  "PLAN",
  "EXPLORE",
  "ACT",
  "VERIFY",
  "REPAIR",
  "SELF_REVIEW",
  "FINALIZE",
] as const;
export type PromptPhase = (typeof PROMPT_PHASES)[number];

export const resolveStageSchema = z.object({
  stageKey:  z.string().min(1, "stageKey required"),
  agentRole: z.string().min(1).optional(),
  // M71 — optional phase narrowing. When set, the resolver prefers a
  // (stageKey, agentRole, phase) binding; falls back to the stage-level
  // (stageKey, agentRole, NULL) binding if no phase-specific row exists.
  phase:     z.enum(PROMPT_PHASES).optional(),
  promptProfileKey: z.string().min(1).optional(),
  // #25 — capability scope. When set, the resolver appends the capability's
  // promoted long-term memory to extraContext so the governed turn is grounded
  // in prior distilled lessons (read-only; the promotion WRITE lifecycle —
  // CANDIDATE→APPROVED→PROMOTED — is a separate, deferred feature).
  capabilityId: z.string().min(1).optional(),
  // C — agent template whose bound skill sources (source type + permissions +
  // read-only / provider-locked) get appended to systemPromptAppend, so governed
  // SDLC stages see the same AGENT_SKILL_SOURCES context the full composer emits.
  // Optional — omitted (legacy callers) ⇒ no skill-source layer (back-compat).
  agentTemplateId: z.string().min(1).optional(),
  // Free-form context for Mustache substitution. Values are coerced to
  // strings before injection; objects/arrays are JSON-stringified.
  vars:      z.record(z.unknown()).optional(),
});

export type ResolveStageInput = z.infer<typeof resolveStageSchema>;

export interface ResolveStageResult {
  /** Rendered task body (Mustache-substituted) — pass as `task` to /compose. */
  task: string;
  /** Pre-assembled system-prompt fragment — pass as `overrides.systemPromptAppend`. */
  systemPromptAppend: string;
  /**
   * M36.6 — Rendered extraContext (Mustache-substituted from
   * PromptProfile.extraContextTemplate). Empty string when the bound profile
   * has no template. Pass as `overrides.extraContext` to /compose so the
   * per-execution dynamic policy block stays DB-owned.
   */
  extraContext: string;
  /** The resolved PromptProfile id, for traceability + downstream audit. */
  promptProfileId: string;
  /** The binding row that matched, for debugging. */
  bindingId: string;
  /** Echo back the resolved stage key + role for clients to log. */
  stageKey: string;
  agentRole: string | null;
  /**
   * M71 — Which phase the bound binding targets. NULL when a stage-level
   * (fallback) binding matched. Lets the caller log whether they got a
   * phase-specific prompt or the stage default.
   */
  phase: string | null;
}
