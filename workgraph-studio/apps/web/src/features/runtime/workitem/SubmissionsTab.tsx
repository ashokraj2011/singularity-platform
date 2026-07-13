import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import {
  cardStyle, primaryButtonStyle, secondaryButtonStyle, inputStyle, monoTextareaStyle,
  thStyle, tdStyle, mutedText, sectionTitle, badgeStyle,
} from './workspaceStyles'
import { errText } from './errText'

interface HandoffResponse {
  target: null | {
    id: string; repository: string; component: string | null; baseBranch: string; baseCommitSha: string
    requirementIds: string[]; status: string; publishedAt: string | null
  }
  activeSpecificationVersion: null | { id: string; version: number; contentHash: string | null }
}
interface Submission {
  id: string; repository: string; headCommitSha: string; baseCommitSha: string
  pullRequestNumber: number | null; source: string; status: string; createdAt: string
  claims: any[]; deviations: any[]
}

const short = (sha: string) => (sha && sha.length > 10 ? sha.slice(0, 10) : sha)

export function SubmissionsTab({ workItemId, onGotoReconciliation }: { workItemId: string; onGotoReconciliation?: (runId: string) => void }) {
  const qc = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [editingHandoff, setEditingHandoff] = useState(false)
  const [form, setForm] = useState({ repository: '', component: '', baseBranch: 'main', baseCommitSha: '' })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [registerOpen, setRegisterOpen] = useState(false)
  const [manifestJson, setManifestJson] = useState('')

  const handoffQ = useQuery<HandoffResponse>({
    queryKey: ['handoff', workItemId],
    queryFn: () => api.get(`/work-items/${workItemId}/development-target`).then(r => r.data),
  })
  const submissionsQ = useQuery<{ items: Submission[] }>({
    queryKey: ['submissions', workItemId],
    queryFn: () => api.get(`/work-items/${workItemId}/submissions`).then(r => r.data),
  })
  const target = handoffQ.data?.target ?? null
  const activeSpec = handoffQ.data?.activeSpecificationVersion ?? null
  const submissions = submissionsQ.data?.items ?? []
  const selected = submissions.find((s) => s.id === selectedId) ?? null

  const clearAnd = <T,>(fn: () => T) => { setError(null); setNote(null); return fn() }
  const invalidate = (keys: string[]) => keys.forEach((k) => qc.invalidateQueries({ queryKey: [k, workItemId] }))

  const openEditor = () => {
    if (target) setForm({ repository: target.repository, component: target.component ?? '', baseBranch: target.baseBranch, baseCommitSha: target.baseCommitSha })
    setEditingHandoff(true); setError(null); setNote(null)
  }
  const saveHandoffMut = useMutation({
    mutationFn: () => api.put(`/work-items/${workItemId}/development-target`, {
      repository: form.repository.trim(),
      component: form.component.trim() || undefined,
      baseBranch: form.baseBranch.trim(),
      baseCommitSha: form.baseCommitSha.trim(),
    }).then(r => r.data),
    onSuccess: () => { setEditingHandoff(false); invalidate(['handoff']) },
    onError: (e) => setError(errText(e)),
  })
  const publishMut = useMutation({
    mutationFn: () => api.post(`/work-items/${workItemId}/development-target/publish`).then(r => r.data),
    onSuccess: () => { setNote('Handoff published — developers can now submit against it.'); invalidate(['handoff']) },
    onError: (e) => setError(errText(e)),
  })
  const registerMut = useMutation({
    mutationFn: () => api.post(`/work-items/${workItemId}/submissions`, JSON.parse(manifestJson)).then(r => r.data),
    onSuccess: (data: any) => { setRegisterOpen(false); setManifestJson(''); setSelectedId(data?.submission?.id ?? null); setNote(`Submission recorded (${data?.submission?.status}).`); invalidate(['submissions']) },
    onError: (e) => setError(e instanceof SyntaxError ? `Invalid JSON: ${e.message}` : errText(e)),
  })
  const validateMut = useMutation({
    mutationFn: (id: string) => api.post(`/work-items/${workItemId}/submissions/${id}/validate`).then(r => r.data),
    onSuccess: (d: any) => setNote(`Validation: ${d.passed ? 'passed' : 'failed'} — ${d.errorCount} errors, ${d.warningCount} warnings.`),
    onError: (e) => setError(errText(e)),
  })
  const reconcileMut = useMutation({
    mutationFn: (id: string) => api.post(`/work-items/${workItemId}/submissions/${id}/reconcile`).then(r => r.data),
    onSuccess: (data: any) => {
      const status = data?.run?.status ?? data?.summary?.status
      setNote(`Reconciliation complete: ${status}.`)
      qc.invalidateQueries({ queryKey: ['reconciliations', workItemId] })
      if (onGotoReconciliation && data?.run?.id) onGotoReconciliation(data.run.id)
    },
    onError: (e) => setError(errText(e)),
  })

  return (
    <div>
      {error && <div style={{ ...cardStyle, background: '#fee2e2', border: '1px solid #fecaca', color: '#991b1b', fontSize: 12 }}>{error}</div>}
      {note && <div style={{ ...cardStyle, background: '#ecfdf5', border: '1px solid #a7f3d0', color: '#065f46', fontSize: 12 }}>{note}</div>}

      {/* Developer handoff */}
      <section style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
          <h3 style={{ ...sectionTitle, marginBottom: 0 }}>Developer handoff</h3>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {target && <span style={badgeStyle('target', target.status)}>{target.status}</span>}
            <button style={secondaryButtonStyle} onClick={openEditor}>{target ? 'Edit' : 'Configure'}</button>
            {target && target.status !== 'PUBLISHED' && (
              <button style={primaryButtonStyle} disabled={publishMut.isPending} onClick={() => clearAnd(() => publishMut.mutate())}>
                {publishMut.isPending ? 'Publishing…' : 'Publish'}
              </button>
            )}
          </div>
        </div>

        {!activeSpec && <p style={{ ...mutedText, marginTop: 10 }}>No approved specification yet — approve a specification version before handing off to developers.</p>}

        {target ? (
          <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 8 }}>
            <Field label="Repository" value={target.repository} />
            <Field label="Component" value={target.component ?? '—'} />
            <Field label="Base branch" value={target.baseBranch} />
            <Field label="Base commit" value={short(target.baseCommitSha)} />
            <Field label="Requirements in scope" value={String(target.requirementIds?.length ?? 0)} />
            <Field label="Published" value={target.publishedAt ? new Date(target.publishedAt).toLocaleString() : '—'} />
          </div>
        ) : (
          !editingHandoff && <p style={{ ...mutedText, marginTop: 10 }}>No handoff configured. Configure the repository and base commit developers build against.</p>
        )}

        {editingHandoff && (
          <div style={{ marginTop: 12, display: 'grid', gap: 8, maxWidth: 520 }}>
            {(['repository', 'component', 'baseBranch', 'baseCommitSha'] as const).map((f) => (
              <label key={f} style={{ display: 'grid', gap: 4 }}>
                <span style={mutedText}>{f}{f !== 'component' ? ' *' : ''}</span>
                <input style={inputStyle} value={form[f]} onChange={(e) => setForm((prev) => ({ ...prev, [f]: e.target.value }))} />
              </label>
            ))}
            <div style={{ display: 'flex', gap: 8 }}>
              <button style={primaryButtonStyle} disabled={saveHandoffMut.isPending} onClick={() => clearAnd(() => saveHandoffMut.mutate())}>
                {saveHandoffMut.isPending ? 'Saving…' : 'Save handoff'}
              </button>
              <button style={secondaryButtonStyle} onClick={() => setEditingHandoff(false)}>Cancel</button>
            </div>
          </div>
        )}
      </section>

      {/* Submissions */}
      <section style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
          <h3 style={{ ...sectionTitle, marginBottom: 0 }}>Implementation submissions</h3>
          <button style={secondaryButtonStyle} onClick={() => { setRegisterOpen((o) => !o); setError(null); setNote(null) }}>
            {registerOpen ? 'Cancel' : 'Register (manifest)'}
          </button>
        </div>

        {registerOpen && (
          <div style={{ marginTop: 10 }}>
            <textarea
              style={monoTextareaStyle}
              value={manifestJson}
              placeholder={'{\n  "specificationHash": "sha256:…",\n  "repository": "org/repo",\n  "baseCommit": "…",\n  "headCommit": "…",\n  "claims": []\n}'}
              onChange={(e) => setManifestJson(e.target.value)}
              spellCheck={false}
            />
            <button style={{ ...primaryButtonStyle, marginTop: 8 }} disabled={registerMut.isPending} onClick={() => clearAnd(() => registerMut.mutate())}>
              {registerMut.isPending ? 'Registering…' : 'Register submission'}
            </button>
          </div>
        )}

        {submissionsQ.isLoading ? (
          <p style={{ ...mutedText, marginTop: 10 }}>Loading submissions…</p>
        ) : submissions.length === 0 ? (
          <p style={{ ...mutedText, marginTop: 10 }}>No submissions yet. Publish the handoff, then register an implementation against it.</p>
        ) : (
          <div style={{ overflowX: 'auto', marginTop: 10 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>{['Repository', 'Head', 'PR', 'Status', 'Source', 'When', ''].map((h) => <th key={h} style={thStyle}>{h}</th>)}</tr></thead>
              <tbody>
                {submissions.map((s) => (
                  <tr key={s.id} style={{ background: s.id === selectedId ? '#f5f3ff' : undefined }}>
                    <td style={tdStyle}>{s.repository}</td>
                    <td style={tdStyle}><code>{short(s.headCommitSha)}</code></td>
                    <td style={tdStyle}>{s.pullRequestNumber ?? '—'}</td>
                    <td style={tdStyle}><span style={badgeStyle('submission', s.status)}>{s.status}</span></td>
                    <td style={tdStyle}>{s.source}</td>
                    <td style={tdStyle}>{new Date(s.createdAt).toLocaleString()}</td>
                    <td style={tdStyle}><button style={secondaryButtonStyle} onClick={() => setSelectedId(s.id === selectedId ? null : s.id)}>{s.id === selectedId ? 'Hide' : 'Open'}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Selected submission detail */}
      {selected && (
        <section style={cardStyle}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
            <h4 style={{ ...sectionTitle, fontSize: 13, marginBottom: 0 }}>
              Submission · <code>{short(selected.headCommitSha)}</code> <span style={badgeStyle('submission', selected.status)}>{selected.status}</span>
            </h4>
            <div style={{ display: 'flex', gap: 8 }}>
              <button style={secondaryButtonStyle} disabled={validateMut.isPending} onClick={() => clearAnd(() => validateMut.mutate(selected.id))}>Validate</button>
              <button style={primaryButtonStyle} disabled={reconcileMut.isPending} onClick={() => clearAnd(() => reconcileMut.mutate(selected.id))}>
                {reconcileMut.isPending ? 'Reconciling…' : 'Reconcile'}
              </button>
            </div>
          </div>

          <h5 style={{ margin: '12px 0 6px', fontSize: 12, color: 'var(--color-outline)' }}>Claims ({selected.claims?.length ?? 0})</h5>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>{['Requirement', 'Status', 'Evidence'].map((h) => <th key={h} style={thStyle}>{h}</th>)}</tr></thead>
              <tbody>
                {(selected.claims ?? []).map((c: any, i: number) => (
                  <tr key={i}>
                    <td style={tdStyle}>{c.requirementId}</td>
                    <td style={tdStyle}>{c.status}</td>
                    <td style={tdStyle}>{(c.evidence ?? []).map((e: any) => `${e.kind}:${e.ref}`).join(', ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {(selected.deviations?.length ?? 0) > 0 && (
            <>
              <h5 style={{ margin: '12px 0 6px', fontSize: 12, color: 'var(--color-outline)' }}>Deviations ({selected.deviations.length})</h5>
              <div style={{ display: 'grid', gap: 6 }}>
                {selected.deviations.map((d: any, i: number) => (
                  <div key={i} style={{ fontSize: 12, color: 'var(--color-on-surface)' }}>
                    <strong>{d.kind}</strong>{d.requirementId ? ` · ${d.requirementId}` : ''} — {d.description}
                  </div>
                ))}
              </div>
            </>
          )}
        </section>
      )}
    </div>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ ...mutedText, fontWeight: 700 }}>{label}</div>
      <div style={{ fontSize: 12, color: 'var(--color-on-surface)', overflowWrap: 'anywhere' }}>{value}</div>
    </div>
  )
}
