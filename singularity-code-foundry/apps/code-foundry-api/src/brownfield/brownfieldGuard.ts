/**
 * M42.5 — Brownfield Patch Guard (spec §25.12).
 *
 * Recipe-independent invariants that hold for every brownfield change:
 *
 *   1. Preserve all existing public endpoints (no removal). The plan's
 *      operations must not target controller/router files in a way
 *      that would remove an endpoint. Today the only allowed
 *      operations are ADD_*; if a future op type is REMOVE_ENDPOINT
 *      we'll explicitly require SECURITY_CHANGE/REMOVAL classification.
 *
 *   2. Preserve all existing audit event names. Plan operations must
 *      not target audit-logger files unless the enhancement spec
 *      explicitly says so.
 *
 *   3. Preserve security configuration unless `enhancement.type`
 *      declares a security change. ADD_RESPONSE_FIELD does not.
 *
 *   4. Patch only files in the approved change plan. Enforced by the
 *      dispatcher implicitly (we only invoke recipes for plan ops),
 *      but we double-check the operations list shape here.
 *
 *   5. Existing tests cannot be deleted. ADD_* operations never delete;
 *      we still assert no operation targets a tests file with a
 *      removal class.
 *
 * The guard returns `{passed, reason}` — the dispatcher refuses to
 * apply the plan when `passed = false`.
 */
import type { ChangePlan, EnhancementSpec, RepoModel } from './types.js'

export interface BrownfieldGuardInput {
  repoModel: RepoModel
  plan: ChangePlan
  enhancementSpec: EnhancementSpec
}

export interface BrownfieldGuardOutcome {
  passed: boolean
  reason?: string
  violations: string[]
}

const SECURITY_CHANGE_TYPES = new Set<string>(['SECURITY_CHANGE'])

export function runBrownfieldGuard(input: BrownfieldGuardInput): BrownfieldGuardOutcome {
  const { repoModel, plan, enhancementSpec } = input
  const violations: string[] = []

  // (1) No operation should target a controller/router file with a
  // removal classifier. V1 has no REMOVE_* ops, so this is a forward-
  // compatibility check.
  const controllerFiles = new Set(repoModel.controllers.map(c => c.file))
  for (const op of plan.operations) {
    if (controllerFiles.has(op.targetFile) && /^REMOVE_/.test(op.operation)) {
      violations.push(`Operation '${op.operation}' would remove an endpoint in '${op.targetFile}'.`)
    }
  }

  // (2) Audit event names — block any op that touches an audit-logger
  // file unless the enhancement spec opts in. ADD_RESPONSE_FIELD never
  // does.
  const auditFiles = new Set(repoModel.auditEvents.map(e => e.file))
  for (const op of plan.operations) {
    if (auditFiles.has(op.targetFile) && enhancementSpec.update?.audit !== true) {
      violations.push(`Operation '${op.operation}' targets audit-logger file '${op.targetFile}' without enhancement.update.audit = true.`)
    }
  }

  // (3) Security config — block any op that touches a security file
  // unless the enhancement spec declares a SECURITY_CHANGE.
  const isSecChange = SECURITY_CHANGE_TYPES.has(enhancementSpec.enhancement.type)
  const secFiles = new Set(repoModel.securityConfigFiles)
  for (const op of plan.operations) {
    if (secFiles.has(op.targetFile) && !isSecChange) {
      violations.push(`Operation '${op.operation}' targets security config '${op.targetFile}' but the enhancement is '${enhancementSpec.enhancement.type}' (not a SECURITY_CHANGE).`)
    }
  }

  // (4) Plan-shape sanity: every op needs a non-empty targetFile.
  for (const op of plan.operations) {
    if (!op.targetFile || op.targetFile.trim() === '') {
      violations.push(`Operation '${op.operation}' has no targetFile.`)
    }
  }

  // (5) No DELETE-class operation against tests. Forward-compat check.
  const testFiles = new Set(repoModel.tests.map(t => t.file))
  for (const op of plan.operations) {
    if (testFiles.has(op.targetFile) && /^DELETE_/.test(op.operation)) {
      violations.push(`Operation '${op.operation}' would delete test file '${op.targetFile}'.`)
    }
  }

  if (violations.length > 0) {
    return { passed: false, reason: violations.join(' | '), violations }
  }
  return { passed: true, violations: [] }
}
