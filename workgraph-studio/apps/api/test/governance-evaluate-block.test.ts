import { describe, it, expect } from 'vitest'
import { evaluateGovernanceBlock } from '../src/modules/workflow/runtime/executors/governance/evaluateBlock'

// Parity with context-fabric/.../tests/test_governance_gate.py — the GOVERNANCE_GATE
// node must decide identically to CF's in-stage enforcement gate.
describe('evaluateGovernanceBlock', () => {
  it('blocks a REQUIRED required-evidence key that is not satisfied', () => {
    const overlay = { effectiveMode: 'REQUIRED', requiredEvidence: [{ evidenceKey: 'UNIT_TEST' }] }
    const out = evaluateGovernanceBlock(overlay, new Set(), new Set())
    expect(out.map(b => b.controlKey)).toEqual(['UNIT_TEST'])
    expect(out[0].kind).toBe('evidence')
  })

  it('blocks an unsatisfied blockingControl (kind=control, mode=BLOCKING, custom reason)', () => {
    const overlay = { blockingControls: [{ controlKey: 'SEC_REVIEW', reason: 'sec' }] }
    const out = evaluateGovernanceBlock(overlay, new Set(), new Set())
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ controlKey: 'SEC_REVIEW', kind: 'control', mode: 'BLOCKING', reason: 'sec' })
  })

  it('does not block when the key is satisfied', () => {
    const overlay = { effectiveMode: 'BLOCKING', requiredEvidence: [{ evidenceKey: 'REL_NOTES' }] }
    expect(evaluateGovernanceBlock(overlay, new Set(['REL_NOTES']), new Set())).toEqual([])
  })

  it('does not block when the key is waived', () => {
    const overlay = { blockingControls: [{ controlKey: 'SEC_REVIEW' }] }
    expect(evaluateGovernanceBlock(overlay, new Set(), new Set(['SEC_REVIEW']))).toEqual([])
  })

  it('ADVISORY overlay is a no-op for required-evidence without an explicit mode', () => {
    const overlay = { effectiveMode: 'ADVISORY', requiredEvidence: [{ evidenceKey: 'UNIT_TEST' }] }
    expect(evaluateGovernanceBlock(overlay, new Set(), new Set())).toEqual([])
  })

  it('a per-entry REQUIRED mode blocks even when the overlay default is ADVISORY', () => {
    const overlay = { effectiveMode: 'ADVISORY', requiredEvidence: [{ evidenceKey: 'UNIT_TEST', mode: 'REQUIRED' }] }
    expect(evaluateGovernanceBlock(overlay, new Set(), new Set()).map(b => b.controlKey)).toEqual(['UNIT_TEST'])
  })

  it('returns [] for an empty / invalid overlay', () => {
    expect(evaluateGovernanceBlock(null, new Set(), new Set())).toEqual([])
    expect(evaluateGovernanceBlock({}, new Set(), new Set())).toEqual([])
  })
})
