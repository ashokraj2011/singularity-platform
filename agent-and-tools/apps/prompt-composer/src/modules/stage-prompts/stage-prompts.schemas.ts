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

export const resolveStageSchema = z.object({
  stageKey:  z.string().min(1, "stageKey required"),
  agentRole: z.string().min(1).optional(),
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
  /** The resolved PromptProfile id, for traceability + downstream audit. */
  promptProfileId: string;
  /** The binding row that matched, for debugging. */
  bindingId: string;
  /** Echo back the resolved stage key + role for clients to log. */
  stageKey: string;
  agentRole: string | null;
}
