import { useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import {
  cardStyle, primaryButtonStyle, secondaryButtonStyle, inputStyle, monoTextareaStyle,
  thStyle, tdStyle, mutedText, sectionTitle, badgeStyle,
} from './workspaceStyles'
import { errText } from './errText'

interface VersionSummary {
  id: string
  version: number
  revision: number
  status: string
  contentHash: string | null
  requirementCount: number
  acceptanceCriteriaCount: number
  testObligationCount: number
  openQuestionCount: number
  approvedById: string | null
  approvedAt: string | null
  createdAt: string
}
interface ListResponse { items: VersionSummary[]; activeVersionId: string | null }
interface SpecCheck { id: string; passed: boolean; severity: 'error' | 'warning'; message: string }
interface ValidationResult { passed: boolean; errorCount: number; warningCount: number; checks: SpecCheck[] }

const HEADER_KEYS = new Set(['schemaVersion', 'workItem', 'version'])

/** Specification tab — author, version, validate and approve the Work Item's specification. */
export function SpecificationTab({ workItemId }: { workItemId: string }) {
  const qc = useQueryClient()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [draftJson, setDraftJson] = useState('')
  const [comment, setComment] = useState('')
  const [validation, setValidation] = useState<ValidationResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const listQ = useQuery<ListResponse>({
    queryKey: ['spec-versions', workItemId],
    queryFn: () => api.get(`/work-items/${workItemId}/specifications`).then(r => r.data),
  })
  const versions = listQ.data?.items ?? []
  const activeId = listQ.data?.activeVersionId ?? null
  const currentId = selectedId ?? activeId ?? versions[0]?.id ?? null

  const versionQ = useQuery<Record<string, unknown>>({
    queryKey: ['spec-version', workItemId, currentId],
    enabled: !!currentId,
    queryFn: () => api.get(`/work-items/${workItemId}/specifications/${currentId}`).then(r => r.data),
  })
  const pkg = versionQ.data as any
  const header = (pkg?.version ?? {}) as { status?: string; revision?: number; number?: number; contentHash?: string }
  const editable = header.status === 'DRAFT' || header.status === 'CHANGES_REQUESTED'

  const bodyForEdit = useMemo(() => {
    if (!pkg) return ''
    const body: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(pkg)) if (!HEADER_KEYS.has(k)) body[k] = v
    return JSON.stringify(body, null, 2)
  }, [pkg])

  const refetchAll = () => {
    qc.invalidateQueries({ queryKey: ['spec-versions', workItemId] })
    qc.invalidateQueries({ queryKey: ['spec-version', workItemId] })
  }
  const clearAnd = <T,>(fn: () => T) => { setError(null); return fn() }

  const createMut = useMutation({
    mutationFn: (basedOnVersionId?: string) =>
      api.post(`/work-items/${workItemId}/specifications`, basedOnVersionId ? { basedOnVersionId } : {}).then(r => r.data),
    onSuccess: (data: any) => { setSelectedId(data?.version?.id ?? null); setValidation(null); setEditing(false); refetchAll() },
    onError: (e) => setError(errText(e)),
  })
  const saveMut = useMutation({
    mutationFn: () => {
      const body = JSON.parse(draftJson)
      return api.patch(`/work-items/${workItemId}/specifications/${currentId}`, { ...body, expectedRevision: header.revision ?? 1 }).then(r => r.data)
    },
    onSuccess: () => { setEditing(false); setValidation(null); refetchAll() },
    onError: (e) => setError(e instanceof SyntaxError ? `Invalid JSON: ${e.message}` : errText(e)),
  })
  const validateMut = useMutation({
    mutationFn: () => api.post(`/work-items/${workItemId}/specifications/${currentId}/validate`).then(r => r.data as ValidationResult),
    onSuccess: (d) => { setValidation(d); setError(null) },
    onError: (e) => setError(errText(e)),
  })
  const approveMut = useMutation({
    mutationFn: () => api.post(`/work-items/${workItemId}/specifications/${currentId}/approve`, comment ? { comment } : {}).then(r => r.data),
    onSuccess: () => { setValidation(null); setComment(''); refetchAll() },
    onError: (e) => setError(errText(e)),
  })

  const requirements: any[] = pkg?.requirements ?? []
  const acceptance: any[] = pkg?.acceptanceCriteria ?? []
  const obligations: any[] = pkg?.testObligations ?? []
  const openQuestions: any[] = pkg?.openQuestions ?? []

  return (
    <div>
      {error && (
        <div style={{ ...cardStyle, background: '#fee2e2', border: '1px solid #fecaca', color: '#991b1b', fontSize: 12 }}>{error}</div>
      )}

      <section style={{ ...cardStyle, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h3 style={{ ...sectionTitle, marginBottom: 4 }}>Specification</h3>
          <span style={mutedText}>Author, version and approve the contract this Work Item hands to developers.</span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button style={secondaryButtonStyle} disabled={!currentId || createMut.isPending} onClick={() => clearAnd(() => createMut.mutate(currentId!))}>
            Draft from current
          </button>
          <button style={primaryButtonStyle} disabled={createMut.isPending} onClick={() => clearAnd(() => createMut.mutate(undefined))}>
            {createMut.isPending ? 'Creating…' : 'New draft'}
          </button>
        </div>
      </section>

      {listQ.isLoading ? (
        <p style={mutedText}>Loading specifications…</p>
      ) : versions.length === 0 ? (
        <section style={cardStyle}><p style={mutedText}>No specification versions yet. Create the first draft to begin.</p></section>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(200px, 260px) 1fr', gap: 14, alignItems: 'start' }}>
          {/* Version rail */}
          <section style={cardStyle}>
            <h4 style={{ ...sectionTitle, fontSize: 13 }}>Versions</h4>
            <div style={{ display: 'grid', gap: 6 }}>
              {versions.map((v) => {
                const isCurrent = v.id === currentId
                return (
                  <button
                    key={v.id}
                    onClick={() => { setSelectedId(v.id); setEditing(false); setValidation(null) }}
                    style={{
                      textAlign: 'left', padding: '8px 10px', borderRadius: 9, cursor: 'pointer', fontSize: 12,
                      border: isCurrent ? '1px solid #8b5cf6' : '1px solid var(--color-outline-variant)',
                      background: isCurrent ? '#f5f3ff' : '#fff',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'space-between' }}>
                      <strong style={{ color: 'var(--color-on-surface)' }}>v{v.version}</strong>
                      <span style={badgeStyle('spec', v.status)}>{v.status}</span>
                    </div>
                    <div style={{ ...mutedText, marginTop: 4 }}>
                      {v.requirementCount} reqs · {v.acceptanceCriteriaCount} AC · {v.testObligationCount} tests
                      {v.id === activeId ? ' · active' : ''}
                    </div>
                  </button>
                )
              })}
            </div>
          </section>

          {/* Selected version */}
          <div>
            {versionQ.isLoading || !pkg ? (
              <section style={cardStyle}><p style={mutedText}>Loading version…</p></section>
            ) : (
              <>
                <section style={cardStyle}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <h3 style={{ ...sectionTitle, marginBottom: 0 }}>v{header.number} · rev {header.revision}</h3>
                    <span style={badgeStyle('spec', header.status ?? 'DRAFT')}>{header.status}</span>
                    {header.contentHash && <code style={{ fontSize: 11, color: 'var(--color-outline)' }}>{header.contentHash}</code>}
                  </div>
                  {pkg.summary && <p style={{ fontSize: 13, color: 'var(--color-on-surface)', marginTop: 10 }}>{String(pkg.summary)}</p>}

                  <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                    <button style={secondaryButtonStyle} disabled={validateMut.isPending} onClick={() => clearAnd(() => validateMut.mutate())}>
                      {validateMut.isPending ? 'Validating…' : 'Validate'}
                    </button>
                    {editable && (
                      <button style={secondaryButtonStyle} onClick={() => { setEditing((e) => !e); setDraftJson(bodyForEdit); setError(null) }}>
                        {editing ? 'Cancel edit' : 'Edit (JSON)'}
                      </button>
                    )}
                    {editable && (
                      <>
                        <input
                          style={{ ...inputStyle, width: 200 }}
                          placeholder="Approval comment (optional)"
                          value={comment}
                          onChange={(e) => setComment(e.target.value)}
                        />
                        <button style={primaryButtonStyle} disabled={approveMut.isPending} onClick={() => clearAnd(() => approveMut.mutate())}>
                          {approveMut.isPending ? 'Approving…' : 'Approve'}
                        </button>
                      </>
                    )}
                  </div>
                </section>

                {editing && (
                  <section style={cardStyle}>
                    <h4 style={{ ...sectionTitle, fontSize: 13 }}>Edit specification body (JSON)</h4>
                    <textarea style={monoTextareaStyle} value={draftJson} onChange={(e) => setDraftJson(e.target.value)} spellCheck={false} />
                    <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                      <button style={primaryButtonStyle} disabled={saveMut.isPending} onClick={() => clearAnd(() => saveMut.mutate())}>
                        {saveMut.isPending ? 'Saving…' : 'Save draft'}
                      </button>
                      <span style={mutedText}>Optimistic concurrency: saving from revision {header.revision}.</span>
                    </div>
                  </section>
                )}

                {validation && (
                  <section style={cardStyle}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <h4 style={{ ...sectionTitle, fontSize: 13, marginBottom: 0 }}>Validation</h4>
                      <span style={badgeStyle('run', validation.passed ? 'PASSED' : 'FAILED')}>{validation.passed ? 'PASSED' : 'BLOCKED'}</span>
                      <span style={mutedText}>{validation.errorCount} errors · {validation.warningCount} warnings</span>
                    </div>
                    <div style={{ display: 'grid', gap: 6, marginTop: 10 }}>
                      {validation.checks.map((c) => (
                        <div key={c.id} style={{ display: 'flex', gap: 8, fontSize: 12, alignItems: 'baseline' }}>
                          <span style={{ color: c.passed ? '#16a34a' : c.severity === 'error' ? '#dc2626' : '#d97706', fontWeight: 800 }}>
                            {c.passed ? '✓' : c.severity === 'error' ? '✕' : '!'}
                          </span>
                          <span style={{ color: 'var(--color-on-surface)' }}><strong>{c.id}</strong> — {c.message}</span>
                        </div>
                      ))}
                    </div>
                  </section>
                )}

                <RequirementsTable requirements={requirements} />

                {acceptance.length > 0 && (
                  <section style={cardStyle}>
                    <h4 style={{ ...sectionTitle, fontSize: 13 }}>Acceptance criteria ({acceptance.length})</h4>
                    <Table head={['ID', 'Requirements', 'Criterion']} rows={acceptance.map((a) => [
                      a.id, (a.requirementIds ?? []).join(', '), a.statement ?? a.text ?? a.description ?? '—',
                    ])} />
                  </section>
                )}

                {obligations.length > 0 && (
                  <section style={cardStyle}>
                    <h4 style={{ ...sectionTitle, fontSize: 13 }}>Test obligations ({obligations.length})</h4>
                    <Table head={['ID', 'Verifies', 'Detail']} rows={obligations.map((t) => [
                      t.id, (t.verifies ?? []).join(', '), t.description ?? t.kind ?? '—',
                    ])} />
                  </section>
                )}

                {openQuestions.length > 0 && (
                  <section style={cardStyle}>
                    <h4 style={{ ...sectionTitle, fontSize: 13 }}>Open questions ({openQuestions.length})</h4>
                    <div style={{ display: 'grid', gap: 6 }}>
                      {openQuestions.map((q, i) => (
                        <div key={q.id ?? i} style={{ fontSize: 12, color: 'var(--color-on-surface)' }}>
                          {q.answered ? '☑' : '☐'} {q.question ?? q.text ?? q.id}
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

function RequirementsTable({ requirements }: { requirements: any[] }) {
  return (
    <section style={cardStyle}>
      <h4 style={{ ...sectionTitle, fontSize: 13 }}>Requirements ({requirements.length})</h4>
      {requirements.length === 0 ? (
        <p style={mutedText}>No requirements yet.</p>
      ) : (
        <Table
          head={['ID', 'Priority', 'Statement', 'AC', 'Tests']}
          rows={requirements.map((r) => [
            r.id,
            r.priority ?? '—',
            r.statement ?? r.title ?? '—',
            (r.acceptanceCriterionIds ?? []).join(', ') || '—',
            (r.testObligationIds ?? []).join(', ') || '—',
          ])}
        />
      )}
    </section>
  )
}

function Table({ head, rows }: { head: string[]; rows: (string | number)[][] }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr>{head.map((h) => <th key={h} style={thStyle}>{h}</th>)}</tr></thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>{row.map((cell, j) => <td key={j} style={tdStyle}>{cell}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
