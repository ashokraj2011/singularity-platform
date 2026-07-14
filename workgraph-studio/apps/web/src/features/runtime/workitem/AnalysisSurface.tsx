import { useEffect, useState } from 'react'
import { cardStyle, primaryButtonStyle, secondaryButtonStyle, inputStyle, mutedText, sectionTitle } from './workspaceStyles'
import { errText } from './errText'
import { useSpecDraft } from './useSpecDraft'

/**
 * Analysis surface — the upstream "why", captured before requirements: the problem, goals,
 * stakeholders, assumptions and constraints. A product owner / analyst authors it; requirements
 * trace back to it. Stored in the versioned spec package (body.analysis).
 */

interface Stakeholder { role: string; name?: string; interest?: string }
interface Analysis { problem: string; goals: string[]; stakeholders: Stakeholder[]; assumptions: string[]; constraints: string[] }
const empty: Analysis = { problem: '', goals: [], stakeholders: [], assumptions: [], constraints: [] }
const lines = (a: string[]) => a.join('\n')
const toLines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean)

export function AnalysisSurface({ workItemId }: { workItemId: string }) {
  const { body, editable, currentId, hasSpec, patchMut, createMut, loading } = useSpecDraft(workItemId)
  const [a, setA] = useState<Analysis>(empty)
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const src = (body?.analysis ?? {}) as Partial<Analysis>
    setA({ problem: src.problem ?? '', goals: src.goals ?? [], stakeholders: src.stakeholders ?? [], assumptions: src.assumptions ?? [], constraints: src.constraints ?? [] })
    setDirty(false)
  }, [currentId, body])

  const edit = (patch: Partial<Analysis>) => { setA((p) => ({ ...p, ...patch })); setDirty(true) }
  const save = () => { setError(null); patchMut.mutate({ analysis: a }, { onError: (e) => setError(errText(e)) }) }

  if (loading) return <p style={mutedText}>Loading…</p>
  if (!hasSpec) return <section style={cardStyle}><p style={mutedText}>No specification yet — analysis lives on the spec. <button style={secondaryButtonStyle} onClick={() => createMut.mutate()}>Create a draft</button></p></section>

  const ro = !editable

  return (
    <div>
      {error && <div style={{ ...cardStyle, background: '#fee2e2', border: '1px solid #fecaca', color: '#991b1b', fontSize: 12 }}>{error}</div>}
      <section style={{ ...cardStyle, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div><h3 style={{ ...sectionTitle, marginBottom: 4 }}>Analysis</h3><span style={mutedText}>The problem, goals and constraints — the why behind this work, before requirements.</span></div>
        {editable && <button style={primaryButtonStyle} disabled={!dirty || patchMut.isPending} onClick={save}>{patchMut.isPending ? 'Saving…' : dirty ? 'Save analysis' : 'Saved'}</button>}
      </section>

      <section style={cardStyle}>
        <h4 style={{ ...sectionTitle, fontSize: 13 }}>Problem statement</h4>
        {ro ? <p style={{ fontSize: 13, color: a.problem ? 'var(--color-on-surface)' : 'var(--color-outline)', lineHeight: 1.6 }}>{a.problem || 'Not captured.'}</p>
          : <textarea style={{ ...inputStyle, minHeight: 96, resize: 'vertical' }} value={a.problem} placeholder="What problem are we solving, and why now?" onChange={(e) => edit({ problem: e.target.value })} />}
      </section>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 14 }}>
        <ListCard title="Goals & outcomes" values={a.goals} ro={ro} placeholder="One goal per line…" onChange={(v) => edit({ goals: v })} />
        <ListCard title="Assumptions" values={a.assumptions} ro={ro} placeholder="One assumption per line…" onChange={(v) => edit({ assumptions: v })} />
        <ListCard title="Constraints" values={a.constraints} ro={ro} placeholder="One constraint per line…" onChange={(v) => edit({ constraints: v })} />
      </div>

      <section style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <h4 style={{ ...sectionTitle, fontSize: 13, marginBottom: 0 }}>Stakeholders</h4>
          {!ro && <button style={{ ...secondaryButtonStyle, padding: '5px 10px' }} onClick={() => edit({ stakeholders: [...a.stakeholders, { role: '' }] })}>+ Add</button>}
        </div>
        {a.stakeholders.length === 0 ? <p style={mutedText}>None yet.</p> : (
          <div style={{ display: 'grid', gap: 6 }}>
            {a.stakeholders.map((s, i) => (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: ro ? '150px 1fr' : '150px 150px 1fr auto', gap: 8, alignItems: 'center' }}>
                {ro ? <><strong style={{ fontSize: 12 }}>{s.role}</strong><span style={{ fontSize: 12, color: 'var(--color-outline)' }}>{[s.name, s.interest].filter(Boolean).join(' · ') || '—'}</span></> : (<>
                  <input style={{ ...inputStyle, padding: '5px 8px' }} placeholder="Role" value={s.role} onChange={(e) => edit({ stakeholders: a.stakeholders.map((x, j) => (j === i ? { ...x, role: e.target.value } : x)) })} />
                  <input style={{ ...inputStyle, padding: '5px 8px' }} placeholder="Name" value={s.name ?? ''} onChange={(e) => edit({ stakeholders: a.stakeholders.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
                  <input style={{ ...inputStyle, padding: '5px 8px' }} placeholder="Interest / stake" value={s.interest ?? ''} onChange={(e) => edit({ stakeholders: a.stakeholders.map((x, j) => (j === i ? { ...x, interest: e.target.value } : x)) })} />
                  <button style={{ ...secondaryButtonStyle, padding: '4px 8px' }} onClick={() => edit({ stakeholders: a.stakeholders.filter((_, j) => j !== i) })}>✕</button>
                </>)}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

function ListCard({ title, values, ro, placeholder, onChange }: { title: string; values: string[]; ro: boolean; placeholder: string; onChange: (v: string[]) => void }) {
  return (
    <section style={cardStyle}>
      <h4 style={{ ...sectionTitle, fontSize: 13 }}>{title}</h4>
      {ro ? (
        values.length ? <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: 'var(--color-on-surface)', lineHeight: 1.7 }}>{values.map((v, i) => <li key={i}>{v}</li>)}</ul> : <p style={mutedText}>None.</p>
      ) : (
        <textarea style={{ ...inputStyle, minHeight: 96, resize: 'vertical', fontSize: 12.5, lineHeight: 1.6 }} value={lines(values)} placeholder={placeholder} onChange={(e) => onChange(toLines(e.target.value))} />
      )}
    </section>
  )
}
