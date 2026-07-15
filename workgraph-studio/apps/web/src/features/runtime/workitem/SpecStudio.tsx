import { useEffect, useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import {
  cardStyle, primaryButtonStyle, secondaryButtonStyle, inputStyle,
  thStyle, tdStyle, mutedText, sectionTitle, badgeStyle,
} from './workspaceStyles'
import { errText } from './errText'
import { SpecificationEditor } from './SpecificationEditor'
import { DiagramCanvas, type DiagramModel } from './DiagramCanvas'
import { PseudocodePanel } from './PseudocodePanel'
import { CodePanel } from './CodePanel'
import { specQuality } from './specQuality'

/**
 * Spec Studio — the redesigned Specification surface. A first-class authoring workspace for product
 * owners + architects: a quality gauge, a section workbench (Overview / Requirements / Diagrams /
 * Pseudo-code / Code), AI drafting, structured requirement editing, reactflow diagrams, generated
 * pseudo-code, and repository context. All persisted as the versioned spec package.
 */

const HEADER_KEYS = new Set(['schemaVersion', 'workItem', 'version'])
type Section = 'overview' | 'requirements' | 'diagrams' | 'pseudocode' | 'code'
const SECTIONS: { key: Section; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'requirements', label: 'Requirements' },
  { key: 'diagrams', label: 'Diagrams' },
  { key: 'pseudocode', label: 'Pseudo-code' },
  { key: 'code', label: 'Code' },
]

interface VersionSummary { id: string; version: number; revision: number; status: string; contentHash: string | null; requirementCount: number; acceptanceCriteriaCount: number; testObligationCount: number; createdAt: string }
interface ListResponse { items: VersionSummary[]; activeVersionId: string | null }
interface SpecCheck { id: string; passed: boolean; severity: 'error' | 'warning'; message: string }
interface ValidationResult { passed: boolean; errorCount: number; warningCount: number; checks: SpecCheck[] }

export function SpecStudio({ workItemId }: { workItemId: string }) {
  const qc = useQueryClient()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [section, setSection] = useState<Section>('overview')
  const [editingReqs, setEditingReqs] = useState(false)
  const [comment, setComment] = useState('')
  const [validation, setValidation] = useState<ValidationResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [genOpen, setGenOpen] = useState(false)
  const [genPrompt, setGenPrompt] = useState('')
  const [genDocs, setGenDocs] = useState('')
  const [diagrams, setDiagrams] = useState<DiagramModel[] | null>(null) // local working copy while editing

  const listQ = useQuery<ListResponse>({ queryKey: ['spec-versions', workItemId], queryFn: () => api.get(`/work-items/${workItemId}/specifications`).then((r) => r.data) })
  const versions = listQ.data?.items ?? []
  const activeId = listQ.data?.activeVersionId ?? null
  const currentId = selectedId ?? activeId ?? versions[0]?.id ?? null

  const versionQ = useQuery<Record<string, unknown>>({ queryKey: ['spec-version', workItemId, currentId], enabled: !!currentId, queryFn: () => api.get(`/work-items/${workItemId}/specifications/${currentId}`).then((r) => r.data) })
  const pkg = versionQ.data as any
  const header = (pkg?.version ?? {}) as { status?: string; revision?: number; number?: number; contentHash?: string }
  const workItem = (pkg?.workItem ?? {}) as { workCode?: string; title?: string }
  const editable = header.status === 'DRAFT' || header.status === 'CHANGES_REQUESTED'
  const quality = useMemo(() => specQuality(pkg ?? {}, validation?.passed), [pkg, validation])

  // Keep the diagrams working-copy in sync with the loaded version.
  useEffect(() => { setDiagrams(null); setValidation(null); setEditingReqs(false) }, [currentId])
  const storedDiagrams: DiagramModel[] = (pkg?.diagrams ?? []) as DiagramModel[]
  const workingDiagrams = diagrams ?? storedDiagrams
  const diagramsDirty = diagrams !== null

  const editableBody = useMemo(() => {
    const body: Record<string, unknown> = {}
    if (pkg) for (const [k, v] of Object.entries(pkg)) if (!HEADER_KEYS.has(k)) body[k] = v
    return body
  }, [pkg])

  const refetchAll = () => { qc.invalidateQueries({ queryKey: ['spec-versions', workItemId] }); qc.invalidateQueries({ queryKey: ['spec-version', workItemId] }) }
  const clearAnd = <T,>(fn: () => T) => { setError(null); setNote(null); return fn() }

  const createMut = useMutation({ mutationFn: (basedOnVersionId?: string) => api.post(`/work-items/${workItemId}/specifications`, basedOnVersionId ? { basedOnVersionId } : {}).then((r) => r.data), onSuccess: (d: any) => { setSelectedId(d?.version?.id ?? null); setSection('requirements'); refetchAll() }, onError: (e) => setError(errText(e)) })
  const generateMut = useMutation({
    mutationFn: () => api.post(`/work-items/${workItemId}/specifications/generate`, { prompt: genPrompt, documents: genDocs.trim() ? [{ title: 'Pasted context', content: genDocs }] : undefined }).then((r) => r.data),
    onSuccess: (d: any) => { setGenOpen(false); setGenPrompt(''); setGenDocs(''); setSelectedId(d?.specification?.version?.id ?? null); setSection('requirements'); setNote(d?.repaired ? 'Draft generated (auto-repaired a blocking issue). Review before approving.' : 'Draft generated. Review before approving.'); refetchAll() },
    onError: (e) => setError(errText(e)),
  })
  const saveMut = useMutation({ mutationFn: (body: Record<string, unknown>) => api.patch(`/work-items/${workItemId}/specifications/${currentId}`, { ...body, expectedRevision: header.revision ?? 1 }).then((r) => r.data), onSuccess: () => { setEditingReqs(false); setDiagrams(null); setValidation(null); refetchAll() }, onError: (e) => setError(errText(e)) })
  const validateMut = useMutation({ mutationFn: () => api.post(`/work-items/${workItemId}/specifications/${currentId}/validate`).then((r) => r.data as ValidationResult), onSuccess: (d) => { setValidation(d); setNote(null); setError(null) }, onError: (e) => setError(errText(e)) })
  const approveMut = useMutation({ mutationFn: () => api.post(`/work-items/${workItemId}/specifications/${currentId}/approve`, comment ? { comment } : {}).then((r) => r.data), onSuccess: () => { setValidation(null); setComment(''); refetchAll() }, onError: (e) => setError(errText(e)) })

  const requirements: any[] = pkg?.requirements ?? []

  return (
    <div>
      {error && <div style={{ ...cardStyle, background: '#fee2e2', border: '1px solid #fecaca', color: '#991b1b', fontSize: 12 }}>{error}</div>}
      {note && <div style={{ ...cardStyle, background: '#ecfdf5', border: '1px solid #a7f3d0', color: '#065f46', fontSize: 12 }}>{note}</div>}

      {/* Studio header */}
      <section style={{ ...cardStyle, background: 'linear-gradient(180deg, var(--color-surface-bright), var(--color-surface-low))' }}>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
            {pkg && <QualityRing score={quality.score} grade={quality.grade} />}
            <div>
              <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 0.4, color: 'var(--color-primary)' }}>SPEC STUDIO</div>
              <h2 style={{ margin: '2px 0 4px', fontSize: 18, color: 'var(--color-on-surface)' }}>{workItem.title || workItem.workCode || 'Specification'}</h2>
              {pkg ? (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 12 }}>
                  <span style={badgeStyle('spec', header.status ?? 'DRAFT')}>{header.status}</span>
                  <VersionSelect versions={versions} activeId={activeId} currentId={currentId} onSelect={(id) => setSelectedId(id)} />
                  {header.contentHash && <code style={{ fontSize: 11, color: 'var(--color-outline)' }}>{header.contentHash}</code>}
                </div>
              ) : <span style={mutedText}>No specification yet — draft one to begin.</span>}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {editable && <button style={secondaryButtonStyle} disabled={validateMut.isPending} onClick={() => clearAnd(() => validateMut.mutate())}>{validateMut.isPending ? 'Validating…' : 'Validate'}</button>}
            <button style={secondaryButtonStyle} disabled={createMut.isPending} onClick={() => clearAnd(() => createMut.mutate(currentId ?? undefined))}>New draft</button>
            <button style={primaryButtonStyle} onClick={() => { setGenOpen((o) => !o); setError(null); setNote(null) }}>{genOpen ? 'Cancel' : 'Generate with AI'}</button>
            {editable && (
              <>
                <input style={{ ...inputStyle, width: 170 }} placeholder="Approval comment" value={comment} onChange={(e) => setComment(e.target.value)} />
                <button style={primaryButtonStyle} disabled={approveMut.isPending} onClick={() => clearAnd(() => approveMut.mutate())}>{approveMut.isPending ? 'Approving…' : 'Approve'}</button>
              </>
            )}
          </div>
        </div>
      </section>

      {genOpen && (
        <section style={cardStyle}>
          <h4 style={{ ...sectionTitle, fontSize: 13 }}>Generate a draft specification</h4>
          <span style={mutedText}>Describe what to build; attach any context. The model drafts a versioned spec you review and approve.</span>
          <textarea style={{ ...inputStyle, minHeight: 84, marginTop: 10, resize: 'vertical' }} placeholder="e.g. A password reset flow: email a signed link, expire in 30 minutes, rate-limit requests…" value={genPrompt} onChange={(e) => setGenPrompt(e.target.value)} />
          <textarea style={{ ...inputStyle, minHeight: 84, marginTop: 8, resize: 'vertical', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }} placeholder="Optional: paste a PRD, ticket, or notes…" value={genDocs} onChange={(e) => setGenDocs(e.target.value)} />
          <button style={{ ...primaryButtonStyle, marginTop: 10 }} disabled={!genPrompt.trim() || generateMut.isPending} onClick={() => clearAnd(() => generateMut.mutate())}>{generateMut.isPending ? 'Generating…' : 'Generate draft'}</button>
        </section>
      )}

      {!pkg ? (
        !genOpen && <section style={cardStyle}><p style={mutedText}>No specification version yet. Use “New draft” or “Generate with AI”.</p></section>
      ) : (
        <>
          {/* Section nav */}
          <div style={{ display: 'flex', gap: 6, margin: '4px 0 14px', flexWrap: 'wrap' }}>
            {SECTIONS.map((s) => {
              const active = section === s.key
              const count = s.key === 'requirements' ? requirements.length : s.key === 'diagrams' ? storedDiagrams.length : s.key === 'pseudocode' ? (pkg.pseudocode ?? []).length : null
              return (
                <button key={s.key} onClick={() => setSection(s.key)} style={{
                  padding: '7px 14px', borderRadius: 999, cursor: 'pointer', fontSize: 13, fontWeight: active ? 800 : 600,
                  border: active ? '1px solid var(--color-primary)' : '1px solid var(--color-outline-variant)',
                  background: active ? 'var(--color-primary-dim)' : 'var(--color-surface-bright)',
                  color: active ? 'var(--color-primary-dark)' : 'var(--color-on-surface)',
                }}>{s.label}{count != null ? ` · ${count}` : ''}</button>
              )
            })}
          </div>

          {validation && section !== 'code' && <ValidationPanel validation={validation} />}

          {section === 'overview' && <OverviewSection pkg={pkg} quality={quality} />}

          {section === 'requirements' && (
            <div>
              {editable && (
                <div style={{ marginBottom: 10 }}>
                  <button style={secondaryButtonStyle} onClick={() => setEditingReqs((e) => !e)}>{editingReqs ? 'Cancel edit' : 'Edit requirements'}</button>
                </div>
              )}
              {editingReqs ? (
                <SpecificationEditor initialBody={editableBody} revision={header.revision ?? 1} saving={saveMut.isPending} onSave={(body) => clearAnd(() => saveMut.mutate(body))} onCancel={() => setEditingReqs(false)} />
              ) : (
                <RequirementsView pkg={pkg} />
              )}
            </div>
          )}

          {section === 'diagrams' && (
            <DiagramsSection
              diagrams={workingDiagrams}
              editable={editable}
              dirty={diagramsDirty}
              saving={saveMut.isPending}
              onChange={(next) => setDiagrams(next)}
              onSave={() => clearAnd(() => saveMut.mutate({ diagrams: workingDiagrams }))}
              onReset={() => setDiagrams(null)}
            />
          )}

          {section === 'pseudocode' && currentId && (
            <PseudocodePanel workItemId={workItemId} versionId={currentId} editable={editable} modules={pkg.pseudocode ?? []} requirements={requirements} onChanged={refetchAll} />
          )}

          {section === 'code' && <CodePanel workItemId={workItemId} />}
        </>
      )}
    </div>
  )
}

function QualityRing({ score, grade }: { score: number; grade: string }) {
  const r = 26, c = 2 * Math.PI * r, off = c * (1 - Math.max(0, Math.min(100, score)) / 100)
  const color = score >= 80 ? 'var(--color-success)' : score >= 55 ? 'var(--color-warning)' : 'var(--color-danger)'
  return (
    <svg width="68" height="68" viewBox="0 0 68 68" style={{ flexShrink: 0 }}>
      <circle cx="34" cy="34" r={r} fill="none" stroke="var(--color-outline-variant)" strokeWidth="6" />
      <circle cx="34" cy="34" r={r} fill="none" stroke={color} strokeWidth="6" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={off} transform="rotate(-90 34 34)" />
      <text x="34" y="31" textAnchor="middle" fontSize="15" fontWeight="800" fill="var(--color-on-surface)">{score}</text>
      <text x="34" y="45" textAnchor="middle" fontSize="10" fontWeight="700" fill="var(--color-outline)">{grade}</text>
    </svg>
  )
}

function VersionSelect({ versions, activeId, currentId, onSelect }: { versions: VersionSummary[]; activeId: string | null; currentId: string | null; onSelect: (id: string) => void }) {
  if (!versions.length) return null
  return (
    <select style={{ ...inputStyle, width: 'auto', padding: '4px 8px' }} value={currentId ?? ''} onChange={(e) => onSelect(e.target.value)}>
      {versions.map((v) => <option key={v.id} value={v.id}>v{v.version} · {v.status}{v.id === activeId ? ' · active' : ''}</option>)}
    </select>
  )
}

function ValidationPanel({ validation }: { validation: ValidationResult }) {
  return (
    <section style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <h4 style={{ ...sectionTitle, fontSize: 13, marginBottom: 0 }}>Validation</h4>
        <span style={badgeStyle('run', validation.passed ? 'PASSED' : 'FAILED')}>{validation.passed ? 'PASSED' : 'BLOCKED'}</span>
        <span style={mutedText}>{validation.errorCount} errors · {validation.warningCount} warnings</span>
      </div>
      <div style={{ display: 'grid', gap: 6, marginTop: 10 }}>
        {validation.checks.map((c) => (
          <div key={c.id} style={{ display: 'flex', gap: 8, fontSize: 12, alignItems: 'baseline' }}>
            <span style={{ color: c.passed ? '#16a34a' : c.severity === 'error' ? '#dc2626' : '#d97706', fontWeight: 800 }}>{c.passed ? '✓' : c.severity === 'error' ? '✕' : '!'}</span>
            <span style={{ color: 'var(--color-on-surface)' }}><strong>{c.id}</strong> — {c.message}</span>
          </div>
        ))}
      </div>
    </section>
  )
}

function OverviewSection({ pkg, quality }: { pkg: any; quality: ReturnType<typeof specQuality> }) {
  const openQuestions: any[] = (pkg.openQuestions ?? []).filter((q: any) => !q.answered)
  return (
    <>
      <section style={cardStyle}>
        <h4 style={{ ...sectionTitle, fontSize: 13 }}>Summary</h4>
        <p style={{ fontSize: 13, color: pkg.summary ? 'var(--color-on-surface)' : 'var(--color-outline)' }}>{pkg.summary || 'No summary yet.'}</p>
        <div style={{ display: 'flex', gap: 16, marginTop: 12, flexWrap: 'wrap', fontSize: 12 }}>
          <Stat label="Requirements" value={(pkg.requirements ?? []).length} />
          <Stat label="Acceptance" value={(pkg.acceptanceCriteria ?? []).length} />
          <Stat label="Tests" value={(pkg.testObligations ?? []).length} />
          <Stat label="Diagrams" value={(pkg.diagrams ?? []).length} />
          <Stat label="Pseudo-code" value={(pkg.pseudocode ?? []).length} />
        </div>
      </section>
      <section style={cardStyle}>
        <h4 style={{ ...sectionTitle, fontSize: 13 }}>Readiness · {quality.score}% ({quality.grade})</h4>
        <div style={{ display: 'grid', gap: 8, marginTop: 6 }}>
          {quality.factors.map((f) => (
            <div key={f.label} style={{ display: 'grid', gridTemplateColumns: '180px 1fr 40px', gap: 10, alignItems: 'center', fontSize: 12 }}>
              <span style={{ color: 'var(--color-on-surface)' }}>{f.label}</span>
              <div style={{ height: 7, borderRadius: 999, background: 'var(--color-outline-variant)', overflow: 'hidden' }}>
                <div style={{ width: `${f.pct}%`, height: '100%', background: f.pct >= 80 ? 'var(--color-success)' : f.pct >= 40 ? 'var(--color-warning)' : 'var(--color-danger)' }} />
              </div>
              <span style={{ ...mutedText, textAlign: 'right' }}>{f.pct}%</span>
            </div>
          ))}
        </div>
      </section>
      {openQuestions.length > 0 && (
        <section style={cardStyle}>
          <h4 style={{ ...sectionTitle, fontSize: 13 }}>Open questions ({openQuestions.length})</h4>
          <div style={{ display: 'grid', gap: 6 }}>
            {openQuestions.map((q, i) => <div key={q.id ?? i} style={{ fontSize: 12, color: 'var(--color-on-surface)' }}>☐ {q.question ?? q.id}</div>)}
          </div>
        </section>
      )}
    </>
  )
}

function RequirementsView({ pkg }: { pkg: any }) {
  const requirements: any[] = pkg.requirements ?? []
  const acceptance: any[] = pkg.acceptanceCriteria ?? []
  const obligations: any[] = pkg.testObligations ?? []
  const acText = (a: any) => a.statement ?? a.text ?? ([...(a.given ?? []), ...(a.when ?? []), ...(a.then ?? [])].join(' / ') || '—')
  return (
    <>
      <section style={cardStyle}>
        <h4 style={{ ...sectionTitle, fontSize: 13 }}>Requirements ({requirements.length})</h4>
        {requirements.length === 0 ? <p style={mutedText}>No requirements yet.</p> : (
          <Table head={['ID', 'Priority', 'Statement', 'AC', 'Tests']} rows={requirements.map((r) => [r.id, r.priority ?? '—', r.statement ?? '—', (r.acceptanceCriterionIds ?? []).join(', ') || '—', (r.testObligationIds ?? []).join(', ') || '—'])} />
        )}
      </section>
      {acceptance.length > 0 && (
        <section style={cardStyle}><h4 style={{ ...sectionTitle, fontSize: 13 }}>Acceptance criteria ({acceptance.length})</h4>
          <Table head={['ID', 'Requirements', 'Criterion']} rows={acceptance.map((a) => [a.id, (a.requirementIds ?? []).join(', '), acText(a)])} />
        </section>
      )}
      {obligations.length > 0 && (
        <section style={cardStyle}><h4 style={{ ...sectionTitle, fontSize: 13 }}>Test obligations ({obligations.length})</h4>
          <Table head={['ID', 'Verifies', 'Detail']} rows={obligations.map((t) => [t.id, (t.verifies ?? []).join(', '), t.description ?? t.kind ?? '—'])} />
        </section>
      )}
    </>
  )
}

function DiagramsSection({ diagrams, editable, dirty, saving, onChange, onSave, onReset }: {
  diagrams: DiagramModel[]; editable: boolean; dirty: boolean; saving: boolean
  onChange: (next: DiagramModel[]) => void; onSave: () => void; onReset: () => void
}) {
  const addDiagram = () => onChange([...diagrams, { id: `D${diagrams.length + 1}`, title: `Diagram ${diagrams.length + 1}`, kind: 'FLOW', nodes: [], edges: [] }])
  const patch = (i: number, d: DiagramModel) => onChange(diagrams.map((x, j) => (j === i ? d : x)))
  const remove = (i: number) => onChange(diagrams.filter((_, j) => j !== i))
  return (
    <div>
      <section style={{ ...cardStyle, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <div><h4 style={{ ...sectionTitle, fontSize: 14, marginBottom: 4 }}>Diagrams</h4><span style={mutedText}>Flows, context, and architecture — versioned with the spec.</span></div>
        {editable && (
          <div style={{ display: 'flex', gap: 8 }}>
            <button style={secondaryButtonStyle} onClick={addDiagram}>+ Diagram</button>
            {dirty && <button style={secondaryButtonStyle} onClick={onReset}>Discard</button>}
            {dirty && <button style={primaryButtonStyle} disabled={saving} onClick={onSave}>{saving ? 'Saving…' : 'Save diagrams'}</button>}
          </div>
        )}
      </section>
      {diagrams.length === 0 ? (
        <section style={cardStyle}><p style={mutedText}>No diagrams yet.{editable ? ' Add one to sketch a flow or architecture.' : ''}</p></section>
      ) : diagrams.map((d, i) => (
        <section key={d.id ?? i} style={cardStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
            {editable ? (
              <>
                <input style={{ ...inputStyle, width: 240 }} value={d.title ?? ''} onChange={(e) => patch(i, { ...d, title: e.target.value })} placeholder="Diagram title" />
                <select style={{ ...inputStyle, width: 150 }} value={d.kind ?? 'FLOW'} onChange={(e) => patch(i, { ...d, kind: e.target.value })}>
                  {['FLOW', 'ARCHITECTURE', 'SEQUENCE', 'STATE', 'ERD', 'CONTEXT'].map((k) => <option key={k} value={k}>{k}</option>)}
                </select>
                <button style={{ ...secondaryButtonStyle, marginLeft: 'auto' }} onClick={() => remove(i)}>Remove</button>
              </>
            ) : (
              <><h4 style={{ ...sectionTitle, fontSize: 13, marginBottom: 0 }}>{d.title || d.id}</h4><span style={badgeStyle('target', 'PUBLISHED')}>{d.kind ?? 'FLOW'}</span></>
            )}
          </div>
          <DiagramCanvas diagram={d} editable={editable} onChange={editable ? (next) => patch(i, next) : undefined} />
        </section>
      ))}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 5 }}><strong style={{ fontSize: 16, color: 'var(--color-on-surface)' }}>{value}</strong><span style={mutedText}>{label}</span></span>
}

function Table({ head, rows }: { head: string[]; rows: (string | number)[][] }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr>{head.map((h) => <th key={h} style={thStyle}>{h}</th>)}</tr></thead>
        <tbody>{rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j} style={tdStyle}>{cell}</td>)}</tr>)}</tbody>
      </table>
    </div>
  )
}
