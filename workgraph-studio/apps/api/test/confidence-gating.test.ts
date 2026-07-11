/**
 * Safety tests for confidence-gated autonomy (docs/confidence-gated-autonomy.md).
 *
 * These cover the PURE resolver's fail-closed behaviour. The load-bearing caller
 * invariant — that auto-approve is only reachable when the gate status is
 * APPROVAL_REQUESTED AND blocked.length === 0 (a real governance block can NEVER be
 * auto-approved) — is enforced structurally in GovernanceGateExecutor.ts and should
 * additionally be covered by a gate integration test.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { evaluateConfidenceGating } from '../src/modules/workflow/runtime/executors/governance/confidenceGating'

const KILL = 'GOVERNANCE_CONFIDENCE_GATING_DISABLED'

describe('evaluateConfidenceGating — fail-closed autonomy', () => {
  const orig = process.env[KILL]
  afterEach(() => { if (orig === undefined) delete process.env[KILL]; else process.env[KILL] = orig })

  it('default inert: no config never auto-approves', () => {
    const v = evaluateConfidenceGating({ config: undefined, context: { _verificationPassed: true } })
    expect(v.autoApprove).toBe(false)
    expect(v.shadowWouldApprove).toBe(false)
  })

  it('disabled gate never auto-approves', () => {
    expect(evaluateConfidenceGating({ config: { enabled: false }, context: { _verificationPassed: true } }).autoApprove).toBe(false)
  })

  it('enabled + verify source + verification PASS -> auto-approve', () => {
    expect(evaluateConfidenceGating({ config: { enabled: true, confidenceSource: 'verify' }, context: { _verification: { status: 'PASS' } } }).autoApprove).toBe(true)
  })

  it('verification absent or failed -> deny', () => {
    expect(evaluateConfidenceGating({ config: { enabled: true, confidenceSource: 'verify' }, context: {} }).autoApprove).toBe(false)
    expect(evaluateConfidenceGating({ config: { enabled: true, confidenceSource: 'verify' }, context: { _verification: { status: 'FAIL' } } }).autoApprove).toBe(false)
  })

  it('context source: confidence >= threshold approves, below/absent denies', () => {
    expect(evaluateConfidenceGating({ config: { enabled: true, confidenceSource: 'context', minConfidence: 0.9 }, context: { _confidence: 0.95 } }).autoApprove).toBe(true)
    expect(evaluateConfidenceGating({ config: { enabled: true, confidenceSource: 'context', minConfidence: 0.9 }, context: { _confidence: 0.5 } }).autoApprove).toBe(false)
    expect(evaluateConfidenceGating({ config: { enabled: true, confidenceSource: 'context', minConfidence: 0.9 }, context: {} }).autoApprove).toBe(false)
  })

  it('shadow mode never approves but flags would-approve', () => {
    const v = evaluateConfidenceGating({ config: { enabled: true, confidenceSource: 'verify', shadow: true }, context: { _verification: { status: 'PASS' } } })
    expect(v.autoApprove).toBe(false)
    expect(v.shadowWouldApprove).toBe(true)
  })

  it('maxCriticality: unknown criticality is fail-closed', () => {
    expect(evaluateConfidenceGating({ config: { enabled: true, confidenceSource: 'verify', maxCriticality: 'MEDIUM' }, context: { _verification: { status: 'PASS' } } }).autoApprove).toBe(false)
  })

  it('maxCriticality: above ceiling denies, within approves', () => {
    expect(evaluateConfidenceGating({ config: { enabled: true, confidenceSource: 'verify', maxCriticality: 'MEDIUM' }, context: { _verification: { status: 'PASS' }, _criticality: 'HIGH' } }).autoApprove).toBe(false)
    expect(evaluateConfidenceGating({ config: { enabled: true, confidenceSource: 'verify', maxCriticality: 'HIGH' }, context: { _verification: { status: 'PASS' }, _criticality: 'MEDIUM' } }).autoApprove).toBe(true)
  })

  it('kill-switch env forces deny even when enabled', () => {
    process.env[KILL] = 'true'
    expect(evaluateConfidenceGating({ config: { enabled: true, confidenceSource: 'verify' }, context: { _verification: { status: 'PASS' } } }).autoApprove).toBe(false)
  })

  it('both source requires verification AND confidence', () => {
    expect(evaluateConfidenceGating({ config: { enabled: true, confidenceSource: 'both', minConfidence: 0.9 }, context: { _verification: { status: 'PASS' }, _confidence: 0.95 } }).autoApprove).toBe(true)
    expect(evaluateConfidenceGating({ config: { enabled: true, confidenceSource: 'both', minConfidence: 0.9 }, context: { _verification: { status: 'PASS' }, _confidence: 0.5 } }).autoApprove).toBe(false)
    expect(evaluateConfidenceGating({ config: { enabled: true, confidenceSource: 'both', minConfidence: 0.9 }, context: { _confidence: 0.95 } }).autoApprove).toBe(false)
  })
})
