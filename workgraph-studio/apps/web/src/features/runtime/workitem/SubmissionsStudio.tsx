import { useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { cardStyle, primaryButtonStyle, secondaryButtonStyle, inputStyle, monoTextareaStyle, thStyle, tdStyle, mutedText, sectionTitle, badgeStyle } from './workspaceStyles'
import { errText } from './errText'

/**
 * Submissions Studio — developer handoff + implementation attempts. A polished handoff card, the
 * numbered attempt history, and per-attempt details with a REQUIREMENT COVERAGE matrix (each
 * approved requirement vs the attempt's claim + evidence) plus validate / reconcile actions.
 */

interface Handoff {
  target: null | { id: string; repository: string; component: string | null; baseBranch: string; baseCommitSha: string; requirementIds: string[]; status: string; publishedAt: string | null }
  activeSpecificationVersion: null | { id: string; version: number; contentHash: string | null }
}
interface Submission { id: string; repository: string; headCommitSha: string; baseCommitSha: string; pullRequestNumber: number | null; source: string; status: string; createdAt: string; claims: any[]; deviations: any[] }

const short = (s: string) => (s && s.length > 10 ? s.slice(0, 10) : s)
const CLAIM_TONE: Record<string, string> = { IMPLEMENTED: 'var(--color-success)', PARTIAL: 'var(--color-warning)', SKIPPED: 'var(--color-danger)', NOT_APPLICABLE: 'var(--color-outline)' }

export function SubmissionsStudio({ workItemId, onGotoReconciliation }: { workItemId: string; onGotoReconciliation?: (runId: string) => void }) {
  const qc = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [editingHandoff, setEditingHandoff] = useState(false)
  const [form, setForm] = useState({ repository: '', component: '', baseBranch: 'main', baseCommitSha: '' })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [registerOpen, setRegisterOpen] = useState(false)
  const [manifestJson, setManifestJson] = useState('')

  const handoffQ = useQuery<Handoff>({ queryKey: ['handoff', workItemId], queryFn: () => api.get(`/work-items/${workItemId}/development-target`).then((r) => r.data) })
  const submissionsQ = useQuery<{ items: Submission[] }>({ queryKey: ['submissions', workItemId], queryFn: () => api.get(`/work-items/${workItemId}/submissions`).then((r) => r.data) })
  const specListQ = useQuery<{ activeVersionId: string | null }>({ queryKey: ['spec-versions', workItemId], queryFn: () => api.get(`/work-items/${workItemId}/specifications`).then((r) => r.data) })
  const activeVersionId = specListQ.data?.activeVersionId ?? null
  const activeSpecQ = useQuery<any>({ queryKey: ['spec-version', workItemId, activeVersionId], enabled: !!activeVersionId, queryFn: () => api.get(`/work-items/${workItemId}/specifications/${activeVersionId}`).then((r) => r.data) })

  const target = handoffQ.data?.target ?? null
  const submissions = submissionsQ.data?.items ?? []
  const selected = submissions.find((s) => s.id === selectedId) ?? submissions[0] ?? null
  const attemptNumber = (id: string) => submissions.length - submissions.findIndex((s) => s.id === id)
  const requirements: any[] = activeSpecQ.data?.requirements ?? []

  const clearAnd = <T,>(fn: () => T) => { setError(null); setNote(null); return fn() }
  const invalidate = (keys: string[]) => keys.forEach((k) => qc.invalidateQueries({ queryKey: [k, workItemId] }))

  const openEditor = () => { if (target) setForm({ repository: target.repository, component: target.component ?? '', baseBranch: target.baseBranch, baseCommitSha: target.baseCommitSha }); setEditingHandoff(true); setError(null); setNote(null) }
  const saveHandoffMut = useMutation({ mutationFn: () => api.put(`/work-items/${workItemId}/development-target`, { repository: form.repository.trim(), component: form.component.trim() || undefined, baseBranch: form.baseBranch.trim(), baseCommitSha: form.baseCommitSha.trim() }).then((r) => r.data), onSuccess: () => { setEditingHandoff(false); invalidate(['handoff']) }, onError: (e) => setError(errText(e)) })
  const publishMut = useMutation({ mutationFn: () => api.post(`/work-items/${workItemId}/development-target/publish`).then((r) => r.data), onSuccess: () => { setNote('Handoff published — developers can now submit against it.'); invalidate(['handoff']) }, onError: (e) => setError(errText(e)) })
  const registerMut = useMutation({ mutationFn: () => api.post(`/work-items/${workItemId}/submissions`, JSON.parse(manifestJson)).then((r) => r.data), onSuccess: (d: any) => { setRegisterOpen(false); setManifestJson(''); setSelectedId(d?.submission?.id ?? null); setNote(`Submission recorded (${d?.submission?.status}).`); invalidate(['submissions']) }, onError: (e) => setError(e instanceof SyntaxError ? `Invalid JSON: ${e.message}` : errText(e)) })
  const validateMut = useMutation({ mutationFn: (id: string) => api.post(`/work-items/${workItemId}/submissions/${id}/validate`).then((r) => r.data), onSuccess: (d: any) => setNote(`Validation: ${d.passed ? 'passed' : 'failed'} — ${d.errorCount} errors, ${d.warningCount} warnings.`), onError: (e) => setError(errText(e)) })
  const reconcileMut = useMutation({
    mutationFn: ({ id, mode }: { id: string; mode: 'DETERMINISTIC' | 'DYNAMIC' | 'SEMANTIC' }) => api.post(`/work-items/${workItemId}/submissions/${id}/reconcile`, { mode }).then((r) => r.data),
    onSuccess: (d: any) => { const status = d?.run?.status ?? d?.summary?.status; setNote(d?.dynamic ? `Tests queued — run is ${status}.` : d?.semantic ? `AI review complete: ${status}.` : `Reconciliation complete: ${status}.`); qc.invalidateQueries({ queryKey: ['reconciliations', workItemId] }); if (onGotoReconciliation && d?.run?.id) onGotoReconciliation(d.run.id) },
    onError: (e) => setError(errText(e)),
  })

  const coverage = useMemo(() => {
    if (!selected) return { rows: [] as { req: any; claim: any }[], claimed: 0 }
    const byReq = new Map((selected.claims ?? []).map((c: any) => [c.requirementId, c]))
    const rows = requirements.map((r) => ({ req: r, claim: byReq.get(r.id) ?? null }))
    return { rows, claimed: rows.filter((x) => x.claim).length }
  }, [selected, requirements])
  const coveragePct = requirements.length ? Math.round((coverage.claimed / requirements.length) * 100) : 0

  return (
    <div>
      {error && <div style={{ ...cardStyle, background: '#fee2e2', border: '1px solid #fecaca', color: '#991b1b', fontSize: 12 }}>{error}</div>}
      {note && <div style={{ ...cardStyle, background: '#ecfdf5', border: '1px solid #a7f3d0', color: '#065f46', fontSize: 12 }}>{note}</div>}

      <section style={{ ...cardStyle, background: 'linear-gradient(180deg, var(--color-surface-bright), var(--color-surface-low))' }}>
        <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 0.4, color: 'var(--color-primary)' }}>HANDOFF & SUBMISSIONS</div>
        <h2 style={{ margin: '2px 0 4px', fontSize: 18, color: 'var(--color-on-surface)' }}>Developer handoff</h2>
        <span style={mutedText}>Hand the approved spec to developers, then track each implementation attempt.</span>
      </section>

      {/* Handoff */}
      <section style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
          <h4 style={{ ...sectionTitle, fontSize: 14, marginBottom: 0 }}>Handoff configuration</h4>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {target && <span style={badgeStyle('target', target.status)}>{target.status}</span>}
            <button style={secondaryButtonStyle} onClick={openEditor}>{target ? 'Edit' : 'Configure'}</button>
            {target && target.status !== 'PUBLISHED' && <button style={primaryButtonStyle} disabled={publishMut.isPending} onClick={() => clearAnd(() => publishMut.mutate())}>{publishMut.isPending ? 'Publishing…' : 'Publish'}</button>}
          </div>
        </div>
        {!handoffQ.data?.activeSpecificationVersion && <p style={{ ...mutedText, marginTop: 10 }}>No approved specification yet — approve a spec version before handing off.</p>}
        {target ? (
          <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8 }}>
            <Field label="Repository" value={target.repository} />
            <Field label="Component" value={target.component ?? '—'} />
            <Field label="Base branch" value={target.baseBranch} />
            <Field label="Base commit" value={short(target.baseCommitSha)} />
            <Field label="In scope" value={`${target.requirementIds?.length ?? 0} requirements`} />
            <Field label="Published" value={target.publishedAt ? new Date(target.publishedAt).toLocaleString() : '—'} />
          </div>
        ) : (!editingHandoff && <p style={{ ...mutedText, marginTop: 10 }}>No handoff configured yet.</p>)}
        {editingHandoff && (
          <div style={{ marginTop: 12, display: 'grid', gap: 8, maxWidth: 520 }}>
            {(['repository', 'component', 'baseBranch', 'baseCommitSha'] as const).map((f) => (
              <label key={f} style={{ display: 'grid', gap: 4 }}>
                <span style={mutedText}>{f}{f !== 'component' ? ' *' : ''}</span>
                <input style={inputStyle} value={form[f]} onChange={(e) => setForm((p) => ({ ...p, [f]: e.target.value }))} />
              </label>
            ))}
            <div style={{ display: 'flex', gap: 8 }}>
              <button style={primaryButtonStyle} disabled={saveHandoffMut.isPending} onClick={() => clearAnd(() => saveHandoffMut.mutate())}>{saveHandoffMut.isPending ? 'Saving…' : 'Save handoff'}</button>
              <button style={secondaryButtonStyle} onClick={() => setEditingHandoff(false)}>Cancel</button>
            </div>
          </div>
        )}
      </section>

      {submissions.length === 0 ? (
        <section style={cardStyle}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
            <h4 style={{ ...sectionTitle, fontSize: 14, marginBottom: 0 }}>Attempts</h4>
            <button style={secondaryButtonStyle} onClick={() => { setRegisterOpen((o) => !o); setError(null) }}>{registerOpen ? 'Cancel' : 'Register (manifest)'}</button>
          </div>
          {registerOpen ? <RegisterForm manifestJson={manifestJson} setManifestJson={setManifestJson} pending={registerMut.isPending} onSubmit={() => clearAnd(() => registerMut.mutate())} /> : <p style={{ ...mutedText, marginTop: 10 }}>No submissions yet. Publish the handoff, then register (or push a PR against) it.</p>}
        </section>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(200px, 260px) 1fr', gap: 14, alignItems: 'start' }}>
          {/* Attempts rail */}
          <section style={cardStyle}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <h4 style={{ ...sectionTitle, fontSize: 13, marginBottom: 0 }}>Attempts</h4>
              <button style={{ ...secondaryButtonStyle, padding: '5px 9px' }} onClick={() => { setRegisterOpen((o) => !o); setError(null) }}>{registerOpen ? '×' : '+'}</button>
            </div>
            {registerOpen && <RegisterForm manifestJson={manifestJson} setManifestJson={setManifestJson} pending={registerMut.isPending} onSubmit={() => clearAnd(() => registerMut.mutate())} compact />}
            <div style={{ display: 'grid', gap: 6, marginTop: registerOpen ? 10 : 0 }}>
              {submissions.map((s) => {
                const active = s.id === (selected?.id ?? null)
                return (
                  <button key={s.id} onClick={() => setSelectedId(s.id)} style={{ textAlign: 'left', padding: '8px 10px', borderRadius: 9, cursor: 'pointer', fontSize: 12, border: active ? '1px solid var(--color-primary)' : '1px solid var(--color-outline-variant)', background: active ? 'var(--color-primary-dim)' : 'var(--color-surface-bright)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                      <strong style={{ color: 'var(--color-on-surface)' }}>Attempt #{String(attemptNumber(s.id)).padStart(3, '0')}</strong>
                      <span style={badgeStyle('submission', s.status)}>{s.status}</span>
                    </div>
                    <div style={{ ...mutedText, marginTop: 4 }}><code>{short(s.headCommitSha)}</code>{s.pullRequestNumber ? ` · PR #${s.pullRequestNumber}` : ''} · {s.source}</div>
                  </button>
                )
              })}
            </div>
          </section>

          {/* Attempt detail */}
          <div>
            {selected && (
              <>
                <section style={cardStyle}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                    <div>
                      <h3 style={{ ...sectionTitle, marginBottom: 4 }}>Attempt #{String(attemptNumber(selected.id)).padStart(3, '0')} <span style={badgeStyle('submission', selected.status)}>{selected.status}</span></h3>
                      <span style={mutedText}>{selected.repository} · <code>{short(selected.headCommitSha)}</code>{selected.pullRequestNumber ? ` · PR #${selected.pullRequestNumber}` : ''} · {selected.source} · {new Date(selected.createdAt).toLocaleString()}</span>
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <button style={secondaryButtonStyle} disabled={validateMut.isPending} onClick={() => clearAnd(() => validateMut.mutate(selected.id))}>Validate</button>
                      <button style={secondaryButtonStyle} disabled={reconcileMut.isPending} onClick={() => clearAnd(() => reconcileMut.mutate({ id: selected.id, mode: 'DETERMINISTIC' }))}>Reconcile</button>
                      <button style={secondaryButtonStyle} disabled={reconcileMut.isPending} title="LLM review" onClick={() => clearAnd(() => reconcileMut.mutate({ id: selected.id, mode: 'SEMANTIC' }))}>AI review</button>
                      <button style={primaryButtonStyle} disabled={reconcileMut.isPending} title="Run the declared tests" onClick={() => clearAnd(() => reconcileMut.mutate({ id: selected.id, mode: 'DYNAMIC' }))}>Reconcile + tests</button>
                    </div>
                  </div>
                </section>

                {/* Requirement coverage */}
                <section style={cardStyle}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
                    <h4 style={{ ...sectionTitle, fontSize: 13, marginBottom: 0 }}>Requirement coverage</h4>
                    {requirements.length > 0 && <span style={{ ...mutedText }}>{coverage.claimed}/{requirements.length} claimed ({coveragePct}%)</span>}
                    <div style={{ flex: 1, maxWidth: 200, height: 7, borderRadius: 999, background: 'var(--color-outline-variant)', overflow: 'hidden' }}>
                      <div style={{ width: `${coveragePct}%`, height: '100%', background: coveragePct >= 80 ? 'var(--color-success)' : coveragePct >= 40 ? 'var(--color-warning)' : 'var(--color-danger)' }} />
                    </div>
                  </div>
                  {requirements.length === 0 ? (
                    <p style={mutedText}>No approved requirements to measure against.</p>
                  ) : (
                    <div style={{ overflowX: 'auto' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                        <thead><tr>{['Requirement', 'Priority', 'Claim', 'Evidence'].map((h) => <th key={h} style={thStyle}>{h}</th>)}</tr></thead>
                        <tbody>
                          {coverage.rows.map(({ req, claim }) => (
                            <tr key={req.id} style={{ borderLeft: `3px solid ${claim ? (CLAIM_TONE[claim.status] ?? 'transparent') : 'var(--color-outline-variant)'}` }}>
                              <td style={{ ...tdStyle, fontWeight: 700 }}>{req.id}</td>
                              <td style={tdStyle}>{req.priority ?? '—'}</td>
                              <td style={tdStyle}>{claim ? <span style={{ color: CLAIM_TONE[claim.status] ?? 'var(--color-on-surface)', fontWeight: 700 }}>{claim.status}</span> : <span style={mutedText}>not claimed</span>}</td>
                              <td style={tdStyle}>{claim ? (claim.evidence ?? []).map((e: any) => `${e.kind}:${e.ref}`).join(', ') || '—' : '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>

                {(selected.deviations?.length ?? 0) > 0 && (
                  <section style={cardStyle}>
                    <h4 style={{ ...sectionTitle, fontSize: 13 }}>Deviations ({selected.deviations.length})</h4>
                    <div style={{ display: 'grid', gap: 6 }}>
                      {selected.deviations.map((d: any, i: number) => <div key={i} style={{ fontSize: 12, color: 'var(--color-on-surface)' }}><strong>{d.kind}</strong>{d.requirementId ? ` · ${d.requirementId}` : ''} — {d.description}</div>)}
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

function RegisterForm({ manifestJson, setManifestJson, pending, onSubmit, compact }: { manifestJson: string; setManifestJson: (v: string) => void; pending: boolean; onSubmit: () => void; compact?: boolean }) {
  return (
    <div style={{ marginTop: 10 }}>
      <textarea style={{ ...monoTextareaStyle, minHeight: compact ? 140 : 200 }} value={manifestJson} placeholder={'{\n  "specificationHash": "sha256:…",\n  "repository": "org/repo",\n  "baseCommit": "…",\n  "headCommit": "…",\n  "claims": []\n}'} onChange={(e) => setManifestJson(e.target.value)} spellCheck={false} />
      <button style={{ ...primaryButtonStyle, marginTop: 8 }} disabled={pending} onClick={onSubmit}>{pending ? 'Registering…' : 'Register submission'}</button>
    </div>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return <div><div style={{ ...mutedText, fontWeight: 700 }}>{label}</div><div style={{ fontSize: 12, color: 'var(--color-on-surface)', overflowWrap: 'anywhere' }}>{value}</div></div>
}
