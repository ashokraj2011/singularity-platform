/**
 * Spec quality score — a lightweight, client-side readiness metric for the Spec Studio (the "68% /
 * A" gauge). Pure and defensive over the loosely-typed package body. Not an enforcement gate (that
 * is the deterministic validator); this is an authoring signal that rewards completeness.
 */

export interface QualityFactor { label: string; pct: number }
export interface QualityResult { score: number; grade: string; factors: QualityFactor[] }

const frac = (n: number, d: number) => (d === 0 ? 1 : Math.max(0, Math.min(1, n / d)))

export function specQuality(body: any, validationPassed?: boolean): QualityResult {
  const reqs: any[] = Array.isArray(body?.requirements) ? body.requirements : []
  const musts = reqs.filter((r) => r?.priority === 'MUST')
  const diagrams: any[] = Array.isArray(body?.diagrams) ? body.diagrams : []
  const pseudocode: any[] = Array.isArray(body?.pseudocode) ? body.pseudocode : []
  const questions: any[] = Array.isArray(body?.openQuestions) ? body.openQuestions : []

  const factors: { label: string; weight: number; got: number }[] = [
    { label: 'Summary', weight: 10, got: String(body?.summary ?? '').trim() ? 1 : 0 },
    { label: 'Requirements', weight: 15, got: reqs.length ? 1 : 0 },
    { label: 'MUSTs have acceptance', weight: 20, got: frac(musts.filter((r) => (r?.acceptanceCriterionIds ?? []).length > 0).length, musts.length) },
    { label: 'Requirements tested', weight: 15, got: frac(reqs.filter((r) => (r?.testObligationIds ?? []).length > 0).length, reqs.length) },
    { label: 'Traced to sources', weight: 10, got: frac(reqs.filter((r) => (r?.sourceIds ?? []).length > 0).length, reqs.length) },
    { label: 'Diagrams', weight: 10, got: diagrams.length ? 1 : 0 },
    { label: 'Pseudo-code', weight: 5, got: pseudocode.length ? 1 : 0 },
    { label: 'Questions resolved', weight: 5, got: frac(questions.filter((q) => q?.answered).length, questions.length) },
    { label: 'Validation', weight: 10, got: validationPassed === undefined ? 0.5 : validationPassed ? 1 : 0 },
  ]

  const totalWeight = factors.reduce((s, f) => s + f.weight, 0)
  const score = Math.round((factors.reduce((s, f) => s + f.weight * f.got, 0) / totalWeight) * 100)
  const grade = score >= 90 ? 'A+' : score >= 80 ? 'A' : score >= 70 ? 'B' : score >= 55 ? 'C' : score >= 40 ? 'D' : 'E'
  return { score, grade, factors: factors.map((f) => ({ label: f.label, pct: Math.round(f.got * 100) })) }
}
