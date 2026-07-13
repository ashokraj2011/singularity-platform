import { describe, it, expect } from 'vitest'
import { specificationPackageBodySchema, emptySpecificationPackageBody } from '../src/modules/specifications/specification.schemas'
import { buildPseudocodeTask, parsePseudocode } from '../src/modules/specifications/pseudocode-generation'

describe('spec package — diagrams + pseudocode sections', () => {
  it('defaults both to empty arrays', () => {
    const body = emptySpecificationPackageBody()
    expect(body.diagrams).toEqual([])
    expect(body.pseudocode).toEqual([])
  })

  it('round-trips a diagram (structured nodes/edges) and a pseudocode module without dropping them', () => {
    const parsed = specificationPackageBodySchema.parse({
      diagrams: [{ id: 'D1', title: 'Flow', kind: 'FLOW', nodes: [{ id: 'n1', label: 'Start' }, { id: 'n2', label: 'End' }], edges: [{ id: 'e1', source: 'n1', target: 'n2', label: 'go' }] }],
      pseudocode: [{ id: 'PC1', title: 'core', language: 'python', requirementIds: ['REQ-1'], content: 'def x():\n  pass', generated: true }],
    })
    expect(parsed.diagrams).toHaveLength(1)
    expect(parsed.diagrams[0].nodes).toHaveLength(2)
    expect(parsed.diagrams[0].edges[0]).toMatchObject({ source: 'n1', target: 'n2' })
    expect(parsed.pseudocode[0]).toMatchObject({ language: 'python', generated: true, requirementIds: ['REQ-1'] })
  })

  it('coerces an unknown diagram kind to FLOW', () => {
    const parsed = specificationPackageBodySchema.parse({ diagrams: [{ id: 'D1', kind: 'NONSENSE' }] })
    expect(parsed.diagrams[0].kind).toBe('FLOW')
  })
})

describe('pseudocode generation — pure helpers', () => {
  it('builds a task listing the scoped requirements + language', () => {
    const task = buildPseudocodeTask({ title: 'Auth', language: 'typescript', requirements: [{ id: 'REQ-1', statement: 'sign a link', priority: 'MUST' }] })
    expect(task).toContain('typescript')
    expect(task).toContain('REQ-1')
    expect(task).toContain('sign a link')
  })

  it('extracts the fenced code and language, falling back to raw text', () => {
    const fenced = parsePseudocode('here:\n```python\nprint(1)\n```\ndone', 'pseudocode')
    expect(fenced).toEqual({ language: 'python', content: 'print(1)' })
    const raw = parsePseudocode('no fences, just text', 'pseudocode')
    expect(raw.language).toBe('pseudocode')
    expect(raw.content).toBe('no fences, just text')
  })
})
