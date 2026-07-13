/**
 * Semantic reconciliation (spec §15, "Layer 3") — the pure pieces. A third verdict source that
 * complements the deterministic (declared evidence + policy) and dynamic (executed tests) layers:
 * an LLM judges, per requirement, whether the submission actually satisfies the requirement's
 * intent. This module builds the judge prompt, parses the model's judgments, and overlays them on
 * the deterministic verdicts. No model call and no I/O here (those live in the service behind an
 * injectable LLM), so prompt-shaping + parsing + overlay are unit-testable.
 *
 * Today the judge reasons over the DECLARED package (requirement + acceptance criteria + the
 * submission's claim/evidence/deviations). Feeding the actual diff/code is a future enhancement
 * (needs a GitHub content fetch); the overlay rules below keep semantic from overturning structural
 * facts the deterministic layer already established.
 */

export type SemanticJudgmentValue = 'SATISFIED' | 'PARTIAL' | 'NOT_SATISFIED' | 'UNCLEAR'

export interface SemanticJudgment {
  requirementId: string
  judgment: SemanticJudgmentValue
  rationale?: string
}

// Mirrors the deterministic EngineVerdict so claimStatus/evidence survive the overlay.
export interface SemanticVerdict {
  requirementId: string
  priority: string
  verdict: string
  claimStatus: string | null
  rationale: string
  evidence: { kind: string; ref: string }[]
}

export interface SemanticRequirement {
  id: string
  priority: string
  statement: string
  acceptanceCriteria: string[]
}

export interface SemanticClaim {
  requirementId: string
  status: string
  evidence: { kind: string; ref: string }[]
  notes?: string
}

export function semanticSystemPrompt(): string {
  return [
    'You are a meticulous code reviewer judging whether an implementation satisfies each requirement.',
    'You are given, per requirement: its statement, its acceptance criteria, and the implementer\'s',
    'claim (status + evidence references + notes). Judge how well the claimed implementation satisfies',
    'the requirement\'s intent.',
    '',
    'Return STRICT JSON only — an array, no prose, no fences:',
    '[{ "requirementId": "REQ-1", "judgment": "SATISFIED|PARTIAL|NOT_SATISFIED|UNCLEAR", "rationale": "one sentence" }]',
    '',
    'Use NOT_SATISFIED when the claim/evidence clearly does not meet the requirement, PARTIAL when it',
    'meets some acceptance criteria, SATISFIED when it plausibly meets all of them, and UNCLEAR when',
    'the evidence is insufficient to judge. Be skeptical: a bare claim with no evidence is UNCLEAR, not',
    'SATISFIED.',
  ].join('\n')
}

export function buildSemanticTask(requirements: SemanticRequirement[], claims: SemanticClaim[]): string {
  const byReq = new Map(claims.map((c) => [c.requirementId, c]))
  const blocks = requirements.map((r) => {
    const claim = byReq.get(r.id)
    const ev = claim?.evidence.length ? claim.evidence.map((e) => `${e.kind}:${e.ref}`).join(', ') : '(none)'
    return [
      `REQUIREMENT ${r.id} [${r.priority}]: ${r.statement}`,
      r.acceptanceCriteria.length ? `  Acceptance: ${r.acceptanceCriteria.join(' | ')}` : '  Acceptance: (none)',
      `  Claim: ${claim ? claim.status : 'NO CLAIM'}; evidence: ${ev}${claim?.notes ? `; notes: ${claim.notes}` : ''}`,
    ].join('\n')
  })
  return ['Judge each requirement:', '', ...blocks, '', 'Return the judgments JSON array now.'].join('\n')
}

/** Extract the judgments array from a model response — tolerate fences, prose, or a wrapper key. */
export function parseSemanticJudgments(text: string): SemanticJudgment[] {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fence ? fence[1] : text
  const arrStart = candidate.indexOf('[')
  const arrEnd = candidate.lastIndexOf(']')
  let raw: unknown = null
  if (arrStart !== -1 && arrEnd > arrStart) {
    try { raw = JSON.parse(candidate.slice(arrStart, arrEnd + 1)) } catch { raw = null }
  }
  if (raw == null) {
    const objStart = candidate.indexOf('{')
    const objEnd = candidate.lastIndexOf('}')
    if (objStart !== -1 && objEnd > objStart) {
      try {
        const obj = JSON.parse(candidate.slice(objStart, objEnd + 1)) as Record<string, unknown>
        raw = obj.judgments ?? obj.results ?? null
      } catch { raw = null }
    }
  }
  if (!Array.isArray(raw)) return []
  const VALID: SemanticJudgmentValue[] = ['SATISFIED', 'PARTIAL', 'NOT_SATISFIED', 'UNCLEAR']
  return raw
    .map((j) => {
      const o = (j && typeof j === 'object' ? j : {}) as Record<string, unknown>
      const judgment = String(o.judgment ?? '').toUpperCase() as SemanticJudgmentValue
      return { requirementId: String(o.requirementId ?? ''), judgment, rationale: o.rationale ? String(o.rationale) : undefined }
    })
    .filter((j) => j.requirementId && VALID.includes(j.judgment))
}

export interface SemanticOverlayResult {
  verdicts: SemanticVerdict[]
  status: 'PASSED' | 'PARTIAL' | 'FAILED'
  summary: { total: number; pass: number; partial: number; fail: number; notApplicable: number; assessed: number }
}

/**
 * Overlay semantic judgments on the deterministic verdicts. NOT_SATISFIED → FAIL; SATISFIED lifts a
 * PASS/PARTIAL to PASS; PARTIAL caps a PASS/PARTIAL at PARTIAL; UNCLEAR (or no judgment) keeps the
 * deterministic verdict. Semantic never overturns a structural FAIL (e.g. unclaimed) or NOT_APPLICABLE.
 */
export function applySemanticJudgments(current: SemanticVerdict[], judgments: SemanticJudgment[]): SemanticOverlayResult {
  const byReq = new Map(judgments.map((j) => [j.requirementId, j]))
  let assessed = 0
  const verdicts: SemanticVerdict[] = current.map((v) => {
    const j = byReq.get(v.requirementId)
    if (!j || j.judgment === 'UNCLEAR') return v
    assessed++
    const why = (fallback: string) => `Semantic review: ${j.rationale ?? fallback}`
    if (j.judgment === 'NOT_SATISFIED') return { ...v, verdict: 'FAIL', rationale: why('requirement not satisfied by the implementation.') }
    if (v.verdict === 'FAIL' || v.verdict === 'NOT_APPLICABLE') return v // don't overturn structural facts
    if (j.judgment === 'PARTIAL') return { ...v, verdict: 'PARTIAL', rationale: why('partially satisfied.') }
    return { ...v, verdict: 'PASS', rationale: why('satisfied by the implementation.') } // SATISFIED
  })

  const count = (val: string) => verdicts.filter((v) => v.verdict === val).length
  const mustFail = verdicts.some((v) => v.priority === 'MUST' && v.verdict === 'FAIL')
  const anyFail = verdicts.some((v) => v.verdict === 'FAIL')
  const anyPartial = verdicts.some((v) => v.verdict === 'PARTIAL')
  const status = mustFail ? 'FAILED' : anyFail || anyPartial ? 'PARTIAL' : 'PASSED'
  return {
    verdicts,
    status,
    summary: { total: verdicts.length, pass: count('PASS'), partial: count('PARTIAL'), fail: count('FAIL'), notApplicable: count('NOT_APPLICABLE'), assessed },
  }
}
