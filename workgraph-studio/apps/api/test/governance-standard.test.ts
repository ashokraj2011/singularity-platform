import { describe, it, expect } from 'vitest'
import { parseStandardVerdict } from '../src/modules/workflow/runtime/executors/governance/evalStandard'

describe('parseStandardVerdict (LLM STANDARD_CONFORMANCE judge reply)', () => {
  it('parses a clean JSON verdict', () => {
    expect(parseStandardVerdict('{"conformant": true, "findings": []}')).toEqual({ conformant: true, findings: [] })
  })
  it('parses JSON embedded in surrounding prose', () => {
    const raw = 'Here is my assessment:\n{"conformant": false, "findings": ["missing rollback section"]}\nThanks.'
    expect(parseStandardVerdict(raw)).toEqual({ conformant: false, findings: ['missing rollback section'] })
  })
  it('treats non-true conformant as false and coerces findings to strings', () => {
    expect(parseStandardVerdict('{"conformant": "yes", "findings": [1, 2]}')).toEqual({ conformant: false, findings: ['1', '2'] })
  })
  it('fails closed (non-conformant) on unparseable output', () => {
    const v = parseStandardVerdict('the document looks fine to me')
    expect(v.conformant).toBe(false)
    expect(v.findings.length).toBeGreaterThan(0)
  })
})
