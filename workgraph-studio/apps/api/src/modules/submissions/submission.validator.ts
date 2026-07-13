import type { SubmissionManifest } from './submission.schemas'

/**
 * Deterministic submission-vs-handoff checks (spec §7). Pure — no LLM, no I/O — so it is
 * unit-testable and runs on every register/validate. Errors mean the submission does not
 * correspond to the approved specification it claims (wrong hash/repo, dangling requirement
 * refs) and it is recorded but REJECTED; warnings are recorded and surfaced but do not block.
 * This is the identity/consistency gate only — reconciliation independently verifies the claims.
 */

export type SubmissionCheckSeverity = 'error' | 'warning'

export interface SubmissionCheck {
  id: string
  passed: boolean
  severity: SubmissionCheckSeverity
  message: string
}

export interface SubmissionValidationResult {
  passed: boolean
  errorCount: number
  warningCount: number
  checks: SubmissionCheck[]
}

export interface SubmissionValidationContext {
  /** contentHash of the approved specification version being claimed. */
  specificationHash: string | null
  /** repository configured on the developer handoff. */
  repository: string
  /** base commit the handoff was cut from. */
  baseCommitSha: string
  /** requirement ids in scope for this handoff. */
  requirementIds: string[]
}

const norm = (s: string) => s.trim().toLowerCase()

export function validateSubmissionManifest(
  manifest: SubmissionManifest,
  ctx: SubmissionValidationContext,
): SubmissionValidationResult {
  const checks: SubmissionCheck[] = []
  const push = (id: string, severity: SubmissionCheckSeverity, passed: boolean, message: string) =>
    checks.push({ id, severity, passed, message })

  const inScope = new Set(ctx.requirementIds)

  // Identity (errors) — the submission must correspond to exactly the approved spec + handoff repo.
  push('spec-hash-matches', 'error', !!ctx.specificationHash && manifest.specificationHash === ctx.specificationHash,
    ctx.specificationHash && manifest.specificationHash === ctx.specificationHash
      ? 'Submission targets the approved specification hash'
      : `Submission hash (${manifest.specificationHash}) does not match the approved specification hash (${ctx.specificationHash ?? 'none'})`)

  push('repository-matches', 'error', norm(manifest.repository) === norm(ctx.repository),
    norm(manifest.repository) === norm(ctx.repository)
      ? 'Submission repository matches the handoff'
      : `Submission repository (${manifest.repository}) does not match the handoff repository (${ctx.repository})`)

  const danglingClaims = manifest.claims.filter((c) => !inScope.has(c.requirementId)).map((c) => c.requirementId)
  push('claims-reference-in-scope', 'error', danglingClaims.length === 0,
    danglingClaims.length === 0
      ? 'All claims reference in-scope requirements'
      : `Claims reference requirements not in the handoff scope: ${[...new Set(danglingClaims)].join(', ')}`)

  // Completeness / hygiene (warnings).
  const claimed = new Set(manifest.claims.map((c) => c.requirementId))
  const unclaimed = ctx.requirementIds.filter((id) => !claimed.has(id))
  push('all-requirements-claimed', 'warning', unclaimed.length === 0,
    unclaimed.length === 0 ? 'Every in-scope requirement has a claim' : `Requirements with no claim: ${unclaimed.join(', ')}`)

  const missingEvidence = manifest.claims
    .filter((c) => (c.status === 'IMPLEMENTED' || c.status === 'PARTIAL') && c.evidence.length === 0)
    .map((c) => c.requirementId)
  push('implemented-claims-have-evidence', 'warning', missingEvidence.length === 0,
    missingEvidence.length === 0 ? 'Implemented/partial claims carry evidence' : `Implemented/partial claims without evidence: ${missingEvidence.join(', ')}`)

  const deviated = new Set(manifest.deviations.map((d) => d.requirementId).filter(Boolean) as string[])
  const unexplainedSkips = manifest.claims
    .filter((c) => (c.status === 'SKIPPED' || c.status === 'PARTIAL') && !c.notes && !deviated.has(c.requirementId))
    .map((c) => c.requirementId)
  push('skips-explained', 'warning', unexplainedSkips.length === 0,
    unexplainedSkips.length === 0 ? 'Skipped/partial claims are explained' : `Skipped/partial claims without notes or a deviation: ${unexplainedSkips.join(', ')}`)

  const baseMatches = norm(manifest.baseCommit) === norm(ctx.baseCommitSha)
  push('base-commit-matches', 'warning', baseMatches,
    baseMatches ? 'Submission was built from the handoff base commit' : `Submission base commit (${manifest.baseCommit}) differs from the handoff base (${ctx.baseCommitSha})`)

  const errorCount = checks.filter((c) => !c.passed && c.severity === 'error').length
  const warningCount = checks.filter((c) => !c.passed && c.severity === 'warning').length
  return { passed: errorCount === 0, errorCount, warningCount, checks }
}
