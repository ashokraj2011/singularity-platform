import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { MarkdownView } from '../MarkdownView'
import { cardStyle, secondaryButtonStyle, thStyle, tdStyle, mutedText, sectionTitle, badgeStyle } from './workspaceStyles'
import { buildReconciliationReport } from './reconciliationReport'

/**
 * Reconciliation Studio — the redesigned reconciliation surface. A verdict header, a per-requirement
 * reconciliation matrix (declared vs verified), findings, an execution timeline, and a generated,
 * copy/downloadable report. Read-only over the run data the pipeline produced.
 */

interface RunSummary { id: string; submissionId: string; status: string; mode: string; createdAt: string; summary: any; _count?: { verdicts: number; findings: number } }
interface Verdict { id: string; requirementId: string; priority: string | null; verdict: string; claimStatus: string | null; rationale: string | null; verified?: boolean }
interface Finding { id: string; requirementId: string | null; kind: string; severity: string; message: string }
interface RunDetail extends RunSummary { verdicts: Verdict[]; findings: Finding[]; specificationHash: string | null; traceId: string | null; completedAt: string | null; startedAt?: string }
interface Submission { id: string; repository: string; headCommitSha: string; pullRequestNumber: number | null }

const VERDICT_TONE: Record<string, string> = { PASS: 'var(--color-success)', PARTIAL: 'var(--color-warning)', FAIL: 'var(--color-danger)', NOT_APPLICABLE: 'var(--color-outline)', NOT_VERIFIED: 'var(--color-secondary)' }

export function ReconciliationStudio({ workItemId, focusRunId }: { workItemId: string; focusRunId?: string | null }) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [report, setReport] = useState<string | null>(null)
  useEffect(() => { if (focusRunId) { setSelectedId(focusRunId); setReport(null) } }, [focusRunId])

  const listQ = useQuery<{ items: RunSummary[] }>({ queryKey: ['reconciliations', workItemId], queryFn: () => api.get(`/work-items/${workItemId}/reconciliations`).then((r) => r.data) })
  const runs = listQ.data?.items ?? []
  const currentId = selectedId ?? runs[0]?.id ?? null

  const runQ = useQuery<RunDetail>({ queryKey: ['reconciliation', workItemId, currentId], enabled: !!currentId, queryFn: () => api.get(`/work-items/${workItemId}/reconciliations/${currentId}`).then((r) => r.data) })
  const run = runQ.data
  const submissionsQ = useQuery<{ items: Submission[] }>({ queryKey: ['submissions', workItemId], queryFn: () => api.get(`/work-items/${workItemId}/submissions`).then((r) => r.data) })
  const submission = useMemo(() => submissionsQ.data?.items.find((s) => s.id === run?.submissionId) ?? null, [submissionsQ.data, run])
  const workItemQ = useQuery<any>({ queryKey: ['runtime-workitem', workItemId], queryFn: () => api.get(`/work-items/${workItemId}`).then((r) => r.data) })

  const generateReport = () => {
    if (!run) return
    setReport(buildReconciliationReport({
      workCode: workItemQ.data?.workCode, title: workItemQ.data?.title,
      run, verdicts: run.verdicts, findings: run.findings,
      submission: submission ? { repository: submission.repository, headCommitSha: submission.headCommitSha, pullRequestNumber: submission.pullRequestNumber } : null,
    }))
  }
  const copyReport = () => { if (report && navigator.clipboard) void navigator.clipboard.writeText(report) }
  const reportHref = report ? `data:text/markdown;charset=utf-8,${encodeURIComponent(report)}` : undefined

  return (
    <div>
      <section style={{ ...cardStyle, background: 'linear-gradient(180deg, var(--color-surface-bright), var(--color-surface-low))' }}>
        <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 0.4, color: 'var(--color-primary)' }}>RECONCILIATION</div>
        <h2 style={{ margin: '2px 0 4px', fontSize: 18, color: 'var(--color-on-surface)' }}>Requirement reconciliation</h2>
        <span style={mutedText}>Every submission measured against the approved spec — declared, test-verified, and AI-reviewed.</span>
      </section>

      {listQ.isLoading ? (
        <p style={mutedText}>Loading reconciliation runs…</p>
      ) : runs.length === 0 ? (
        <section style={cardStyle}><p style={mutedText}>No reconciliation runs yet. Reconcile a submission from the Submissions tab.</p></section>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(210px, 280px) 1fr', gap: 14, alignItems: 'start' }}>
          <section style={cardStyle}>
            <h4 style={{ ...sectionTitle, fontSize: 13 }}>Runs</h4>
            <div style={{ display: 'grid', gap: 6 }}>
              {runs.map((r) => {
                const active = r.id === currentId
                return (
                  <button key={r.id} onClick={() => { setSelectedId(r.id); setReport(null) }} style={{
                    textAlign: 'left', padding: '9px 11px', borderRadius: 10, cursor: 'pointer', fontSize: 12,
                    border: active ? '1px solid var(--color-primary)' : '1px solid var(--color-outline-variant)',
                    background: active ? 'var(--color-primary-dim)' : 'var(--color-surface-bright)',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                      <span style={badgeStyle('run', r.status)}>{r.status}</span>
                      <span style={mutedText}>{r.mode}</span>
                    </div>
                    <div style={{ ...mutedText, marginTop: 5 }}>{(r.summary?.pass ?? 0)}✓ {(r.summary?.partial ?? 0)}~ {(r.summary?.fail ?? 0)}✕ · {new Date(r.createdAt).toLocaleDateString()}</div>
                  </button>
                )
              })}
            </div>
          </section>

          <div>
            {runQ.isLoading || !run ? (
              <section style={cardStyle}><p style={mutedText}>Loading run…</p></section>
            ) : (
              <>
                {/* Verdict header */}
                <section style={cardStyle}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                      <VerdictBadge status={run.status} />
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-on-surface)' }}>
                          {run.mode} reconciliation
                          {submission ? <span style={mutedText}> · {submission.repository}{submission.pullRequestNumber ? ` · PR #${submission.pullRequestNumber}` : ''}{submission.headCommitSha ? ` · ${submission.headCommitSha.slice(0, 10)}` : ''}</span> : null}
                        </div>
                        {run.completedAt && <div style={mutedText}>completed {new Date(run.completedAt).toLocaleString()}</div>}
                        {run.traceId && <div style={mutedText}>trace <code>{run.traceId}</code></div>}
                      </div>
                    </div>
                    <button style={secondaryButtonStyle} onClick={generateReport}>Generate report</button>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(96px, 1fr))', gap: 10, marginTop: 14 }}>
                    <Gauge label="Pass" value={run.summary?.pass ?? 0} tone="var(--color-success)" />
                    <Gauge label="Partial" value={run.summary?.partial ?? 0} tone="var(--color-warning)" />
                    <Gauge label="Fail" value={run.summary?.fail ?? 0} tone="var(--color-danger)" />
                    <Gauge label="N/A" value={run.summary?.notApplicable ?? 0} tone="var(--color-outline)" />
                    <Gauge label="Total" value={run.summary?.total ?? run.verdicts.length} tone="var(--color-on-surface)" />
                  </div>
                  {run.status === 'RUNNING' && <div style={{ ...mutedText, marginTop: 10, color: 'var(--color-secondary)' }}>Tests are running via the reconciliation runner — verdicts finalize when it reports back. Refresh to check.</div>}
                  {run.summary?.policyBreach && <div style={{ marginTop: 10 }}><span style={badgeStyle('severity', 'ERROR')}>policy breach</span></div>}
                </section>

                {report && (
                  <section style={cardStyle}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
                      <h4 style={{ ...sectionTitle, fontSize: 13, marginBottom: 0 }}>Report</h4>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button style={secondaryButtonStyle} onClick={copyReport}>Copy</button>
                        {reportHref && <a style={{ ...secondaryButtonStyle, textDecoration: 'none' }} href={reportHref} download={`reconciliation-${run.id.slice(0, 8)}.md`}>Download</a>}
                        <button style={secondaryButtonStyle} onClick={() => setReport(null)}>Close</button>
                      </div>
                    </div>
                    <MarkdownView source={report} />
                  </section>
                )}

                {/* Requirement matrix */}
                <section style={cardStyle}>
                  <h4 style={{ ...sectionTitle, fontSize: 13 }}>Requirement reconciliation matrix ({run.verdicts.length})</h4>
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <thead><tr>{['Requirement', 'Priority', 'Verdict', 'Evidence', 'Claim', 'Rationale'].map((h) => <th key={h} style={thStyle}>{h}</th>)}</tr></thead>
                      <tbody>
                        {run.verdicts.map((v) => (
                          <tr key={v.id} style={{ borderLeft: `3px solid ${VERDICT_TONE[v.verdict] ?? 'transparent'}` }}>
                            <td style={{ ...tdStyle, fontWeight: 700 }}>{v.requirementId}</td>
                            <td style={tdStyle}>{v.priority ?? '—'}</td>
                            <td style={tdStyle}><span style={badgeStyle('verdict', v.verdict)}>{v.verdict}</span></td>
                            <td style={tdStyle} title={v.verified ? 'Backed by executed tests' : 'From declared evidence only'}>{v.verified ? '✓ verified' : 'declared'}</td>
                            <td style={tdStyle}>{v.claimStatus ?? '—'}</td>
                            <td style={tdStyle}>{v.rationale ?? '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>

                {run.findings.length > 0 && (
                  <section style={cardStyle}>
                    <h4 style={{ ...sectionTitle, fontSize: 13 }}>Findings ({run.findings.length})</h4>
                    <div style={{ display: 'grid', gap: 8 }}>
                      {run.findings.map((f) => (
                        <div key={f.id} style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12 }}>
                          <span style={badgeStyle('severity', f.severity)}>{f.severity}</span>
                          <span style={{ color: 'var(--color-on-surface)' }}><strong>{f.kind}</strong>{f.requirementId ? ` · ${f.requirementId}` : ''} — {f.message}</span>
                        </div>
                      ))}
                    </div>
                  </section>
                )}

                {/* Execution timeline */}
                <section style={cardStyle}>
                  <h4 style={{ ...sectionTitle, fontSize: 13 }}>Execution timeline</h4>
                  <Timeline run={run} />
                </section>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function VerdictBadge({ status }: { status: string }) {
  const tone = status === 'PASSED' ? 'var(--color-success)' : status === 'FAILED' || status === 'ERROR' ? 'var(--color-danger)' : status === 'RUNNING' ? 'var(--color-secondary)' : 'var(--color-warning)'
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', width: 84, height: 84, borderRadius: 16, background: 'var(--color-surface-low)', border: `2px solid ${tone}` }}>
      <span style={{ fontSize: 20 }}>{status === 'PASSED' ? '✓' : status === 'FAILED' || status === 'ERROR' ? '✕' : status === 'RUNNING' ? '⟳' : '~'}</span>
      <span style={{ fontSize: 11, fontWeight: 800, color: tone }}>{status}</span>
    </div>
  )
}

function Gauge({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div style={{ padding: '10px 12px', borderRadius: 10, border: '1px solid var(--color-outline-variant)', background: 'var(--color-surface-bright)' }}>
      <div style={{ fontSize: 22, fontWeight: 800, color: tone }}>{value}</div>
      <div style={mutedText}>{label}</div>
    </div>
  )
}

function Timeline({ run }: { run: RunDetail }) {
  const events: { label: string; at?: string | null; done: boolean }[] = [
    { label: 'Reconciliation started', at: run.startedAt ?? run.createdAt, done: true },
  ]
  if (run.mode !== 'DETERMINISTIC') events.push({ label: run.status === 'RUNNING' ? 'Tests running (runner)' : 'Tests executed (runner)', at: undefined, done: run.status !== 'RUNNING' })
  events.push({ label: `Completed — ${run.status}`, at: run.completedAt, done: run.status !== 'RUNNING' && run.status !== 'PENDING' })
  return (
    <div style={{ display: 'grid', gap: 0 }}>
      {events.map((e, i) => (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: '20px 1fr', gap: 10 }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <span style={{ width: 11, height: 11, borderRadius: 999, background: e.done ? 'var(--color-primary)' : 'var(--color-outline-variant)', border: '2px solid var(--color-surface-bright)' }} />
            {i < events.length - 1 && <span style={{ width: 2, flex: 1, minHeight: 22, background: 'var(--color-outline-variant)' }} />}
          </div>
          <div style={{ paddingBottom: 14 }}>
            <div style={{ fontSize: 12, color: 'var(--color-on-surface)', fontWeight: 600 }}>{e.label}</div>
            {e.at && <div style={mutedText}>{new Date(e.at).toLocaleString()}</div>}
          </div>
        </div>
      ))}
    </div>
  )
}
