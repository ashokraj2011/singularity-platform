import { describe, expect, it } from 'vitest'
import { createHash } from 'crypto'
import { buildCopilotResultsVerdict } from '../src/modules/workflow/runtime/copilot-results-verify'

// Self-consistent fixtures: the "reported" sha is computed the same way the
// verdict recomputes it (sha256 of the raw file bytes), so a match is genuine.
const NOW = '2026-07-05T00:00:00.000Z'
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')
const sha = (s: string) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex')

describe('buildCopilotResultsVerdict (advisory git-verify)', () => {
  it('PASSED — sha matches, paths in the reported delta, and a branch was pushed', () => {
    const content = 'export const x = 1\n'
    const v = buildCopilotResultsVerdict({
      git: { branch: 'sg/feat', commitSha: 'abc123', status: ['src/x.ts'] },
      artifacts: [{ path: 'src/x.ts', sha256: sha(content), contentBase64: b64(content) }],
    }, NOW)
    expect(v.status).toBe('PASSED')
    expect(v.pushed).toBe(true)
    expect(v.remoteVerified).toBe(false) // MVP never claims remote proof
    expect(v.integrity).toMatchObject({ checked: 1, ok: 1, skipped: 0 })
    expect(v.integrity.mismatched).toEqual([])
    expect(v.coverage.artifactsNotInDelta).toEqual([])
  })

  it('INCOMPLETE — posted content does not match its reported sha256', () => {
    const v = buildCopilotResultsVerdict({
      git: { branch: 'sg/feat', status: ['src/x.ts'] },
      artifacts: [{ path: 'src/x.ts', sha256: 'deadbeef', contentBase64: b64('real content') }],
    }, NOW)
    expect(v.status).toBe('INCOMPLETE')
    expect(v.integrity.mismatched).toHaveLength(1)
    expect(v.integrity.mismatched[0].path).toBe('src/x.ts')
  })

  it('UNVERIFIED — no branch/commit reported, so it cannot be verified in git', () => {
    const content = 'x'
    const v = buildCopilotResultsVerdict({
      git: { status: ['a.ts'] },
      artifacts: [{ path: 'a.ts', sha256: sha(content), contentBase64: b64(content) }],
    }, NOW)
    expect(v.status).toBe('UNVERIFIED')
    expect(v.pushed).toBe(false)
  })

  it('INCOMPLETE — a posted artifact is not in the reported changed-file set', () => {
    const content = 'y'
    const v = buildCopilotResultsVerdict({
      git: { branch: 'sg/feat', status: ['src/a.ts'] },
      artifacts: [{ path: 'src/orphan.ts', sha256: sha(content), contentBase64: b64(content) }],
    }, NOW)
    expect(v.status).toBe('INCOMPLETE')
    expect(v.coverage.artifactsNotInDelta).toEqual(['src/orphan.ts'])
  })

  it('skips integrity for truncated / no-sha / no-content artifacts', () => {
    const v = buildCopilotResultsVerdict({
      git: { branch: 'sg/feat', status: ['a.ts', 'b.ts', 'c.ts'] },
      artifacts: [
        { path: 'a.ts', truncated: true, sha256: 'x', contentBase64: 'x' },
        { path: 'b.ts', contentBase64: b64('no sha') },
        { path: 'c.ts', sha256: 'x' },
      ],
    }, NOW)
    expect(v.integrity.checked).toBe(0)
    expect(v.integrity.skipped).toBe(3)
    expect(v.status).toBe('PASSED') // pushed, all paths in delta, nothing to fail on
  })
})
