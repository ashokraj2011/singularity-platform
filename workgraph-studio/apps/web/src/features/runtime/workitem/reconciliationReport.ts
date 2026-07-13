/**
 * Reconciliation report — pure markdown builder. Composes a shareable report (verdict, summary,
 * per-requirement matrix, findings) from a run + its verdicts/findings, rendered in-app with the
 * dependency-free MarkdownView and offered for copy/download. No I/O.
 */

export interface ReportRun {
  status: string
  mode: string
  createdAt?: string
  completedAt?: string | null
  traceId?: string | null
  specificationHash?: string | null
  summary?: { pass?: number; partial?: number; fail?: number; notApplicable?: number; total?: number; policyBreach?: boolean } | null
}
export interface ReportVerdict { requirementId: string; priority?: string | null; verdict: string; claimStatus?: string | null; rationale?: string | null; verified?: boolean }
export interface ReportFinding { requirementId?: string | null; kind: string; severity: string; message: string }
export interface ReportSubmission { repository?: string; headCommitSha?: string; pullRequestNumber?: number | null }

export interface ReconciliationReportInput {
  workCode?: string | null
  title?: string | null
  run: ReportRun
  verdicts: ReportVerdict[]
  findings: ReportFinding[]
  submission?: ReportSubmission | null
}

const cell = (s: unknown) => String(s ?? '—').replace(/\|/g, '\\|').replace(/\n/g, ' ')

export function buildReconciliationReport(i: ReconciliationReportInput): string {
  const s = i.run.summary ?? {}
  const L: string[] = []
  L.push(`# Reconciliation Report — ${[i.workCode, i.title].filter(Boolean).join(' · ') || 'Work Item'}`)
  L.push('')
  L.push(`**Verdict:** ${i.run.status}  ·  **Mode:** ${i.run.mode}`)
  if (i.submission) {
    const parts = [i.submission.repository, i.submission.pullRequestNumber ? `PR #${i.submission.pullRequestNumber}` : '', i.submission.headCommitSha ? String(i.submission.headCommitSha).slice(0, 10) : ''].filter(Boolean)
    if (parts.length) L.push(`**Submission:** ${parts.join(' · ')}`)
  }
  if (i.run.specificationHash) L.push(`**Specification:** ${i.run.specificationHash}`)
  if (i.run.completedAt) L.push(`**Completed:** ${new Date(i.run.completedAt).toLocaleString()}`)
  if (i.run.traceId) L.push(`**Trace:** ${i.run.traceId}`)
  L.push('')
  L.push('## Summary')
  L.push(`- Pass: ${s.pass ?? 0}`)
  L.push(`- Partial: ${s.partial ?? 0}`)
  L.push(`- Fail: ${s.fail ?? 0}`)
  L.push(`- Not applicable: ${s.notApplicable ?? 0}`)
  L.push(`- Total: ${s.total ?? i.verdicts.length}`)
  if (s.policyBreach) L.push('- **Policy breach detected**')
  L.push('')
  L.push('## Requirement matrix')
  L.push('')
  L.push('| Requirement | Priority | Verdict | Evidence | Rationale |')
  L.push('|---|---|---|---|---|')
  for (const v of i.verdicts) L.push(`| ${cell(v.requirementId)} | ${cell(v.priority)} | ${cell(v.verdict)} | ${v.verified ? 'verified' : 'declared'} | ${cell(v.rationale)} |`)
  L.push('')
  if (i.findings.length) {
    L.push('## Findings')
    for (const f of i.findings) L.push(`- **${f.severity}** · ${f.kind}${f.requirementId ? ` (${f.requirementId})` : ''}: ${cell(f.message)}`)
    L.push('')
  }
  return L.join('\n')
}
