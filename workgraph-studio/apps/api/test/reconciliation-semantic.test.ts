import { describe, it, expect } from 'vitest'
import {
  applySemanticJudgments,
  parseSemanticJudgments,
  buildSemanticTask,
  type SemanticVerdict,
} from '../src/modules/reconciliations/reconciliation.semantic'
import { runSemanticPass, type SemanticLlm } from '../src/modules/reconciliations/reconciliation.semantic.service'

const verdicts = (): SemanticVerdict[] => [
  { requirementId: 'REQ-1', priority: 'MUST', verdict: 'PASS', claimStatus: 'IMPLEMENTED', rationale: 'declared', evidence: [] },
  { requirementId: 'REQ-2', priority: 'SHOULD', verdict: 'PARTIAL', claimStatus: 'PARTIAL', rationale: 'declared', evidence: [] },
  { requirementId: 'REQ-3', priority: 'MUST', verdict: 'FAIL', claimStatus: null, rationale: 'unclaimed', evidence: [] },
]

describe('applySemanticJudgments', () => {
  it('drops a requirement to FAIL when the judge says NOT_SATISFIED', () => {
    const r = applySemanticJudgments(verdicts(), [{ requirementId: 'REQ-1', judgment: 'NOT_SATISFIED', rationale: 'missing the core behavior' }])
    const v1 = r.verdicts.find((v) => v.requirementId === 'REQ-1')!
    expect(v1.verdict).toBe('FAIL')
    expect(v1.rationale).toContain('Semantic review')
    expect(r.status).toBe('FAILED')
  })

  it('lifts a PARTIAL to PASS on SATISFIED and caps a PASS at PARTIAL on PARTIAL', () => {
    const r = applySemanticJudgments(verdicts(), [
      { requirementId: 'REQ-2', judgment: 'SATISFIED' },
      { requirementId: 'REQ-1', judgment: 'PARTIAL' },
    ])
    expect(r.verdicts.find((v) => v.requirementId === 'REQ-2')!.verdict).toBe('PASS')
    expect(r.verdicts.find((v) => v.requirementId === 'REQ-1')!.verdict).toBe('PARTIAL')
    expect(r.summary.assessed).toBe(2)
  })

  it('never overturns a structural FAIL, and keeps the verdict on UNCLEAR', () => {
    const r = applySemanticJudgments(verdicts(), [
      { requirementId: 'REQ-3', judgment: 'SATISFIED' }, // unclaimed FAIL — must not flip to PASS
      { requirementId: 'REQ-1', judgment: 'UNCLEAR' },
    ])
    expect(r.verdicts.find((v) => v.requirementId === 'REQ-3')!.verdict).toBe('FAIL')
    expect(r.verdicts.find((v) => v.requirementId === 'REQ-1')!.verdict).toBe('PASS') // unchanged
  })
})

describe('parseSemanticJudgments', () => {
  it('reads a plain array, a fenced array, and an object wrapper; filters invalid entries', () => {
    expect(parseSemanticJudgments('[{"requirementId":"REQ-1","judgment":"SATISFIED"}]')).toHaveLength(1)
    expect(parseSemanticJudgments('```json\n[{"requirementId":"REQ-1","judgment":"satisfied"}]\n```')[0].judgment).toBe('SATISFIED')
    expect(parseSemanticJudgments('{"judgments":[{"requirementId":"REQ-1","judgment":"PARTIAL"}]}')).toHaveLength(1)
    expect(parseSemanticJudgments('[{"requirementId":"REQ-1","judgment":"NONSENSE"},{"judgment":"SATISFIED"}]')).toHaveLength(0)
  })
  it('returns [] on garbage', () => {
    expect(parseSemanticJudgments('sorry, cannot')).toEqual([])
  })
})

describe('buildSemanticTask', () => {
  it('includes each requirement, its acceptance criteria, and the claim', () => {
    const task = buildSemanticTask(
      [{ id: 'REQ-1', priority: 'MUST', statement: 'do the thing', acceptanceCriteria: ['it works'] }],
      [{ requirementId: 'REQ-1', status: 'IMPLEMENTED', evidence: [{ kind: 'TEST', ref: 'suite#1' }] }],
    )
    expect(task).toContain('REQ-1')
    expect(task).toContain('do the thing')
    expect(task).toContain('it works')
    expect(task).toContain('TEST:suite#1')
  })
})

describe('runSemanticPass', () => {
  const ctx = {
    workItemId: 'wi-1',
    actorId: 'user-1',
    requirements: [{ id: 'REQ-1', priority: 'MUST', statement: 's', acceptanceCriteria: [] }],
    claims: [{ requirementId: 'REQ-1', status: 'IMPLEMENTED', evidence: [] }],
    verdicts: verdicts(),
  }
  const fake = (text: string): SemanticLlm => ({ async complete() { return text } })

  it('applies judgments when the model responds', async () => {
    const r = await runSemanticPass(ctx, fake('[{"requirementId":"REQ-1","judgment":"NOT_SATISFIED"}]'))
    expect(r?.verdicts.find((v) => v.requirementId === 'REQ-1')!.verdict).toBe('FAIL')
  })

  it('returns null (best-effort) on an LLM error or empty judgments', async () => {
    const throwing: SemanticLlm = { async complete() { throw new Error('llm down') } }
    expect(await runSemanticPass(ctx, throwing)).toBeNull()
    expect(await runSemanticPass(ctx, fake('no json here'))).toBeNull()
  })
})
