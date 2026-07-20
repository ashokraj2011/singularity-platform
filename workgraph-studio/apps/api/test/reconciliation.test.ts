import { describe, it, expect } from 'vitest'
import { reconcile, type ReconciliationInput } from '../src/modules/reconciliations/reconciliation.engine'

const base = (over: Partial<ReconciliationInput> = {}): ReconciliationInput => ({
  requirements: [
    { id: 'REQ-1', priority: 'MUST', testObligationIds: ['T-1'] },
    { id: 'REQ-2', priority: 'SHOULD', testObligationIds: [] },
  ],
  scopeRequirementIds: ['REQ-1', 'REQ-2'],
  requiredEvidence: [{ requirementId: 'REQ-1', kind: 'FILE' }],
  diffValidation: {},
  claims: [
    { requirementId: 'REQ-1', status: 'IMPLEMENTED', evidence: [{ kind: 'FILE', ref: 'src/a.ts' }, { kind: 'TEST', ref: 'src/a.test.ts' }] },
    { requirementId: 'REQ-2', status: 'IMPLEMENTED', evidence: [{ kind: 'FILE', ref: 'src/b.ts' }] },
  ],
  deviations: [],
  changedFiles: ['src/a.ts', 'src/a.test.ts', 'src/b.ts'],
  ...over,
})

describe('reconcile — deterministic engine', () => {
  it('PASSES when every in-scope requirement is implemented with its required evidence + tests', () => {
    const r = reconcile(base())
    expect(r.status).toBe('PASSED')
    expect(r.summary.pass).toBe(2)
    expect(r.verdicts.every((v) => v.verdict === 'PASS')).toBe(true)
  })

  it('downgrades an IMPLEMENTED claim to PARTIAL when required evidence is missing', () => {
    const r = reconcile(base({
      claims: [
        { requirementId: 'REQ-1', status: 'IMPLEMENTED', evidence: [{ kind: 'TEST', ref: 'src/a.test.ts' }] }, // no FILE
        { requirementId: 'REQ-2', status: 'IMPLEMENTED', evidence: [{ kind: 'FILE', ref: 'src/b.ts' }] },
      ],
    }))
    const v1 = r.verdicts.find((v) => v.requirementId === 'REQ-1')!
    expect(v1.verdict).toBe('PARTIAL')
    expect(r.status).toBe('PARTIAL')
    expect(r.findings.some((f) => f.kind === 'missing-evidence')).toBe(true)
  })

  it('FAILS the run when a MUST requirement is unclaimed', () => {
    const r = reconcile(base({
      claims: [{ requirementId: 'REQ-2', status: 'IMPLEMENTED', evidence: [{ kind: 'FILE', ref: 'src/b.ts' }] }],
    }))
    const v1 = r.verdicts.find((v) => v.requirementId === 'REQ-1')!
    expect(v1.verdict).toBe('FAIL')
    expect(r.status).toBe('FAILED')
    expect(r.findings.some((f) => f.kind === 'unclaimed-requirement')).toBe(true)
  })

  it('treats SKIPPED as NOT_APPLICABLE only when a deviation covers it', () => {
    const withDev = reconcile(base({
      claims: [
        { requirementId: 'REQ-1', status: 'IMPLEMENTED', evidence: [{ kind: 'FILE', ref: 'a' }, { kind: 'TEST', ref: 't' }] },
        { requirementId: 'REQ-2', status: 'SKIPPED', evidence: [] },
      ],
      deviations: [{ requirementId: 'REQ-2', kind: 'SCOPE', description: 'descoped' }],
    }))
    expect(withDev.verdicts.find((v) => v.requirementId === 'REQ-2')!.verdict).toBe('NOT_APPLICABLE')

    const noDev = reconcile(base({
      claims: [
        { requirementId: 'REQ-1', status: 'IMPLEMENTED', evidence: [{ kind: 'FILE', ref: 'a' }, { kind: 'TEST', ref: 't' }] },
        { requirementId: 'REQ-2', status: 'SKIPPED', evidence: [] },
      ],
    }))
    expect(noDev.verdicts.find((v) => v.requirementId === 'REQ-2')!.verdict).toBe('FAIL')
  })

  it('FAILS on a forbidden-path policy breach even when claims look complete', () => {
    const r = reconcile(base({
      diffValidation: { forbiddenPaths: ['infra/*'] },
      changedFiles: ['src/a.ts', 'src/a.test.ts', 'src/b.ts', 'infra/prod.tf'],
    }))
    expect(r.summary.policyBreach).toBe(true)
    expect(r.status).toBe('FAILED')
    expect(r.findings.some((f) => f.kind === 'forbidden-path' && f.severity === 'ERROR')).toBe(true)
  })

  it('flags missing tests via the reused DIFF_VS_DESIGN evaluator when requireTests is set', () => {
    const r = reconcile(base({
      diffValidation: { requireTests: true },
      changedFiles: ['src/a.ts', 'src/b.ts'], // no test file
    }))
    expect(r.status).toBe('FAILED')
    expect(r.findings.some((f) => f.kind === 'missing-tests')).toBe(true)
  })

  it('only evaluates in-scope requirements', () => {
    const r = reconcile(base({ scopeRequirementIds: ['REQ-1'] }))
    expect(r.verdicts).toHaveLength(1)
    expect(r.verdicts[0].requirementId).toBe('REQ-1')
  })
})

// An automated reconciliation runs on a git event, not on a person asserting they did the work.
// Nothing about that path may let an unproven run read as a clean one.
describe('reconcile — fail safe when nothing was actually measured', () => {
  it('keeps the empty change manifest a WARNING for a human submission (unchanged behaviour)', () => {
    const r = reconcile(base({ diffValidation: { requireTests: true }, changedFiles: [] }))
    const finding = r.findings.find((f) => f.kind === 'no-change-manifest')
    expect(finding?.severity).toBe('WARNING')
    expect(r.summary.unproven).toBe(false)
    expect(r.status).toBe('PASSED')
  })

  it('makes an empty change manifest an ERROR and NOT_VERIFIED when the caller requires one', () => {
    const r = reconcile(base({ requireChangeManifest: true, changedFiles: [] }))
    const finding = r.findings.find((f) => f.kind === 'no-change-manifest')
    expect(finding?.severity).toBe('ERROR')
    expect(r.summary.unproven).toBe(true)
    expect(r.status).toBe('NOT_VERIFIED')
    expect(r.status).not.toBe('PASSED')
  })

  it('requires the change manifest even when no path policy is configured', () => {
    // The pre-existing check only looked at changedFiles when a policy existed, so a run with no
    // policy AND no diff sailed through clean.
    const r = reconcile(base({ requireChangeManifest: true, diffValidation: {}, changedFiles: [] }))
    expect(r.status).toBe('NOT_VERIFIED')
    expect(r.findings.some((f) => f.kind === 'no-change-manifest' && f.severity === 'ERROR')).toBe(true)
  })

  it('reads zero claims as unassessed (NOT_VERIFIED), not as a wall of refuted requirements', () => {
    const r = reconcile(base({ claims: [], changedFiles: ['src/a.ts'] }))
    expect(r.verdicts).toHaveLength(2)
    expect(r.verdicts.every((v) => v.verdict === 'NOT_VERIFIED')).toBe(true)
    expect(r.summary.notVerified).toBe(2)
    expect(r.summary.fail).toBe(0)
    expect(r.status).toBe('NOT_VERIFIED')
    // One legible run-level finding rather than one ERROR per requirement.
    expect(r.findings.filter((f) => f.kind === 'unclaimed-requirement')).toHaveLength(0)
    expect(r.findings.filter((f) => f.kind === 'no-claims-submitted')).toHaveLength(1)
  })

  it('still FAILS a requirement the submission omitted when it did claim others', () => {
    const r = reconcile(base({
      claims: [{ requirementId: 'REQ-2', status: 'IMPLEMENTED', evidence: [{ kind: 'FILE', ref: 'src/b.ts' }] }],
    }))
    const req1 = r.verdicts.find((v) => v.requirementId === 'REQ-1')!
    expect(req1.verdict).toBe('FAIL')
    expect(r.status).toBe('FAILED')
    expect(r.findings.some((f) => f.kind === 'unclaimed-requirement')).toBe(true)
  })

  it('does not let an empty verdict matrix read as PASSED', () => {
    const r = reconcile(base({ requirements: [], scopeRequirementIds: [], claims: [] }))
    expect(r.verdicts).toHaveLength(0)
    expect(r.status).toBe('NOT_VERIFIED')
    expect(r.summary.unproven).toBe(true)
  })

  it('reports a real breach as FAILED even when the run is also unproven', () => {
    const r = reconcile(base({
      requireChangeManifest: true,
      claims: [],
      diffValidation: { forbiddenPaths: ['infra/*'] },
      changedFiles: ['infra/prod.tf'],
    }))
    expect(r.summary.policyBreach).toBe(true)
    expect(r.status).toBe('FAILED')
  })
})
