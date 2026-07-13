import { describe, it, expect } from 'vitest'
import { registerSubmissionSchema } from '../src/modules/submissions/submission.schemas'
import { validateSubmissionManifest, type SubmissionValidationContext } from '../src/modules/submissions/submission.validator'

const ctx: SubmissionValidationContext = {
  specificationHash: 'sha256:abc',
  repository: 'org/repo',
  baseCommitSha: 'base123456',
  requirementIds: ['REQ-1', 'REQ-2'],
}

const manifest = (over: Record<string, unknown> = {}) =>
  registerSubmissionSchema.parse({
    specificationHash: 'sha256:abc',
    repository: 'org/repo',
    baseCommit: 'base123456',
    headCommit: 'head789abc',
    claims: [
      { requirementId: 'REQ-1', status: 'IMPLEMENTED', evidence: [{ kind: 'TEST', ref: 'suite#1' }] },
      { requirementId: 'REQ-2', status: 'IMPLEMENTED', evidence: [{ kind: 'FILE', ref: 'src/x.ts' }] },
    ],
    ...over,
  })

describe('registerSubmissionSchema', () => {
  it('defaults source to MANUAL and normalizes claim/deviation arrays', () => {
    const m = manifest()
    expect(m.source).toBe('MANUAL')
    expect(m.deviations).toEqual([])
    expect(m.claims[0].evidence).toHaveLength(1)
  })
})

describe('validateSubmissionManifest', () => {
  it('passes a well-formed submission that matches the handoff', () => {
    const result = validateSubmissionManifest(manifest(), ctx)
    expect(result.passed).toBe(true)
    expect(result.errorCount).toBe(0)
  })

  it('errors when the specification hash does not match the approved spec', () => {
    const result = validateSubmissionManifest(manifest({ specificationHash: 'sha256:WRONG' }), ctx)
    expect(result.passed).toBe(false)
    expect(result.checks.find((c) => c.id === 'spec-hash-matches')?.passed).toBe(false)
  })

  it('errors on a different repository and on claims outside the handoff scope', () => {
    const wrongRepo = validateSubmissionManifest(manifest({ repository: 'org/other' }), ctx)
    expect(wrongRepo.checks.find((c) => c.id === 'repository-matches')?.passed).toBe(false)
    expect(wrongRepo.passed).toBe(false)

    const dangling = validateSubmissionManifest(
      manifest({ claims: [{ requirementId: 'REQ-NOPE', status: 'IMPLEMENTED', evidence: [] }] }),
      ctx,
    )
    expect(dangling.checks.find((c) => c.id === 'claims-reference-in-scope')?.passed).toBe(false)
    expect(dangling.passed).toBe(false)
  })

  it('warns (does not block) on unclaimed requirements, missing evidence, and a rebased base', () => {
    const result = validateSubmissionManifest(
      manifest({
        baseCommit: 'rebased999',
        claims: [{ requirementId: 'REQ-1', status: 'IMPLEMENTED', evidence: [] }],
      }),
      ctx,
    )
    expect(result.passed).toBe(true)
    expect(result.warningCount).toBeGreaterThan(0)
    expect(result.checks.find((c) => c.id === 'all-requirements-claimed')?.passed).toBe(false)
    expect(result.checks.find((c) => c.id === 'implemented-claims-have-evidence')?.passed).toBe(false)
    expect(result.checks.find((c) => c.id === 'base-commit-matches')?.passed).toBe(false)
  })

  it('treats a skipped requirement covered by a deviation as explained', () => {
    const result = validateSubmissionManifest(
      manifest({
        claims: [
          { requirementId: 'REQ-1', status: 'IMPLEMENTED', evidence: [{ kind: 'TEST', ref: 't' }] },
          { requirementId: 'REQ-2', status: 'SKIPPED', evidence: [] },
        ],
        deviations: [{ requirementId: 'REQ-2', kind: 'BLOCKED', description: 'blocked on upstream' }],
      }),
      ctx,
    )
    expect(result.checks.find((c) => c.id === 'skips-explained')?.passed).toBe(true)
  })
})
