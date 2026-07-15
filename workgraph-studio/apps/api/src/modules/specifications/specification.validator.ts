import type { SpecificationPackageBody } from './specification.schemas'

/**
 * Deterministic specification quality checks (spec §3C). Pure — no LLM, no I/O — so it is
 * unit-testable and cheap to run on every edit. Errors block approval; warnings inform the
 * author but do not block. (Agent/critic-based semantic checks are a later, separate pass.)
 */

export type SpecCheckSeverity = 'error' | 'warning'

export interface SpecCheck {
  id: string
  passed: boolean
  severity: SpecCheckSeverity
  message: string
}

export interface SpecValidationResult {
  passed: boolean
  errorCount: number
  warningCount: number
  checks: SpecCheck[]
}

function duplicates(ids: string[]): string[] {
  const seen = new Set<string>()
  const dup = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) dup.add(id)
    else seen.add(id)
  }
  return [...dup]
}

export function validateSpecificationBody(body: SpecificationPackageBody): SpecValidationResult {
  const checks: SpecCheck[] = []
  const requirementIds = new Set(body.requirements.map((r) => r.id))
  const acceptanceIds = new Set(body.acceptanceCriteria.map((a) => a.id))
  const testObligationIds = new Set(body.testObligations.map((t) => t.id))

  const check = (id: string, severity: SpecCheckSeverity, offenders: string[], okMessage: string, badPrefix: string) => {
    checks.push({
      id,
      severity,
      passed: offenders.length === 0,
      message: offenders.length ? `${badPrefix}: ${offenders.join(', ')}` : okMessage,
    })
  }

  // Structural integrity (errors).
  check('requirement-ids-unique', 'error', duplicates(body.requirements.map((r) => r.id)),
    'Every requirement has a unique id', 'Duplicate requirement ids')
  check('acceptance-ids-unique', 'error', duplicates(body.acceptanceCriteria.map((a) => a.id)),
    'Every acceptance criterion has a unique id', 'Duplicate acceptance-criteria ids')
  check('test-obligation-ids-unique', 'error', duplicates(body.testObligations.map((t) => t.id)),
    'Every test obligation has a unique id', 'Duplicate test-obligation ids')
  check('source-ids-unique', 'error', duplicates(body.sources.map((s) => s.id)),
    'Every source has a unique id', 'Duplicate source ids')
  check('must-has-acceptance', 'error',
    body.requirements.filter((r) => r.priority === 'MUST' && r.acceptanceCriterionIds.length === 0).map((r) => r.id),
    'Every MUST requirement has acceptance criteria', 'MUST requirements missing acceptance criteria')
  check('acceptance-references-valid', 'error',
    body.acceptanceCriteria.filter((a) => a.requirementIds.some((id) => !requirementIds.has(id))).map((a) => a.id),
    'All acceptance-criteria → requirement references resolve', 'Acceptance criteria referencing unknown requirements')
  check('requirement-acceptance-refs-valid', 'error',
    body.requirements.filter((r) => r.acceptanceCriterionIds.some((id) => !acceptanceIds.has(id))).map((r) => r.id),
    'All requirement → acceptance-criteria references resolve', 'Requirements referencing unknown acceptance criteria')
  check('requirement-test-refs-valid', 'error',
    body.requirements.filter((r) => r.testObligationIds.some((id) => !testObligationIds.has(id))).map((r) => r.id),
    'All requirement → test-obligation references resolve', 'Requirements referencing unknown test obligations')

  // MUST requirements cannot enter an executable contract without a verification strategy.
  check('must-has-test-obligation', 'error',
    body.requirements.filter((r) => r.priority === 'MUST' && r.testObligationIds.length === 0).map((r) => r.id),
    'Every MUST requirement has a test obligation', 'MUST requirements without a test obligation')
  check('requirement-has-test-obligation', 'warning',
    body.requirements.filter((r) => r.priority !== 'MUST' && r.testObligationIds.length === 0).map((r) => r.id),
    'Every non-MUST requirement has a test obligation', 'Non-MUST requirements without a test obligation')
  check('requirement-has-source', 'warning',
    body.requirements.filter((r) => r.sourceIds.length === 0).map((r) => r.id),
    'Every requirement traces to a source', 'Requirements without a source')
  check('open-questions-resolved', 'warning',
    body.openQuestions.filter((q) => !q.answered).map((q) => q.id),
    'No unresolved open questions', 'Unresolved open questions')

  const errorCount = checks.filter((c) => !c.passed && c.severity === 'error').length
  const warningCount = checks.filter((c) => !c.passed && c.severity === 'warning').length
  return { passed: errorCount === 0, errorCount, warningCount, checks }
}
