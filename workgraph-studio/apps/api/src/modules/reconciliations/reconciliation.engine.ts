import {
  evaluateDiffVsDesign,
  type DiffValidation,
  type DiffViolation,
} from '../workflow/runtime/executors/governance/diffVsDesign'
import type { ObligationResult } from './reconciliation.obligations'

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
export type RunStatus = 'PASSED' | 'PARTIAL' | 'FAILED'

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
   * Results of the requirements' declared obligations, pre-evaluated by the service (resolving a
   * symbol inventory is I/O, and this module stays pure). Omitted/empty for every specification that
   * declares no obligations, which is why those runs behave exactly as they did before.
   */
  obligationResults?: ObligationResult[]
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
    /** Present only when the specification declared obligations — absent otherwise, so a run
     *  without obligations produces exactly the result shape it always has. */
    obligations?: { total: number; pass: number; fail: number; notVerified: number }
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
  const obligationsByReq = new Map<string, ObligationResult[]>()
  for (const o of input.obligationResults ?? []) {
    if (!obligationsByReq.has(o.requirementId)) obligationsByReq.set(o.requirementId, [])
    obligationsByReq.get(o.requirementId)!.push(o)
  }
  const deviatedReqs = new Set(input.deviations.map((d) => d.requirementId).filter(Boolean) as string[])

  // Required evidence kinds per requirement.
  const requiredKinds = new Map<string, Set<string>>()
  for (const e of input.requiredEvidence) {
    if (!requiredKinds.has(e.requirementId)) requiredKinds.set(e.requirementId, new Set())
    requiredKinds.get(e.requirementId)!.add(e.kind)
  }

  // Run-level path/test policy (reused DIFF_VS_DESIGN evaluator). Only when a policy exists and
  // we actually have a change manifest to check — absence of files is a WARNING, not a breach.
  let policyBreach = false
  if (hasPolicy(input.diffValidation)) {
    if (input.changedFiles.length === 0) {
      findings.push({ kind: 'no-change-manifest', severity: 'WARNING', message: 'Reconciliation policy is set but no changed files were available to check.' })
    } else {
      for (const v of evaluateDiffVsDesign({ pathsTouched: input.changedFiles }, input.diffValidation)) {
        if (!POLICY_KINDS.has(v.kind)) continue
        policyBreach = true
        findings.push({ kind: v.kind, severity: 'ERROR', message: v.detail })
      }
    }
  }

  const verdicts: EngineVerdict[] = scope.map((req) => {
    const claim = claimByReq.get(req.id) ?? null
    const evidence = claim?.evidence ?? []
    const presentKinds = new Set(evidence.map((e) => e.kind))
    const base = { requirementId: req.id, priority: req.priority, claimStatus: claim?.status ?? null, evidence }

    if (!claim) {
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

    // Declared obligations — mechanical checks the requirement carries itself. These rank WITH the
    // existing path/evidence checks as structural evidence: a FAILED obligation is an observed
    // contradiction between the spec and the submission, so it fails the requirement outright (and
    // outranks a self-declared PARTIAL). An obligation that could NOT be evaluated is a gap, never a
    // pass — it caps the requirement at PARTIAL rather than letting it through as PASS.
    const obligations = obligationsByReq.get(req.id) ?? []
    const failedObligations = obligations.filter((o) => o.status === 'FAIL')
    const unverifiedObligations = obligations.filter((o) => o.status === 'NOT_VERIFIED')
    for (const o of failedObligations) {
      findings.push({ requirementId: req.id, kind: 'obligation-failed', severity: 'ERROR', message: `Requirement ${req.id}: obligation ${o.obligationId} (${o.kind}) failed — ${o.detail}` })
    }
    for (const o of unverifiedObligations) {
      findings.push({ requirementId: req.id, kind: 'obligation-not-verified', severity: 'WARNING', message: `Requirement ${req.id}: obligation ${o.obligationId} (${o.kind}) could not be verified — ${o.detail}` })
    }
    if (failedObligations.length) {
      return { ...base, verdict: 'FAIL', rationale: `Failed ${failedObligations.length} declared obligation(s): ${failedObligations.map((o) => o.obligationId).join(', ')}.` }
    }
    if (unverifiedObligations.length) {
      gaps.push(`${unverifiedObligations.length} declared obligation(s) could not be verified`)
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

  const allObligations = input.obligationResults ?? []
  const obligationSummary = allObligations.length
    ? {
        obligations: {
          total: allObligations.length,
          pass: allObligations.filter((o) => o.status === 'PASS').length,
          fail: allObligations.filter((o) => o.status === 'FAIL').length,
          notVerified: allObligations.filter((o) => o.status === 'NOT_VERIFIED').length,
        },
      }
    : {}

  const count = (v: VerdictValue) => verdicts.filter((x) => x.verdict === v).length
  const mustFail = verdicts.some((v) => v.priority === 'MUST' && v.verdict === 'FAIL')
  const anyFail = verdicts.some((v) => v.verdict === 'FAIL')
  const anyPartial = verdicts.some((v) => v.verdict === 'PARTIAL')
  const status: RunStatus = policyBreach || mustFail ? 'FAILED' : anyFail || anyPartial ? 'PARTIAL' : 'PASSED'

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
      ...obligationSummary,
    },
  }
}
