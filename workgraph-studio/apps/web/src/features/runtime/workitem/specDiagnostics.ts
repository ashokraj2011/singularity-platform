/**
 * Spec diagnostics — the IDE's "problems" for a specification, computed client-side per requirement
 * (the same rules the deterministic validator enforces, surfaced inline as you author). Pure.
 */
export type Severity = 'error' | 'warning' | 'info'
export interface Diagnostic { severity: Severity; message: string }

export function requirementDiagnostics(req: any, body: any): Diagnostic[] {
  const d: Diagnostic[] = []
  const acIds: string[] = req?.acceptanceCriterionIds ?? []
  const testIds: string[] = req?.testObligationIds ?? []
  const srcIds: string[] = req?.sourceIds ?? []

  if (req?.priority === 'MUST' && acIds.length === 0) {
    d.push({ severity: 'error', message: 'MUST requirement has no acceptance criteria — it cannot be approved.' })
  }
  if (testIds.length === 0) {
    d.push({ severity: 'warning', message: 'No test obligation — reconciliation can only mark this declared, never verified.' })
  }
  if (srcIds.length === 0) {
    d.push({ severity: 'info', message: 'Not traced to a source.' })
  }
  const knownAc = new Set((body?.acceptanceCriteria ?? []).map((a: any) => a.id))
  const danglingAc = acIds.filter((id) => !knownAc.has(id))
  if (danglingAc.length) d.push({ severity: 'error', message: `References unknown acceptance criteria: ${danglingAc.join(', ')}.` })
  const knownTests = new Set((body?.testObligations ?? []).map((t: any) => t.id))
  const danglingT = testIds.filter((id) => !knownTests.has(id))
  if (danglingT.length) d.push({ severity: 'error', message: `References unknown test obligations: ${danglingT.join(', ')}.` })
  return d
}

/** The worst severity among diagnostics (for the explorer dot). */
export function worstSeverity(diags: Diagnostic[]): Severity | null {
  if (diags.some((x) => x.severity === 'error')) return 'error'
  if (diags.some((x) => x.severity === 'warning')) return 'warning'
  if (diags.some((x) => x.severity === 'info')) return 'info'
  return null
}

export function severityColor(s: Severity): string {
  return s === 'error' ? 'var(--color-danger)' : s === 'warning' ? 'var(--color-warning)' : 'var(--color-secondary)'
}
