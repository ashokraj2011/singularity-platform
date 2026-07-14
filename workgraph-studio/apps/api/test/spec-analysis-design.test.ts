import { describe, it, expect } from 'vitest'
import { specificationPackageBodySchema, emptySpecificationPackageBody } from '../src/modules/specifications/specification.schemas'

describe('spec package — analysis + design sections', () => {
  it('defaults analysis to an empty structure and decisions to []', () => {
    const b = emptySpecificationPackageBody()
    expect(b.analysis).toEqual({ problem: '', goals: [], stakeholders: [], assumptions: [], constraints: [] })
    expect(b.decisions).toEqual([])
  })

  it('round-trips analysis (problem/goals/stakeholders) and decisions (ADRs)', () => {
    const parsed = specificationPackageBodySchema.parse({
      analysis: { problem: 'Telemetry is inconsistent', goals: ['One canonical schema'], stakeholders: [{ role: 'Product Owner', name: 'A. Raj' }], assumptions: ['UTC only'], constraints: ['40k msg/s'] },
      decisions: [{ id: 'ADR-1', title: 'Quarantine malformed frames', status: 'ACCEPTED', decision: 'Drop + reason code', alternatives: ['reject batch'] }],
    })
    expect(parsed.analysis.problem).toContain('Telemetry')
    expect(parsed.analysis.stakeholders[0]).toMatchObject({ role: 'Product Owner' })
    expect(parsed.decisions[0]).toMatchObject({ id: 'ADR-1', status: 'ACCEPTED' })
  })

  it('coerces an unknown decision status to PROPOSED', () => {
    const parsed = specificationPackageBodySchema.parse({ decisions: [{ id: 'ADR-9', status: 'NONSENSE' }] })
    expect(parsed.decisions[0].status).toBe('PROPOSED')
  })
})
