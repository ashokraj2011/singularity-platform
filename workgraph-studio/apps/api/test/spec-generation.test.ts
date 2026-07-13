import { describe, it, expect } from 'vitest'
import { extractJson, parseGeneratedSpec, buildGenerationTask } from '../src/modules/specifications/spec-generation'
import { generateSpecBody, type SpecGenLlm } from '../src/modules/specifications/spec-generation.service'

const VALID = JSON.stringify({
  summary: 'A thing',
  requirements: [{ id: 'REQ-1', priority: 'MUST', statement: 'do x', sourceIds: ['S1'], acceptanceCriterionIds: ['AC-1'], testObligationIds: ['T-1'] }],
  acceptanceCriteria: [{ id: 'AC-1', requirementIds: ['REQ-1'] }],
  testObligations: [{ id: 'T-1', verifies: ['REQ-1'] }],
  sources: [{ id: 'S1', kind: 'DOCUMENT', label: 'd' }],
})
// MUST requirement with no acceptance criterion → blocks the deterministic validator.
const INVALID = JSON.stringify({ requirements: [{ id: 'REQ-1', priority: 'MUST', statement: 'x', sourceIds: ['S1'] }], sources: [{ id: 'S1' }] })

const fakeLlm = (responses: string[]): SpecGenLlm => {
  let i = 0
  return { async complete() { return responses[Math.min(i++, responses.length - 1)] } }
}
const ctx = { workCode: 'ABC-1', title: 'Thing', description: 'desc' }

describe('extractJson', () => {
  it('reads plain JSON, fenced JSON, and JSON after prose; null on garbage', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 })
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 })
    expect(extractJson('Here you go:\n{"a":1}\nThanks')).toEqual({ a: 1 })
    expect(extractJson('no json here')).toBeNull()
  })
})

describe('parseGeneratedSpec', () => {
  it('parses a well-formed body and tolerates a wrapper key', () => {
    expect(parseGeneratedSpec(VALID).ok).toBe(true)
    expect(parseGeneratedSpec(`{"specification": ${VALID}}`).ok).toBe(true)
  })
  it('fails on non-JSON', () => {
    const r = parseGeneratedSpec('sorry, I cannot')
    expect(r.ok).toBe(false)
  })
})

describe('buildGenerationTask', () => {
  it('includes the work item, the request, and attached documents', () => {
    const task = buildGenerationTask(ctx, 'Build a login', [{ title: 'PRD', content: 'must support SSO' }])
    expect(task).toContain('ABC-1')
    expect(task).toContain('Build a login')
    expect(task).toContain('PRD')
    expect(task).toContain('must support SSO')
  })
})

describe('generateSpecBody', () => {
  it('returns a passing body in one attempt when the model is well-behaved', async () => {
    const r = await generateSpecBody(ctx, { prompt: 'p' }, 'user-1', 'wi-1', fakeLlm([VALID]))
    expect(r.validation.passed).toBe(true)
    expect(r.repaired).toBe(false)
    expect(r.attempts).toBe(1)
  })

  it('runs a repair pass when the first spec has blocking issues', async () => {
    const r = await generateSpecBody(ctx, { prompt: 'p' }, 'user-1', 'wi-1', fakeLlm([INVALID, VALID]))
    expect(r.repaired).toBe(true)
    expect(r.validation.passed).toBe(true)
    expect(r.attempts).toBe(2)
  })

  it('re-asks once on a parse failure, then throws if still unparseable', async () => {
    await expect(generateSpecBody(ctx, { prompt: 'p' }, 'user-1', 'wi-1', fakeLlm(['not json', 'still not json'])))
      .rejects.toThrow(/parseable specification/)
  })
})
