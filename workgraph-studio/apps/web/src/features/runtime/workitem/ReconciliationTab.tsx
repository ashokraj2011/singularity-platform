import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { cardStyle, thStyle, tdStyle, mutedText, sectionTitle, badgeStyle } from './workspaceStyles'

interface RunSummary {
  id: string; submissionId: string; status: string; mode: string; createdAt: string
  summary: { total?: number; pass?: number; partial?: number; fail?: number; notApplicable?: number; policyBreach?: boolean }
  _count?: { verdicts: number; findings: number }
}
interface Verdict { id: string; requirementId: string; priority: string | null; verdict: string; claimStatus: string | null; rationale: string | null }
interface Finding { id: string; requirementId: string | null; kind: string; severity: string; message: string }
interface RunDetail extends RunSummary { verdicts: Verdict[]; findings: Finding[]; specificationHash: string | null; traceId: string | null; completedAt: string | null }

export function ReconciliationTab({ workItemId, focusRunId }: { workItemId: string; focusRunId?: string | null }) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  useEffect(() => { if (focusRunId) setSelectedId(focusRunId) }, [focusRunId])

  const listQ = useQuery<{ items: RunSummary[] }>({
    queryKey: ['reconciliations', workItemId],
    queryFn: () => api.get(`/work-items/${workItemId}/reconciliations`).then(r => r.data),
  })
  const runs = listQ.data?.items ?? []
  const currentId = selectedId ?? runs[0]?.id ?? null

  const runQ = useQuery<RunDetail>({
    queryKey: ['reconciliation', workItemId, currentId],
    enabled: !!currentId,
    queryFn: () => api.get(`/work-items/${workItemId}/reconciliations/${currentId}`).then(r => r.data),
  })
  const run = runQ.data

  return (
    <div>
      <section style={cardStyle}>
        <h3 style={{ ...sectionTitle, marginBottom: 4 }}>Reconciliation</h3>
        <span style={mutedText}>Per-requirement verdicts from measuring a submission against the approved specification.</span>
      </section>

      {listQ.isLoading ? (
        <p style={mutedText}>Loading reconciliation runs…</p>
      ) : runs.length === 0 ? (
        <section style={cardStyle}><p style={mutedText}>No reconciliation runs yet. Reconcile a submission from the Submissions tab.</p></section>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 300px) 1fr', gap: 14, alignItems: 'start' }}>
          {/* Run rail */}
          <section style={cardStyle}>
            <h4 style={{ ...sectionTitle, fontSize: 13 }}>Runs</h4>
            <div style={{ display: 'grid', gap: 6 }}>
              {runs.map((r) => {
                const isCurrent = r.id === currentId
                return (
                  <button
                    key={r.id}
                    onClick={() => setSelectedId(r.id)}
                    style={{
                      textAlign: 'left', padding: '8px 10px', borderRadius: 9, cursor: 'pointer', fontSize: 12,
                      border: isCurrent ? '1px solid #8b5cf6' : '1px solid var(--color-outline-variant)',
                      background: isCurrent ? '#f5f3ff' : '#fff',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                      <span style={badgeStyle('run', r.status)}>{r.status}</span>
                      <span style={mutedText}>{r.mode}</span>
                    </div>
                    <div style={{ ...mutedText, marginTop: 4 }}>
                      {(r.summary?.pass ?? 0)}✓ {(r.summary?.partial ?? 0)}~ {(r.summary?.fail ?? 0)}✕ · {new Date(r.createdAt).toLocaleString()}
                    </div>
                  </button>
                )
              })}
            </div>
          </section>

          {/* Run detail */}
          <div>
            {runQ.isLoading || !run ? (
              <section style={cardStyle}><p style={mutedText}>Loading run…</p></section>
            ) : (
              <>
                <section style={cardStyle}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <span style={badgeStyle('run', run.status)}>{run.status}</span>
                    <span style={mutedText}>{run.mode}</span>
                    {run.completedAt && <span style={mutedText}>· {new Date(run.completedAt).toLocaleString()}</span>}
                  </div>
                  <div style={{ display: 'flex', gap: 14, marginTop: 10, flexWrap: 'wrap', fontSize: 12 }}>
                    <Stat label="Pass" value={run.summary?.pass ?? 0} color="#16a34a" />
                    <Stat label="Partial" value={run.summary?.partial ?? 0} color="#d97706" />
                    <Stat label="Fail" value={run.summary?.fail ?? 0} color="#dc2626" />
                    <Stat label="N/A" value={run.summary?.notApplicable ?? 0} color="#64748b" />
                    <Stat label="Total" value={run.summary?.total ?? run.verdicts.length} color="var(--color-on-surface)" />
                    {run.summary?.policyBreach && <span style={badgeStyle('severity', 'ERROR')}>policy breach</span>}
                  </div>
                  {run.traceId && <div style={{ ...mutedText, marginTop: 8 }}>trace: <code>{run.traceId}</code></div>}
                </section>

                <section style={cardStyle}>
                  <h4 style={{ ...sectionTitle, fontSize: 13 }}>Requirement verdicts ({run.verdicts.length})</h4>
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <thead><tr>{['Requirement', 'Priority', 'Verdict', 'Claim', 'Rationale'].map((h) => <th key={h} style={thStyle}>{h}</th>)}</tr></thead>
                      <tbody>
                        {run.verdicts.map((v) => (
                          <tr key={v.id}>
                            <td style={tdStyle}><strong>{v.requirementId}</strong></td>
                            <td style={tdStyle}>{v.priority ?? '—'}</td>
                            <td style={tdStyle}><span style={badgeStyle('verdict', v.verdict)}>{v.verdict}</span></td>
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
                          <span style={{ color: 'var(--color-on-surface)' }}>
                            <strong>{f.kind}</strong>{f.requirementId ? ` · ${f.requirementId}` : ''} — {f.message}
                          </span>
                        </div>
                      ))}
                    </div>
                  </section>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function Stat({ label, value, color }: { label: string; value: number | string; color: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 5 }}>
      <strong style={{ color, fontSize: 15 }}>{value}</strong>
      <span style={mutedText}>{label}</span>
    </span>
  )
}
