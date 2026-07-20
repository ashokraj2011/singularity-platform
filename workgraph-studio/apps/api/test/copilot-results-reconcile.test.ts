import { describe, it, expect, vi, beforeEach } from 'vitest'

// The orchestrator's collaborators all reach for Postgres. Mock them at the module boundary so
// the loop's decision-making — what gets registered, and what happens when it cannot be — is
// testable without a database. The pure planner and the engine below run for real.
const loadCopilotExportSpecification = vi.fn()
const registerSubmission = vi.fn()
const startReconciliation = vi.fn()

vi.mock('../src/modules/workflow/runtime/copilot-export-spec', () => ({
  loadCopilotExportSpecification: (...args: unknown[]) => loadCopilotExportSpecification(...args),
}))
vi.mock('../src/modules/submissions/submissions.service', () => ({
  registerSubmission: (...args: unknown[]) => registerSubmission(...args),
}))
vi.mock('../src/modules/reconciliations/reconciliations.service', () => ({
  startReconciliation: (...args: unknown[]) => startReconciliation(...args),
}))

import {
  planCopilotSubmission,
  reconcileCopilotResults,
  repositoryIdentity,
} from '../src/modules/workflow/runtime/copilot-results-reconcile'
import { reconcile } from '../src/modules/reconciliations/reconciliation.engine'

const SPEC = { contentHash: 'sha256:approved', versionId: 'spec-v1', scopeDeclared: true }
const HANDOFF = {
  workItemId: 'wi-1',
  developmentScopeId: 'scope-1',
  handoffGenerationId: 'handoff-1',
  repository: 'org/repo',
  baseCommitSha: 'base1234567',
  targetPublished: true,
  path: 'scoped' as const,
}

const results = (over: Record<string, unknown> = {}) => ({
  source: 'copilot-cli-export',
  status: 'completed',
  git: { branch: 'wi/ABC-1', commitSha: 'head7654321', changedFiles: ['src/a.ts', 'src/a.test.ts'] },
  stages: [],
  artifacts: [],
  ...over,
})

beforeEach(() => {
  loadCopilotExportSpecification.mockReset()
  registerSubmission.mockReset()
  startReconciliation.mockReset()
  loadCopilotExportSpecification.mockResolvedValue({ specification: SPEC, handoffRef: HANDOFF, warnings: [] })
  registerSubmission.mockResolvedValue({
    submission: { id: 'sub-1', status: 'RECEIVED' },
    validation: { passed: true, errorCount: 0, warningCount: 0, checks: [] },
    alreadyRegistered: false,
  })
  startReconciliation.mockResolvedValue({ run: { id: 'run-1', status: 'DECLARED_CONSISTENT' } })
})

describe('repositoryIdentity', () => {
  it('treats every spelling of the same repository as the same repository', () => {
    const forms = ['org/repo', 'https://github.com/org/repo', 'https://github.com/org/repo.git', 'git@github.com:org/repo.git', 'HTTPS://GitHub.com/Org/Repo/']
    for (const form of forms) expect(repositoryIdentity(form)).toBe('org/repo')
  })

  it('still tells genuinely different repositories apart', () => {
    expect(repositoryIdentity('org/repo')).not.toBe(repositoryIdentity('org/other'))
    expect(repositoryIdentity('https://github.com/org/repo')).not.toBe(repositoryIdentity('https://github.com/other/repo'))
  })
})

describe('planCopilotSubmission', () => {
  it('carries the reported diff and head commit into the manifest', () => {
    const plan = planCopilotSubmission({ payload: results(), specification: SPEC, handoff: HANDOFF })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.manifest.headCommit).toBe('head7654321')
    expect(plan.manifest.specificationHash).toBe('sha256:approved')
    expect((plan.manifest as Record<string, unknown>).changedFiles).toEqual(['src/a.ts', 'src/a.test.ts'])
    expect(plan.manifest.source).toBe('API')
  })

  it('unions the diff across git.changedFiles, legacy git.status and per-stage changedFiles', () => {
    const plan = planCopilotSubmission({
      payload: results({
        git: { commitSha: 'head7654321', changedFiles: ['a.ts'], status: ['b.ts'] },
        stages: [{ changedFiles: ['c.ts', 'a.ts'] }],
      }),
      specification: SPEC,
      handoff: HANDOFF,
    })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect((plan.manifest as Record<string, unknown>).changedFiles).toEqual(['a.ts', 'b.ts', 'c.ts'])
  })

  it('claims nothing — a git push does not say which requirements were satisfied', () => {
    const plan = planCopilotSubmission({ payload: results(), specification: SPEC, handoff: HANDOFF })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.manifest.claims).toEqual([])
    expect(plan.manifest.deviations).toEqual([])
  })

  it('refuses to plan a submission with no commit sha', () => {
    const plan = planCopilotSubmission({ payload: results({ git: { branch: 'x' } }), specification: SPEC, handoff: HANDOFF })
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.reason).toMatch(/no commit sha/i)
  })

  it('refuses to plan when the bound specification has no content hash', () => {
    const plan = planCopilotSubmission({ payload: results(), specification: { contentHash: null }, handoff: HANDOFF })
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.reason).toMatch(/content hash/i)
  })

  it('discloses the assumption when no base commit was reported', () => {
    const plan = planCopilotSubmission({
      payload: results({ git: { commitSha: 'head7654321', changedFiles: ['a.ts'] } }),
      specification: SPEC,
      handoff: HANDOFF,
    })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.manifest.baseCommit).toBe('base1234567')
    expect(plan.notes.join(' ')).toMatch(/no base commit/i)
  })

  it('does not treat a differently-spelled repository as a mismatch', () => {
    const plan = planCopilotSubmission({
      payload: results(),
      specification: SPEC,
      handoff: HANDOFF,
      runRepository: 'https://github.com/org/repo.git',
    })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.manifest.repository).toBe('org/repo')
    expect(plan.notes.join(' ')).not.toMatch(/handoff targets/i)
  })

  it('passes a genuinely different repository through so the validator can reject it', () => {
    const plan = planCopilotSubmission({
      payload: results(),
      specification: SPEC,
      handoff: HANDOFF,
      runRepository: 'org/somewhere-else',
    })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.manifest.repository).toBe('org/somewhere-else')
    expect(plan.notes.join(' ')).toMatch(/handoff targets/i)
  })
})

describe('reconcileCopilotResults', () => {
  it('registers a submission and starts a reconciliation when results carry a diff', async () => {
    const outcome = await reconcileCopilotResults({ payload: results(), workCode: 'ABC-1', actorId: 'user-1' })

    expect(outcome.status).toBe('RECONCILED')
    expect(outcome.reconciliationRunId).toBe('run-1')
    expect(outcome.submissionId).toBe('sub-1')

    // Registered through the real submission path (scoped), not by writing rows directly.
    expect(registerSubmission).toHaveBeenCalledTimes(1)
    const [workItemId, manifest, actorId, scopedContext] = registerSubmission.mock.calls[0]
    expect(workItemId).toBe('wi-1')
    expect(actorId).toBe('user-1')
    expect(scopedContext).toEqual({ developmentScopeId: 'scope-1', handoffGenerationId: 'handoff-1' })
    expect((manifest as Record<string, unknown>).changedFiles).toEqual(['src/a.ts', 'src/a.test.ts'])

    // And the automated path always demands a change manifest.
    expect(startReconciliation).toHaveBeenCalledWith('wi-1', 'sub-1', 'user-1', 'DETERMINISTIC', { requireChangeManifest: true })
  })

  it('uses the legacy DevelopmentTarget path when there is no scope + published generation', async () => {
    loadCopilotExportSpecification.mockResolvedValue({
      specification: SPEC,
      handoffRef: { ...HANDOFF, developmentScopeId: null, handoffGenerationId: null, path: 'legacy' as const },
      warnings: [],
    })
    const outcome = await reconcileCopilotResults({ payload: results(), workCode: 'ABC-1', actorId: 'user-1' })
    expect(outcome.status).toBe('RECONCILED')
    expect(registerSubmission.mock.calls[0][3]).toBeUndefined()
  })

  it('reports the failed identity checks verbatim when the spec hash does not match', async () => {
    registerSubmission.mockResolvedValue({
      submission: { id: 'sub-2', status: 'REJECTED' },
      validation: {
        passed: false,
        errorCount: 1,
        warningCount: 0,
        checks: [
          { id: 'spec-hash-matches', passed: false, severity: 'error', message: 'Submission hash (sha256:stale) does not match the approved specification hash (sha256:approved)' },
          { id: 'repository-matches', passed: true, severity: 'error', message: 'Submission repository matches the handoff' },
        ],
      },
      alreadyRegistered: false,
    })

    const outcome = await reconcileCopilotResults({ payload: results(), workCode: 'ABC-1', actorId: 'user-1' })

    expect(outcome.status).toBe('NOT_VERIFIED')
    expect(outcome.submissionStatus).toBe('REJECTED')
    expect(outcome.failedChecks).toEqual([
      { id: 'spec-hash-matches', message: 'Submission hash (sha256:stale) does not match the approved specification hash (sha256:approved)' },
    ])
    // A rejected submission cannot be reconciled — do not ask.
    expect(startReconciliation).not.toHaveBeenCalled()
  })

  it('does not duplicate a reconciliation when the same commit is posted twice', async () => {
    registerSubmission.mockResolvedValue({
      submission: { id: 'sub-1', status: 'RECEIVED' },
      validation: { passed: true, errorCount: 0, warningCount: 0, checks: [] },
      alreadyRegistered: true,
    })
    const outcome = await reconcileCopilotResults({ payload: results(), workCode: 'ABC-1', actorId: 'user-1' })
    expect(outcome.status).toBe('ALREADY_REGISTERED')
    expect(startReconciliation).not.toHaveBeenCalled()
  })

  it('is not applicable when the run names no Work Item', async () => {
    const outcome = await reconcileCopilotResults({ payload: results(), workCode: '', actorId: 'user-1' })
    expect(outcome.status).toBe('NOT_APPLICABLE')
    expect(loadCopilotExportSpecification).not.toHaveBeenCalled()
  })

  it('refuses to reconcile against an unpublished legacy handoff', async () => {
    loadCopilotExportSpecification.mockResolvedValue({
      specification: SPEC,
      handoffRef: { ...HANDOFF, developmentScopeId: null, handoffGenerationId: null, path: 'legacy' as const, targetPublished: false },
      warnings: [],
    })
    const outcome = await reconcileCopilotResults({ payload: results(), workCode: 'ABC-1', actorId: 'user-1' })
    expect(outcome.status).toBe('NOT_VERIFIED')
    expect(outcome.reason).toMatch(/not published/i)
    expect(registerSubmission).not.toHaveBeenCalled()
  })

  it('reports rather than throws when the submission path rejects the results', async () => {
    registerSubmission.mockRejectedValue(new Error('The handoff generation is stale'))
    const outcome = await reconcileCopilotResults({ payload: results(), workCode: 'ABC-1', actorId: 'user-1' })
    expect(outcome.status).toBe('NOT_VERIFIED')
    expect(outcome.reason).toMatch(/stale/i)
  })

  it('surfaces an undeclared requirement subset instead of leaving it implicit', async () => {
    loadCopilotExportSpecification.mockResolvedValue({
      specification: { ...SPEC, scopeDeclared: false },
      handoffRef: HANDOFF,
      warnings: [],
    })
    const outcome = await reconcileCopilotResults({ payload: results(), workCode: 'ABC-1', actorId: 'user-1' })
    expect(outcome.status).toBe('RECONCILED')
    expect(outcome.notes?.join(' ')).toMatch(/no requirement subset/i)
  })
})

// The composition that matters: what the planner produces, fed to the real engine on the terms
// the automated path uses. This is the "empty diff must never read as clean" guarantee end to end.
describe('an automated run over the real engine', () => {
  const requirements = [
    { id: 'REQ-1', priority: 'MUST', testObligationIds: [] },
    { id: 'REQ-2', priority: 'SHOULD', testObligationIds: [] },
  ]

  const engineInputFor = (payload: Record<string, unknown>) => {
    const plan = planCopilotSubmission({ payload, specification: SPEC, handoff: HANDOFF })
    if (!plan.ok) throw new Error(`expected a plan, got: ${plan.reason}`)
    return {
      requirements,
      scopeRequirementIds: ['REQ-1', 'REQ-2'],
      requiredEvidence: [],
      diffValidation: { forbiddenPaths: ['infra/*'] },
      claims: plan.manifest.claims,
      deviations: plan.manifest.deviations,
      // What changedFilesOf reads back off the stored manifest.
      changedFiles: (plan.manifest as unknown as { changedFiles: string[] }).changedFiles,
      requireChangeManifest: true,
    }
  }

  it('returns NOT_VERIFIED — never PASSED — when the run changed nothing', () => {
    const r = reconcile(engineInputFor(results({ git: { commitSha: 'head7654321', changedFiles: [] } })))
    expect(r.status).toBe('NOT_VERIFIED')
    expect(r.status).not.toBe('PASSED')
    expect(r.summary.unproven).toBe(true)
    expect(r.findings.some((f) => f.kind === 'no-change-manifest' && f.severity === 'ERROR')).toBe(true)
  })

  it('returns NOT_VERIFIED with a diff too, because a push asserts no requirement claims', () => {
    const r = reconcile(engineInputFor(results()))
    expect(r.status).toBe('NOT_VERIFIED')
    expect(r.verdicts.every((v) => v.verdict === 'NOT_VERIFIED')).toBe(true)
    expect(r.summary.fail).toBe(0) // unassessed, not refuted
    expect(r.findings.some((f) => f.kind === 'no-claims-submitted')).toBe(true)
  })

  it('still FAILS for real when the pushed diff breaks the handoff path policy', () => {
    const r = reconcile(engineInputFor(results({ git: { commitSha: 'head7654321', changedFiles: ['infra/prod.tf'] } })))
    expect(r.status).toBe('FAILED')
    expect(r.summary.policyBreach).toBe(true)
  })
})
