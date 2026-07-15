import { useEffect, useState } from 'react'
import { cardStyle, primaryButtonStyle, secondaryButtonStyle, inputStyle, mutedText, sectionTitle, badgeStyle } from './workspaceStyles'
import { errText } from './errText'
import { useSpecDraft } from './useSpecDraft'
import { DiagramCanvas, type DiagramModel } from './DiagramCanvas'

/**
 * Design surface — the architect's workspace: architecture/flow diagrams (reactflow), design
 * decisions (ADRs — what was decided and why), and the interface contracts. Stored in the
 * versioned spec package (body.diagrams / body.decisions / body.contracts).
 */

const DECISION_STATUSES = ['PROPOSED', 'ACCEPTED', 'SUPERSEDED', 'REJECTED']
const DIAGRAM_KINDS = ['FLOW', 'ARCHITECTURE', 'SEQUENCE', 'STATE', 'ERD', 'CONTEXT']
interface Decision { id: string; title: string; status: string; context?: string; decision: string; consequences?: string; alternatives: string[] }

export function DesignSurface({ workItemId }: { workItemId: string }) {
  const { body, editable, currentId, hasSpec, patchMut, createMut, loading } = useSpecDraft(workItemId)
  const [diagrams, setDiagrams] = useState<DiagramModel[]>([])
  const [decisions, setDecisions] = useState<Decision[]>([])
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setDiagrams((body?.diagrams ?? []) as DiagramModel[])
    setDecisions(((body?.decisions ?? []) as any[]).map((d) => ({ id: d.id, title: d.title ?? '', status: d.status ?? 'PROPOSED', context: d.context, decision: d.decision ?? '', consequences: d.consequences, alternatives: d.alternatives ?? [] })))
    setDirty(false)
  }, [currentId, body])

  const touch = <T,>(fn: () => T) => { setDirty(true); return fn() }
  const save = () => { setError(null); patchMut.mutate({ diagrams, decisions }, { onError: (e) => setError(errText(e)) }) }
  const contracts: any[] = body?.contracts ?? []

  if (loading) return <p style={mutedText}>Loading…</p>
  if (!hasSpec) return <section style={cardStyle}><p style={mutedText}>No specification yet — design lives on the spec. <button style={secondaryButtonStyle} onClick={() => createMut.mutate()}>Create a draft</button></p></section>

  return (
    <div>
      {error && <div style={{ ...cardStyle, background: '#fee2e2', border: '1px solid #fecaca', color: '#991b1b', fontSize: 12 }}>{error}</div>}
      <section style={{ ...cardStyle, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div><h3 style={{ ...sectionTitle, marginBottom: 4 }}>Design</h3><span style={mutedText}>Architecture, flows and the decisions behind them — the shape of the solution.</span></div>
        {editable && <button style={primaryButtonStyle} disabled={!dirty || patchMut.isPending} onClick={save}>{patchMut.isPending ? 'Saving…' : dirty ? 'Save design' : 'Saved'}</button>}
      </section>

      {/* Diagrams */}
      <section style={{ ...cardStyle, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <h4 style={{ ...sectionTitle, fontSize: 14, marginBottom: 0 }}>Architecture & flows</h4>
        {editable && <button style={secondaryButtonStyle} onClick={() => touch(() => setDiagrams((d) => [...d, { id: `D${d.length + 1}`, title: `Diagram ${d.length + 1}`, kind: 'ARCHITECTURE', nodes: [], edges: [] }]))}>+ Diagram</button>}
      </section>
      {diagrams.length === 0 ? <section style={cardStyle}><p style={mutedText}>No diagrams yet.</p></section> : diagrams.map((d, i) => (
        <section key={d.id ?? i} style={cardStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
            {editable ? (<>
              <input style={{ ...inputStyle, width: 240 }} value={d.title ?? ''} onChange={(e) => touch(() => setDiagrams((ds) => ds.map((x, j) => (j === i ? { ...x, title: e.target.value } : x))))} placeholder="Diagram title" />
              <select style={{ ...inputStyle, width: 160 }} value={d.kind ?? 'ARCHITECTURE'} onChange={(e) => touch(() => setDiagrams((ds) => ds.map((x, j) => (j === i ? { ...x, kind: e.target.value } : x))))}>{DIAGRAM_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}</select>
              <button style={{ ...secondaryButtonStyle, marginLeft: 'auto' }} onClick={() => touch(() => setDiagrams((ds) => ds.filter((_, j) => j !== i)))}>Remove</button>
            </>) : (<><h4 style={{ ...sectionTitle, fontSize: 13, marginBottom: 0 }}>{d.title || d.id}</h4><span style={badgeStyle('target', 'PUBLISHED')}>{d.kind ?? 'ARCHITECTURE'}</span></>)}
          </div>
          <DiagramCanvas diagram={d} editable={editable} onChange={editable ? (next) => touch(() => setDiagrams((ds) => ds.map((x, j) => (j === i ? next : x)))) : undefined} />
        </section>
      ))}

      {/* Decisions / ADRs */}
      <section style={{ ...cardStyle, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <div><h4 style={{ ...sectionTitle, fontSize: 14, marginBottom: 4 }}>Design decisions (ADRs)</h4><span style={mutedText}>What was decided, and why — so the choices survive the people.</span></div>
        {editable && <button style={secondaryButtonStyle} onClick={() => touch(() => setDecisions((d) => [...d, { id: `ADR-${d.length + 1}`, title: '', status: 'PROPOSED', decision: '', alternatives: [] }]))}>+ Decision</button>}
      </section>
      {decisions.length === 0 ? <section style={cardStyle}><p style={mutedText}>No decisions recorded.</p></section> : decisions.map((d, i) => {
        const upd = (patch: Partial<Decision>) => touch(() => setDecisions((ds) => ds.map((x, j) => (j === i ? { ...x, ...patch } : x))))
        return (
          <section key={d.id ?? i} style={cardStyle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
              {editable ? (<>
                <input style={{ ...inputStyle, width: 90, padding: '5px 8px', fontFamily: 'ui-monospace, monospace' }} value={d.id} onChange={(e) => upd({ id: e.target.value })} />
                <input style={{ ...inputStyle, padding: '5px 8px' }} value={d.title} placeholder="Decision title" onChange={(e) => upd({ title: e.target.value })} />
                <select style={{ ...inputStyle, width: 130, padding: '5px 8px' }} value={d.status} onChange={(e) => upd({ status: e.target.value })}>{DECISION_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}</select>
                <button style={{ ...secondaryButtonStyle, padding: '4px 8px' }} onClick={() => touch(() => setDecisions((ds) => ds.filter((_, j) => j !== i)))}>✕</button>
              </>) : (<><code style={{ color: 'var(--color-primary)', fontSize: 12 }}>{d.id}</code><strong style={{ fontSize: 13 }}>{d.title}</strong><span style={badgeStyle('spec', d.status === 'ACCEPTED' ? 'APPROVED' : d.status === 'REJECTED' ? 'REJECTED' : 'DRAFT')}>{d.status}</span></>)}
            </div>
            {editable ? (
              <div style={{ display: 'grid', gap: 8 }}>
                <Field label="Context" value={d.context ?? ''} onChange={(v) => upd({ context: v })} />
                <Field label="Decision" value={d.decision} onChange={(v) => upd({ decision: v })} />
                <Field label="Consequences" value={d.consequences ?? ''} onChange={(v) => upd({ consequences: v })} />
                <label style={{ display: 'grid', gap: 4 }}><span style={mutedText}>Alternatives (one per line)</span>
                  <textarea style={{ ...inputStyle, minHeight: 54, resize: 'vertical' }} value={d.alternatives.join('\n')} onChange={(e) => upd({ alternatives: e.target.value.split('\n').map((x) => x.trim()).filter(Boolean) })} /></label>
              </div>
            ) : (
              <div style={{ display: 'grid', gap: 6, fontSize: 12.5, color: 'var(--color-on-surface)', lineHeight: 1.6 }}>
                {d.context && <div><b style={mutedText}>Context.</b> {d.context}</div>}
                <div><b style={mutedText}>Decision.</b> {d.decision || '—'}</div>
                {d.consequences && <div><b style={mutedText}>Consequences.</b> {d.consequences}</div>}
                {d.alternatives.length > 0 && <div><b style={mutedText}>Alternatives.</b> {d.alternatives.join('; ')}</div>}
              </div>
            )}
          </section>
        )
      })}

      {contracts.length > 0 && (
        <section style={cardStyle}>
          <h4 style={{ ...sectionTitle, fontSize: 14 }}>Contracts</h4>
          <div style={{ display: 'grid', gap: 6 }}>
            {contracts.map((c, i) => <div key={c.id ?? i} style={{ fontSize: 12.5, color: 'var(--color-on-surface)' }}><code style={{ color: 'var(--color-primary)' }}>{c.id}</code> · {c.kind}{c.format ? ` (${c.format})` : ''}</div>)}
          </div>
        </section>
      )}
    </div>
  )
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return <label style={{ display: 'grid', gap: 4 }}><span style={mutedText}>{label}</span><textarea style={{ ...inputStyle, minHeight: 52, resize: 'vertical' }} value={value} onChange={(e) => onChange(e.target.value)} /></label>
}
