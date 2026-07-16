/**
 * claim-registry — the lowering contract (M-CR2). PURE: prompt building + strict
 * parsing of the LLM's proposed claims, so the load-bearing "did the model return
 * usable candidates?" logic unit-tests without the gateway. The actual LLM call
 * goes through the central gateway by model_alias (gateway.ts) — this module never
 * touches a provider.
 *
 * Lowering = turning a raw capture (transcript, doc) into atomic, typed claim
 * candidates a human then reviews. Candidates are ADVISORY: modelConfidence is a
 * self-estimate, never the posterior.
 */
import { z } from 'zod';

export const LOWERABLE_KINDS = ['HYPOTHESIS', 'ASSUMPTION', 'OBSERVATION', 'CONSTRAINT', 'DECISION', 'REQUIREMENT'] as const;
export type LowerableKind = (typeof LOWERABLE_KINDS)[number];

export const loweringCandidateSchema = z.object({
  statement: z.string().trim().min(1).max(2000), // present tense, single assertion
  kind: z.enum(LOWERABLE_KINDS),
  confidence: z.number().min(0).max(1).default(0.5),
});
export type LoweringCandidateProposal = z.infer<typeof loweringCandidateSchema>;

const MAX_CANDIDATES = 50;

export function loweringSystemPrompt(): string {
  return [
    'You are a "lowering pass": you turn a raw capture (meeting transcript, doc) into atomic,',
    'falsifiable claim candidates that a human will review. Extract every distinct assertion —',
    'do NOT merge or editorialize.',
    'Each candidate: a "statement" (present tense, ONE assertion, canonical proposition), a "kind"',
    'from HYPOTHESIS | ASSUMPTION | OBSERVATION | CONSTRAINT | DECISION | REQUIREMENT, and a',
    '"confidence" 0..1 (your self-estimate that this is a real, well-formed claim — advisory only).',
    'HYPOTHESIS = falsifiable belief; ASSUMPTION = held-true-but-unvalidated; OBSERVATION = something',
    'seen/measured; CONSTRAINT = externally imposed; DECISION = a choice made; REQUIREMENT = a validated',
    'build intent. Return STRICT JSON: an array of {statement, kind, confidence}. Output JSON only.',
  ].join(' ');
}

export function buildLoweringTask(transcript: string, context?: { source?: string }): string {
  const src = context?.source ? `Source: ${context.source}\n` : '';
  return `${src}Extract claim candidates from the following capture. Return a JSON array only.\n\n---\n${transcript}\n---`;
}

/** Pull the first JSON value (array or object) out of a model reply (handles ```json fences). */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced?.[1] ?? text;
  // Prefer an array; fall back to the first object.
  const a = body.indexOf('[');
  const o = body.indexOf('{');
  let start: number;
  let end: number;
  if (a !== -1 && (o === -1 || a < o)) {
    start = a;
    end = body.lastIndexOf(']');
  } else {
    start = o;
    end = body.lastIndexOf('}');
  }
  if (start === -1 || end === -1 || end < start) throw new Error('No JSON found in lowering response');
  return JSON.parse(body.slice(start, end + 1));
}

/**
 * Parse + validate the lowering output into candidate proposals. Accepts a bare
 * array or an object with a `candidates` array. Throws (ZodError) on a malformed
 * candidate — a lowering pass that can't produce well-formed candidates is rejected.
 */
export function parseLoweringResponse(text: string): LoweringCandidateProposal[] {
  const raw = extractJson(text);
  const arr = Array.isArray(raw)
    ? raw
    : (raw && typeof raw === 'object' && Array.isArray((raw as Record<string, unknown>).candidates))
      ? ((raw as Record<string, unknown>).candidates as unknown[])
      : [];
  return z.array(loweringCandidateSchema).max(MAX_CANDIDATES).parse(arr);
}
