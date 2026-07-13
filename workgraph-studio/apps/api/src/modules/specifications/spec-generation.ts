import { specificationPackageBodySchema, type SpecificationPackageBody } from './specification.schemas'
import type { SpecValidationResult } from './specification.validator'

/**
 * LLM specification authoring — the pure pieces (spec §2, "generate"). Building the prompt, parsing
 * the model's JSON back into a SpecificationPackageBody, and shaping the repair prompt when the
 * deterministic validator finds blocking issues. No I/O and no model call here (those live in the
 * service behind an injectable LLM), so prompt-shaping + parsing are unit-testable.
 */

export interface SpecGenDocument {
  title?: string
  content: string
}

export interface WorkItemContext {
  workCode: string
  title: string
  description?: string | null
}

const MAX_DOCS = 12
const MAX_DOC_CHARS = 8000

export function specGenerationSystemPrompt(): string {
  return [
    'You are a senior specification author. You turn a request and its supporting documents into a',
    'precise, testable software specification for developers.',
    '',
    'Return STRICT JSON only — a single object, no prose, no markdown fences — matching this shape:',
    '{',
    '  "summary": string,',
    '  "requirements": [{ "id": "REQ-1", "priority": "MUST|SHOULD|COULD", "statement": string,',
    '                     "sourceIds": ["S1"], "acceptanceCriterionIds": ["AC-1"], "testObligationIds": ["T-1"] }],',
    '  "acceptanceCriteria": [{ "id": "AC-1", "requirementIds": ["REQ-1"], "statement": string }],',
    '  "testObligations": [{ "id": "T-1", "verifies": ["REQ-1"], "description": string }],',
    '  "sources": [{ "id": "S1", "kind": "DOCUMENT", "label": string }],',
    '  "openQuestions": [{ "id": "Q-1", "question": string, "answered": false }],',
    '  "outOfScope": [string]',
    '}',
    '',
    'Rules: every MUST requirement has at least one acceptance criterion. Ids are unique and',
    'cross-references resolve (a requirement\'s acceptanceCriterionIds/testObligationIds exist; an',
    'acceptance criterion\'s requirementIds exist). Ground each requirement in a source when the',
    'documents support it. Prefer fewer, sharper requirements over many vague ones.',
  ].join('\n')
}

export function buildGenerationTask(ctx: WorkItemContext, prompt: string, documents: SpecGenDocument[] = []): string {
  const docs = documents.slice(0, MAX_DOCS)
  const parts: string[] = [
    `WORK ITEM: ${ctx.workCode} — ${ctx.title}`,
    ctx.description ? `WORK ITEM DESCRIPTION:\n${ctx.description}` : '',
    `\nAUTHOR REQUEST:\n${prompt}`,
  ]
  if (docs.length) {
    parts.push('\nSUPPORTING DOCUMENTS:')
    docs.forEach((d, i) => {
      const label = d.title?.trim() || `Document ${i + 1}`
      parts.push(`--- ${label} ---\n${(d.content ?? '').slice(0, MAX_DOC_CHARS)}`)
    })
  }
  parts.push('\nProduce the specification JSON now.')
  return parts.filter(Boolean).join('\n')
}

/** Pull the JSON object out of a model response — tolerate ```json fences and leading prose. */
export function extractJson(text: string): unknown | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fence ? fence[1] : text
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) return null
  try {
    return JSON.parse(candidate.slice(start, end + 1))
  } catch {
    return null
  }
}

export type ParseResult =
  | { ok: true; body: SpecificationPackageBody }
  | { ok: false; error: string }

export function parseGeneratedSpec(text: string): ParseResult {
  const json = extractJson(text)
  if (json == null) return { ok: false, error: 'No JSON object found in the model response.' }
  const obj = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>
  // Tolerate the model wrapping the body under a key.
  const source = (obj.specification ?? obj.package ?? obj.body ?? obj) as unknown
  const parsed = specificationPackageBodySchema.safeParse(source)
  if (!parsed.success) {
    const detail = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
    return { ok: false, error: detail }
  }
  return { ok: true, body: parsed.data }
}

export function buildRepairTask(originalTask: string, validation: SpecValidationResult): string {
  const problems = validation.checks
    .filter((c) => !c.passed && c.severity === 'error')
    .map((c) => `- ${c.id}: ${c.message}`)
    .join('\n')
  return [
    originalTask,
    '',
    'Your previous specification had these BLOCKING issues:',
    problems,
    '',
    'Return corrected STRICT JSON only, fixing every blocking issue above.',
  ].join('\n')
}
