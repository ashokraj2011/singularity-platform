import { describe, it, expect } from 'vitest'
import { parseAgentResponse, applyProposal, buildConverseTask } from '../src/modules/specifications/spec-agent'
import { emptySpecificationPackageBody } from '../src/modules/specifications/specification.schemas'

describe('parseAgentResponse', () => {
  it('reads reply + valid proposals from JSON (fenced or plain), dropping malformed ones', () => {
    const r = parseAgentResponse('```json\n{"reply":"Added a requirement.","proposals":[{"kind":"requirement","data":{"id":"REQ-9","statement":"x"}},{"kind":"bogus","data":{}}]}\n```')
    expect(r.reply).toBe('Added a requirement.')
    expect(r.proposals).toHaveLength(1)
    expect(r.proposals[0]).toMatchObject({ kind: 'requirement' })
  })
  it('treats non-JSON as a plain reply with no proposals', () => {
    const r = parseAgentResponse('Sure — what should REQ-3 verify?')
    expect(r.reply).toContain('REQ-3')
    expect(r.proposals).toEqual([])
  })
})

describe('applyProposal', () => {
  it('appends to the right section, and replaces by id', () => {
    const body = emptySpecificationPackageBody()
    const add = applyProposal(body, { kind: 'requirement', data: { id: 'REQ-1', statement: 'a' } })
    expect(add.requirements).toHaveLength(1)

    const withOne = { ...body, requirements: [{ id: 'REQ-1', statement: 'a' } as any] }
    const replace = applyProposal(withOne as any, { kind: 'requirement', data: { id: 'REQ-1', statement: 'b' } })
    expect(replace.requirements).toHaveLength(1)
    expect((replace.requirements as any)[0].statement).toBe('b')

    const ac = applyProposal(body, { kind: 'acceptance', data: { id: 'AC-1', requirementIds: ['REQ-1'] } })
    expect(ac.acceptanceCriteria).toHaveLength(1)
    const t = applyProposal(body, { kind: 'test', data: { id: 'T-1', verifies: ['REQ-1'] } })
    expect(t.testObligations).toHaveLength(1)
  })
})

describe('buildConverseTask', () => {
  it('includes the conversation and current-spec context', () => {
    const task = buildConverseTask([{ role: 'user', content: 'add backpressure req' }], { summary: 'Normalizer', requirements: [{ id: 'REQ-1', priority: 'MUST', statement: 'coerce' }] })
    expect(task).toContain('add backpressure req')
    expect(task).toContain('REQ-1')
    expect(task).toContain('Normalizer')
  })
})
