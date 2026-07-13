import { describe, it, expect } from 'vitest'
import { specificationPackageBodySchema } from '../src/modules/specifications/specification.schemas'
import { specificationContentHash } from '../src/modules/specifications/specification.hash'
import { validateSpecificationBody } from '../src/modules/specifications/specification.validator'

const body = (over: Record<string, unknown> = {}) => specificationPackageBodySchema.parse(over)

describe('specificationContentHash', () => {
  it('is sha256-prefixed and order-independent over the meaningful content', () => {
    const a = body({ summary: 'x', requirements: [{ id: 'REQ-1', statement: 'do a thing', sourceIds: ['S1'] }] })
    const b = body({ requirements: [{ id: 'REQ-1', statement: 'do a thing', sourceIds: ['S1'] }], summary: 'x' })
    const ha = specificationContentHash(a)
    expect(ha).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(ha).toBe(specificationContentHash(b))
  })
  it('changes when content changes', () => {
    expect(specificationContentHash(body({ summary: 'x' }))).not.toBe(specificationContentHash(body({ summary: 'y' })))
  })
})

describe('validateSpecificationBody', () => {
  it('passes a well-formed spec (MUST has AC; refs resolve; sources + tests present)', () => {
    const spec = body({
      requirements: [{ id: 'REQ-1', priority: 'MUST', statement: 's', sourceIds: ['S1'], acceptanceCriterionIds: ['AC-1'], testObligationIds: ['T-1'] }],
      acceptanceCriteria: [{ id: 'AC-1', requirementIds: ['REQ-1'] }],
      testObligations: [{ id: 'T-1', verifies: ['REQ-1'] }],
      sources: [{ id: 'S1' }],
    })
    const result = validateSpecificationBody(spec)
    expect(result.passed).toBe(true)
    expect(result.errorCount).toBe(0)
  })

  it('blocks a MUST requirement with no acceptance criteria', () => {
    const result = validateSpecificationBody(body({ requirements: [{ id: 'REQ-1', priority: 'MUST', statement: 's', sourceIds: ['S1'] }], sources: [{ id: 'S1' }] }))
    expect(result.passed).toBe(false)
    expect(result.checks.find((c) => c.id === 'must-has-acceptance')?.passed).toBe(false)
  })

  it('blocks duplicate requirement ids and acceptance criteria referencing unknown requirements', () => {
    const dup = validateSpecificationBody(body({ requirements: [{ id: 'REQ-1', statement: 'a' }, { id: 'REQ-1', statement: 'b' }] }))
    expect(dup.checks.find((c) => c.id === 'requirement-ids-unique')?.passed).toBe(false)
    expect(dup.passed).toBe(false)

    const badRef = validateSpecificationBody(body({ acceptanceCriteria: [{ id: 'AC-1', requirementIds: ['REQ-NOPE'] }] }))
    expect(badRef.checks.find((c) => c.id === 'acceptance-references-valid')?.passed).toBe(false)
    expect(badRef.passed).toBe(false)
  })

  it('warns but does not block a requirement lacking a test obligation or source', () => {
    const result = validateSpecificationBody(body({ requirements: [{ id: 'REQ-1', priority: 'SHOULD', statement: 's' }] }))
    expect(result.passed).toBe(true)
    expect(result.warningCount).toBeGreaterThan(0)
    expect(result.checks.find((c) => c.id === 'requirement-has-test-obligation')?.passed).toBe(false)
    expect(result.checks.find((c) => c.id === 'requirement-has-source')?.passed).toBe(false)
  })
})
