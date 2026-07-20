import {
  evaluateDiffVsDesign,
  type DiffValidation,
  type DiffViolation,
} from '../workflow/runtime/executors/governance/diffVsDesign'

/**
 * Deterministic reconciliation engine (spec §15, "Layer 1"). Pure — no LLM, no code execution,
 * no I/O — so it is unit-testable and runs in-request. It measures a submission's DECLARED
 * evidence + the STATIC change manifest against the approved spec + handoff policy, producing a
 * per-requirement verdict matrix. It never executes the implementer's tests (that is the dynamic
 * layer, deferred to the runner queue); a PASS here means "the declared evidence is internally
 * consistent and policy-clean", not "the tests were run and passed".
 *
 * Path/test policy reuses the Governance Gate's DIFF_VS_DESIGN evaluator (evaluateDiffVsDesign)
 * so reconciliation and the governance gate share one implementation of forbidden/required paths.
 */

export type VerdictValue = 'PASS' | 'PARTIAL' | 'FAIL' | 'NOT_APPLICABLE' | 'NOT_VERIFIED'
export type FindingSeverity = 'ERROR' | 'WARNING' | 'INFO'
/**
 * NOT_VERIFIED is "nothing was assessed", distinct from FAILED ("assessed and refuted").
 * It exists so an unproven run cannot read as PASSED — see `reconcile` below.
 */
export type RunStatus = 'PASSED' | 'PARTIAL' | 'FAILED' | 'NOT_VERIFIED'

export interface EngineRequirement {
  id: string
  priority: string
  testObligationIds: string[]
}

export interface EngineClaim {
  requirementId: string
  status: string
  evidence: { kind: string; ref: string }[]
}

export interface EngineDeviation {
  requirementId?: string
  kind: string
  description: string
}

export interface ReconciliationInput {
  requirements: EngineRequirement[]
  /** requirement ids in scope for this handoff (empty ⇒ all requirements). */
  scopeRequirementIds: string[]
  /** required evidence kinds per requirement, from the handoff. */
  requiredEvidence: { requirementId: string; kind: string }[]
  /** forbidden/required paths + requireTests — from the handoff reconciliation policy. */
  diffValidation: DiffValidation
  claims: EngineClaim[]
  deviations: EngineDeviation[]
  /** files the submission changed (from the diff or declared FILE/TEST evidence). */
  changedFiles: string[]
  /**
   * Automated callers set this. A human filing a submission by hand is asserting the change
   * exists; a machine posting results back is not — for it, an empty change manifest means the
   * run proved nothing about any code, so the verdict must be NOT_VERIFIED rather than a
   * warning attached to an otherwise-clean PASS. Default false keeps the human path unchanged.
   */
  requireChangeManifest?: boolean
}

export interface EngineVerdict {
  requirementId: string
  priority: string
  verdict: VerdictValue
  claimStatus: string | null
  rationale: string
  evidence: { kind: string; ref: string }[]
}

export interface EngineFinding {
  requirementId?: string
  kind: string
  severity: FindingSeverity
  message: string
}

export interface ReconciliationResult {
  status: RunStatus
  verdicts: EngineVerdict[]
  findings: EngineFinding[]
  summary: {
    total: number
    pass: number
    partial: number
    fail: number
    notApplicable: number
    notVerified: number
    errorFindings: number
    warningFindings: number
    policyBreach: boolean
    /** true ⇒ the run measured nothing, so its verdict carries no assurance either way. */
    unproven: boolean
  }
}

const POLICY_KINDS = new Set<DiffViolation['kind']>(['forbidden-path', 'missing-required-path', 'missing-tests'])

function hasPolicy(dv: DiffValidation): boolean {
  return !!(dv.forbiddenPaths?.length || dv.requiredPathPatterns?.length || dv.requireTests)
}

export function reconcile(input: ReconciliationInput): ReconciliationResult {
  const findings: EngineFinding[] = []

  // Requirement scope: an explicit handoff scope wins; otherwise every requirement is in scope.
  const scope = input.scopeRequirementIds.length
    ? input.requirements.filter((r) => input.scopeRequirementIds.includes(r.id))
    : input.requirements

  const claimByReq = new Map(input.claims.map((c) => [c.requirementId, c]))
  const deviatedReqs = new Set(input.deviations.map((d) => d.requirementId).filter(Boolean) as string[])

  // Required evidence kinds per requirement.
  const requiredKinds = new Map<string, Set<string>>()
  for (const e of input.requiredEvidence) {
    if (!requiredKinds.has(e.requirementId)) requiredKinds.set(e.requirementId, new Set())
    requiredKinds.get(e.requirementId)!.add(e.kind)
  }

  // `unproven` means the run had nothing to measure. It is deliberately NOT a failure — a failure
  // asserts the implementation is wrong, and we do not know that. It only forbids PASSED.
  let unproven = false

  // Run-level path/test policy (reused DIFF_VS_DESIGN evaluator). Needs a change manifest to check.
  //
  // An empty manifest is treated differently by caller kind. For a human submission it stays a
  // WARNING attached to the policy (the historical behaviour). For an automated caller it is an
  // ERROR that makes the whole run unproven, and it applies whether or not a policy is configured:
  // if no files changed, no policy — and no claim — was actually tested by anything.
  let policyBreach = false
  if (input.changedFiles.length === 0) {
    if (input.requireChangeManifest) {
      unproven = true
      findings.push({ kind: 'no-change-manifest', severity: 'ERROR', message: 'No changed files were reported, so this reconciliation could not check the implementation against the specification. Nothing is verified.' })
    } else if (hasPolicy(input.diffValidation)) {
      findings.push({ kind: 'no-change-manifest', severity: 'WARNING', message: 'Reconciliation policy is set but no changed files were available to check.' })
    }
  } else if (hasPolicy(input.diffValidation)) {
    for (const v of evaluateDiffVsDesign({ pathsTouched: input.changedFiles }, input.diffValidation)) {
      if (!POLICY_KINDS.has(v.kind)) continue
      policyBreach = true
      findings.push({ kind: v.kind, severity: 'ERROR', message: v.detail })
    }
  }

  // A submission that carried NO claims at all has not been refuted — it has not been assessed.
  // Marking every requirement FAIL (the pre-existing behaviour) produces a wall of red that reads
  // identically to a genuinely refuted implementation, so operators learn to ignore it. One
  // run-level ERROR finding + NOT_VERIFIED verdicts says the same thing legibly.
  const noClaimsSubmitted = input.claims.length === 0
  if (noClaimsSubmitted && scope.length > 0) {
    unproven = true
    findings.push({ kind: 'no-claims-submitted', severity: 'ERROR', message: `The submission made no claims, so none of the ${scope.length} in-scope requirement(s) were assessed. Nothing is verified.` })
  }

  const verdicts: EngineVerdict[] = scope.map((req) => {
    const claim = claimByReq.get(req.id) ?? null
    const evidence = claim?.evidence ?? []
    const presentKinds = new Set(evidence.map((e) => e.kind))
    const base = { requirementId: req.id, priority: req.priority, claimStatus: claim?.status ?? null, evidence }

    if (!claim) {
      // Unassessed vs refuted. When the submission claimed nothing at all, this requirement was
      // never looked at (one run-level finding already says so). When the submission DID make
      // claims and simply omitted this one, that omission is a real gap in a real attempt — it
      // stays a FAIL, exactly as before.
      if (noClaimsSubmitted) {
        return { ...base, verdict: 'NOT_VERIFIED', rationale: 'The submission made no claims, so this requirement was not assessed.' }
      }
      findings.push({ requirementId: req.id, kind: 'unclaimed-requirement', severity: 'ERROR', message: `In-scope requirement ${req.id} has no claim in the submission.` })
      return { ...base, verdict: 'FAIL', rationale: 'No claim for this in-scope requirement.' }
    }

    if (claim.status === 'NOT_APPLICABLE') {
      return { ...base, verdict: 'NOT_APPLICABLE', rationale: 'Implementer marked the requirement not applicable.' }
    }

    if (claim.status === 'SKIPPED') {
      if (deviatedReqs.has(req.id)) {
        return { ...base, verdict: 'NOT_APPLICABLE', rationale: 'Skipped with a recorded deviation.' }
      }
      findings.push({ requirementId: req.id, kind: 'unexplained-skip', severity: 'ERROR', message: `Requirement ${req.id} is skipped without a deviation.` })
      return { ...base, verdict: 'FAIL', rationale: 'Skipped without a recorded deviation.' }
    }

    // IMPLEMENTED / PARTIAL — check declared evidence completeness + test obligations.
    const missingEvidence = [...(requiredKinds.get(req.id) ?? [])].filter((k) => !presentKinds.has(k))
    const needsTests = req.testObligationIds.length > 0
    const hasTestEvidence = presentKinds.has('TEST')
    const missingTests = needsTests && !hasTestEvidence

    const gaps: string[] = []
    if (missingEvidence.length) {
      gaps.push(`missing required evidence: ${missingEvidence.join(', ')}`)
      findings.push({ requirementId: req.id, kind: 'missing-evidence', severity: 'WARNING', message: `Requirement ${req.id} is missing required evidence: ${missingEvidence.join(', ')}.` })
    }
    if (missingTests) {
      gaps.push('no test evidence for a requirement with test obligations')
      findings.push({ requirementId: req.id, kind: 'missing-test-evidence', severity: 'WARNING', message: `Requirement ${req.id} has test obligations but no TEST evidence.` })
    }

    if (claim.status === 'PARTIAL') {
      return { ...base, verdict: 'PARTIAL', rationale: gaps.length ? `Claimed partial; ${gaps.join('; ')}.` : 'Claimed partial by the implementer.' }
    }
    // IMPLEMENTED
    if (gaps.length) {
      return { ...base, verdict: 'PARTIAL', rationale: `Claimed implemented but ${gaps.join('; ')}.` }
    }
    return { ...base, verdict: 'PASS', rationale: 'Claimed implemented with all required evidence present.' }
  })

  const count = (v: VerdictValue) => verdicts.filter((x) => x.verdict === v).length
  const mustFail = verdicts.some((v) => v.priority === 'MUST' && v.verdict === 'FAIL')
  const anyFail = verdicts.some((v) => v.verdict === 'FAIL')
  const anyPartial = verdicts.some((v) => v.verdict === 'PARTIAL')
  const anyNotVerified = verdicts.some((v) => v.verdict === 'NOT_VERIFIED')
  // An empty matrix is not a clean one: with nothing in scope, nothing was checked.
  if (verdicts.length === 0) unproven = true

  // A real breach or refutation still outranks "unproven" — those are things we DO know.
  // Everything unproven lands on NOT_VERIFIED, which is the one thing PASSED must never absorb.
  const status: RunStatus = policyBreach || mustFail
    ? 'FAILED'
    : anyFail || anyPartial
      ? 'PARTIAL'
      : unproven || anyNotVerified
        ? 'NOT_VERIFIED'
        : 'PASSED'

  return {
    status,
    verdicts,
    findings,
    summary: {
      total: verdicts.length,
      pass: count('PASS'),
      partial: count('PARTIAL'),
      fail: count('FAIL'),
      notApplicable: count('NOT_APPLICABLE'),
      notVerified: count('NOT_VERIFIED'),
      errorFindings: findings.filter((f) => f.severity === 'ERROR').length,
      warningFindings: findings.filter((f) => f.severity === 'WARNING').length,
      policyBreach,
      unproven,
    },
  }
}
