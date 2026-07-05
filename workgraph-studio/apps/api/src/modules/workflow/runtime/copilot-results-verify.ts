/**
 * Advisory verification of externally-executed Copilot (or any-tool) results
 * posted back to POST /:id/export/copilot-results.
 *
 * The platform ran NOTHING locally, so this computes an *advisory* verdict from
 * the posted payload — it is a consistency + completeness signal, NOT a trust
 * boundary:
 *   - integrity: recompute sha256(contentBase64) and compare to the reported
 *     sha256 (catches a corrupted upload / a hash that doesn't match its bytes).
 *   - coverage:  are the posted artifact paths present in the reported changed-
 *     file set (git.status ∪ stages[].changedFiles)?
 *   - pushed:    did the runner report a branch/commit (so a human — or a future
 *     remote check — can independently verify)?
 *
 * `remoteVerified` is always false here: independently fetching the reported
 * commit from the remote (via the git credential broker) to prove it exists +
 * matches is the next hardening step and is deliberately out of this MVP. The
 * verdict is attached to the results Receipt and each artifact consumable's
 * `formData._verification`; artifacts stay UNDER_REVIEW (advisory — no auto
 * promote/block).
 */
import { createHash } from 'crypto'

export type CopilotResultsPayload = {
  source?: string
  status?: string
  git?: Record<string, unknown>
  stages?: Array<{ changedFiles?: string[] }>
  artifacts?: Array<{ path: string; sha256?: string; contentBase64?: string; truncated?: boolean }>
}

export type CopilotResultsVerdict = {
  status: 'PASSED' | 'INCOMPLETE' | 'UNVERIFIED'
  checkedAt: string
  /** A branch/commit was reported — required for any real git verification. */
  pushed: boolean
  branch: string | null
  commitSha: string | null
  /** Always false in this MVP: no independent remote fetch is performed yet. */
  remoteVerified: false
  integrity: {
    checked: number
    ok: number
    mismatched: Array<{ path: string; reportedSha: string; actualSha: string }>
    skipped: number
  }
  coverage: {
    reportedChangedFiles: number
    artifactsInDelta: number
    artifactsNotInDelta: string[]
  }
  note: string
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

export function buildCopilotResultsVerdict(payload: CopilotResultsPayload, checkedAt: string): CopilotResultsVerdict {
  const git = (payload.git ?? {}) as Record<string, unknown>
  const branch = str(git.branch)
  const commitSha = str(git.commitSha) ?? str(git.commit_sha)
  const pushed = Boolean(branch || commitSha)

  // Reported changed files: git.status (array) ∪ each stage.changedFiles.
  const reportedChanged = new Set<string>()
  if (Array.isArray(git.status)) for (const f of git.status) if (typeof f === 'string') reportedChanged.add(f)
  for (const s of payload.stages ?? []) for (const f of s.changedFiles ?? []) reportedChanged.add(f)

  // Integrity: recompute sha256 of the posted content vs the reported sha256.
  const artifacts = payload.artifacts ?? []
  let ok = 0
  let skipped = 0
  const mismatched: Array<{ path: string; reportedSha: string; actualSha: string }> = []
  for (const a of artifacts) {
    if (a.truncated || !a.sha256 || !a.contentBase64) { skipped++; continue }
    let actual: string
    try { actual = createHash('sha256').update(Buffer.from(a.contentBase64, 'base64')).digest('hex') }
    catch { skipped++; continue }
    if (actual.toLowerCase() === a.sha256.toLowerCase()) ok++
    else mismatched.push({ path: a.path, reportedSha: a.sha256, actualSha: actual })
  }

  // Coverage: are posted artifact paths present in the reported git delta?
  const artifactsNotInDelta = reportedChanged.size
    ? artifacts.map(a => a.path).filter(p => !reportedChanged.has(p))
    : [] // no reported delta → nothing to cross-check
  const artifactsInDelta = artifacts.length - artifactsNotInDelta.length

  let status: CopilotResultsVerdict['status']
  let note: string
  if (mismatched.length > 0) {
    status = 'INCOMPLETE'
    note = `${mismatched.length} artifact(s) do not match their reported sha256 — the posted content differs from its claimed hash.`
  } else if (!pushed) {
    status = 'UNVERIFIED'
    note = 'No branch/commit was reported, so the work cannot be verified in git. Push a branch and re-post (see the export resultContract).'
  } else if (artifactsNotInDelta.length > 0) {
    status = 'INCOMPLETE'
    note = `${artifactsNotInDelta.length} posted artifact(s) are not in the reported changed-file set.`
  } else {
    status = 'PASSED'
    note = 'Posted artifacts are internally consistent (sha256 matches, paths within the reported git delta) and a branch was reported. Independent remote-commit verification is not yet performed.'
  }

  return {
    status,
    checkedAt,
    pushed,
    branch,
    commitSha,
    remoteVerified: false,
    integrity: { checked: ok + mismatched.length, ok, mismatched, skipped },
    coverage: { reportedChangedFiles: reportedChanged.size, artifactsInDelta, artifactsNotInDelta },
    note,
  }
}
