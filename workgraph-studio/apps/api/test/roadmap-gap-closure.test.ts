import { describe, expect, it } from 'vitest'
import { evaluatePolicyRules } from '../src/modules/governance/governance-policy.service'
import { calculateCapacityMetrics } from '../src/modules/planning/capacity.service'
import { evaluateRuntimePolicy } from '../src/modules/runtime/runtime-policy.service'
import { calculateVerificationRiskScore } from '../src/modules/verification/verification.service'
import { validateNodeMapping } from '../src/modules/workflow/debug.service'

describe('roadmap gap closure contracts', () => {
  it('keeps advisory governance non-blocking while required and blocking fail closed', () => {
    const rules = [{ key: 'design.approved', evidencePath: 'design.approved' }]
    expect(evaluatePolicyRules('ADVISORY', rules, {}).status).toBe('WARNED')
    expect(evaluatePolicyRules('REQUIRED', rules, {}).status).toBe('BLOCKED')
    expect(evaluatePolicyRules('BLOCKING', rules, { design: { approved: true } }).status).toBe('PASSED')
  })

  it('accepts evidence stamped by an upstream governance stage', () => {
    expect(evaluatePolicyRules('REQUIRED', [{ key: 'TEST_EVIDENCE' }], { _satisfiedEvidence: ['TEST_EVIDENCE'] }).status).toBe('PASSED')
  })

  it('reports incomplete template node mappings before migration', () => {
    expect(validateNodeMapping(['old-a', 'old-b'], ['new-a'], { 'old-a': 'new-a' })).toEqual({ warnings: ['No mapping supplied for old node old-b'], safe: false })
    expect(validateNodeMapping(['old-a'], ['new-a'], { 'old-a': 'new-a' }).safe).toBe(true)
  })

  it('requires consent and allowed paths for runtime actions', () => {
    expect(evaluateRuntimePolicy({ deviceStatus: 'ENROLLED', revoked: false, action: 'read', scope: '/repo/a', allowedPaths: ['/repo'], consentMode: 'PER_ACTION', consentGranted: false })).toMatchObject({ allowed: false, code: 'CONSENT_REQUIRED' })
    expect(evaluateRuntimePolicy({ deviceStatus: 'ENROLLED', revoked: false, action: 'read', scope: '/tmp/a', allowedPaths: ['/repo'], consentMode: 'SESSION', consentGranted: false })).toMatchObject({ allowed: false, code: 'WORKSPACE_PATH_NOT_ALLOWED' })
    expect(evaluateRuntimePolicy({ deviceStatus: 'ENROLLED', revoked: false, action: 'read', scope: '/repo/a', allowedPaths: ['/repo'], consentMode: 'PER_ACTION', consentGranted: true }).allowed).toBe(true)
  })

  it('calculates capacity utilization and critical-path risk', () => {
    expect(calculateCapacityMetrics(16, 8, 0)).toMatchObject({ utilization: 1, predictedCompletionDays: 2, criticalPathRisk: 'MEDIUM' })
    expect(calculateCapacityMetrics(4, 8, 1).criticalPathRisk).toBe('HIGH')
  })

  it('scores independent verification risk from tests, findings, and regression', () => {
    expect(calculateVerificationRiskScore({ tests: { failed: 2 }, changedFiles: ['a.ts'], coverageRegression: true }, [{ severity: 'HIGH' }])).toBe(76)
    expect(calculateVerificationRiskScore({}, [])).toBe(0)
  })
})
