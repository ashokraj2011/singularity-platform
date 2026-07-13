import { useState, type CSSProperties } from 'react'
import {
  cardStyle, primaryButtonStyle, secondaryButtonStyle, inputStyle, monoTextareaStyle,
  thStyle, tdStyle, mutedText, sectionTitle,
} from './workspaceStyles'

/**
 * Structured specification editor — an inline grid for the requirements / acceptance criteria /
 * test obligations, replacing the raw-JSON textarea. Keeps a JSON escape hatch (for the sections
 * the grid doesn't surface: sources, contracts, risks, open questions), and preserves those
 * sections untouched on save by spreading the original body. Emits the assembled body to onSave;
 * the parent handles the PATCH + optimistic concurrency.
 */

const PRIORITIES = ['MUST', 'SHOULD', 'COULD']

interface Requirement { id: string; priority: string; statement: string; sourceIds: string[]; acceptanceCriterionIds: string[]; testObligationIds: string[] }
interface AcceptanceCriterion { id: string; requirementIds: string[]; statement: string }
interface TestObligation { id: string; verifies: string[]; description: string }

const csv = (a: string[]) => a.join(', ')
const parseCsv = (s: string) => s.split(',').map((t) => t.trim()).filter(Boolean)

function normalizeReqs(arr: any): Requirement[] {
  return (Array.isArray(arr) ? arr : []).map((r) => ({
    id: String(r?.id ?? ''),
    priority: PRIORITIES.includes(r?.priority) ? r.priority : 'SHOULD',
    statement: String(r?.statement ?? r?.title ?? ''),
    sourceIds: Array.isArray(r?.sourceIds) ? r.sourceIds.map(String) : [],
    acceptanceCriterionIds: Array.isArray(r?.acceptanceCriterionIds) ? r.acceptanceCriterionIds.map(String) : [],
    testObligationIds: Array.isArray(r?.testObligationIds) ? r.testObligationIds.map(String) : [],
  }))
}
function normalizeAcs(arr: any): AcceptanceCriterion[] {
  return (Array.isArray(arr) ? arr : []).map((a) => ({
    id: String(a?.id ?? ''),
    requirementIds: Array.isArray(a?.requirementIds) ? a.requirementIds.map(String) : [],
    statement: String(a?.statement ?? a?.text ?? a?.description ?? ''),
  }))
}
function normalizeObs(arr: any): TestObligation[] {
  return (Array.isArray(arr) ? arr : []).map((t) => ({
    id: String(t?.id ?? ''),
    verifies: Array.isArray(t?.verifies) ? t.verifies.map(String) : [],
    description: String(t?.description ?? ''),
  }))
}

const cellInput: CSSProperties = { ...inputStyle, padding: '5px 7px', fontSize: 12 }

export function SpecificationEditor({ initialBody, revision, saving, onSave, onCancel }: {
  initialBody: any
  revision: number
  saving: boolean
  onSave: (body: any) => void
  onCancel: () => void
}) {
  const [summary, setSummary] = useState(String(initialBody?.summary ?? ''))
  const [requirements, setRequirements] = useState<Requirement[]>(() => normalizeReqs(initialBody?.requirements))
  const [acceptance, setAcceptance] = useState<AcceptanceCriterion[]>(() => normalizeAcs(initialBody?.acceptanceCriteria))
  const [obligations, setObligations] = useState<TestObligation[]>(() => normalizeObs(initialBody?.testObligations))
  const [jsonMode, setJsonMode] = useState(false)
  const [jsonText, setJsonText] = useState('')
  const [jsonError, setJsonError] = useState<string | null>(null)

  const assemble = () => ({ ...initialBody, summary, requirements, acceptanceCriteria: acceptance, testObligations: obligations })

  const patchReq = (i: number, patch: Partial<Requirement>) => setRequirements((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const patchAc = (i: number, patch: Partial<AcceptanceCriterion>) => setAcceptance((as) => as.map((a, j) => (j === i ? { ...a, ...patch } : a)))
  const patchOb = (i: number, patch: Partial<TestObligation>) => setObligations((os) => os.map((o, j) => (j === i ? { ...o, ...patch } : o)))

  const enterJson = () => { setJsonText(JSON.stringify(assemble(), null, 2)); setJsonError(null); setJsonMode(true) }
  const applyJson = () => {
    try {
      const p = JSON.parse(jsonText)
      setSummary(String(p?.summary ?? ''))
      setRequirements(normalizeReqs(p?.requirements))
      setAcceptance(normalizeAcs(p?.acceptanceCriteria))
      setObligations(normalizeObs(p?.testObligations))
      setJsonError(null)
      setJsonMode(false)
    } catch (e) { setJsonError(`Invalid JSON: ${(e as Error).message}`) }
  }
  const save = () => {
    if (jsonMode) {
      try { onSave(JSON.parse(jsonText)) } catch (e) { setJsonError(`Invalid JSON: ${(e as Error).message}`) }
    } else onSave(assemble())
  }

  return (
    <section style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <h4 style={{ ...sectionTitle, fontSize: 13, marginBottom: 0 }}>Edit specification</h4>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={mutedText}>Saving from revision {revision}.</span>
          <button style={secondaryButtonStyle} onClick={() => (jsonMode ? applyJson() : enterJson())}>
            {jsonMode ? 'Back to grid' : 'Edit as JSON'}
          </button>
        </div>
      </div>

      {jsonError && <div style={{ ...cardStyle, marginTop: 10, background: '#fee2e2', border: '1px solid #fecaca', color: '#991b1b', fontSize: 12 }}>{jsonError}</div>}

      {jsonMode ? (
        <textarea style={{ ...monoTextareaStyle, marginTop: 10 }} value={jsonText} onChange={(e) => setJsonText(e.target.value)} spellCheck={false} />
      ) : (
        <>
          <label style={{ display: 'grid', gap: 4, marginTop: 12 }}>
            <span style={mutedText}>Summary</span>
            <textarea style={{ ...inputStyle, minHeight: 52, resize: 'vertical' }} value={summary} onChange={(e) => setSummary(e.target.value)} />
          </label>

          <GridSection
            title="Requirements"
            head={['ID', 'Priority', 'Statement', 'Sources', 'AC refs', 'Test refs', '']}
            rows={requirements}
            onAdd={() => setRequirements((rs) => [...rs, { id: `REQ-${rs.length + 1}`, priority: 'SHOULD', statement: '', sourceIds: [], acceptanceCriterionIds: [], testObligationIds: [] }])}
            onRemove={(i) => setRequirements((rs) => rs.filter((_, j) => j !== i))}
            render={(r, i) => [
              <input style={cellInput} value={r.id} onChange={(e) => patchReq(i, { id: e.target.value })} />,
              <select style={cellInput} value={r.priority} onChange={(e) => patchReq(i, { priority: e.target.value })}>{PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}</select>,
              <input style={cellInput} value={r.statement} onChange={(e) => patchReq(i, { statement: e.target.value })} />,
              <input style={cellInput} value={csv(r.sourceIds)} onChange={(e) => patchReq(i, { sourceIds: parseCsv(e.target.value) })} />,
              <input style={cellInput} value={csv(r.acceptanceCriterionIds)} onChange={(e) => patchReq(i, { acceptanceCriterionIds: parseCsv(e.target.value) })} />,
              <input style={cellInput} value={csv(r.testObligationIds)} onChange={(e) => patchReq(i, { testObligationIds: parseCsv(e.target.value) })} />,
            ]}
          />

          <GridSection
            title="Acceptance criteria"
            head={['ID', 'Requirement refs', 'Statement', '']}
            rows={acceptance}
            onAdd={() => setAcceptance((as) => [...as, { id: `AC-${as.length + 1}`, requirementIds: [], statement: '' }])}
            onRemove={(i) => setAcceptance((as) => as.filter((_, j) => j !== i))}
            render={(a, i) => [
              <input style={cellInput} value={a.id} onChange={(e) => patchAc(i, { id: e.target.value })} />,
              <input style={cellInput} value={csv(a.requirementIds)} onChange={(e) => patchAc(i, { requirementIds: parseCsv(e.target.value) })} />,
              <input style={cellInput} value={a.statement} onChange={(e) => patchAc(i, { statement: e.target.value })} />,
            ]}
          />

          <GridSection
            title="Test obligations"
            head={['ID', 'Verifies', 'Description', '']}
            rows={obligations}
            onAdd={() => setObligations((os) => [...os, { id: `T-${os.length + 1}`, verifies: [], description: '' }])}
            onRemove={(i) => setObligations((os) => os.filter((_, j) => j !== i))}
            render={(o, i) => [
              <input style={cellInput} value={o.id} onChange={(e) => patchOb(i, { id: e.target.value })} />,
              <input style={cellInput} value={csv(o.verifies)} onChange={(e) => patchOb(i, { verifies: parseCsv(e.target.value) })} />,
              <input style={cellInput} value={o.description} onChange={(e) => patchOb(i, { description: e.target.value })} />,
            ]}
          />
        </>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
        <button style={primaryButtonStyle} disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save draft'}</button>
        <button style={secondaryButtonStyle} onClick={onCancel}>Cancel</button>
      </div>
    </section>
  )
}

function GridSection<T>({ title, head, rows, render, onAdd, onRemove }: {
  title: string
  head: string[]
  rows: T[]
  render: (row: T, index: number) => React.ReactNode[]
  onAdd: () => void
  onRemove: (index: number) => void
}) {
  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <h5 style={{ margin: 0, fontSize: 12, fontWeight: 800, color: 'var(--color-outline)' }}>{title} ({rows.length})</h5>
        <button style={{ ...secondaryButtonStyle, padding: '5px 10px' }} onClick={onAdd}>+ Add</button>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>{head.map((h, i) => <th key={i} style={thStyle}>{h}</th>)}</tr></thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                {render(row, i).map((cell, j) => <td key={j} style={tdStyle}>{cell}</td>)}
                <td style={tdStyle}>
                  <button style={{ ...secondaryButtonStyle, padding: '4px 8px' }} title="Remove" onClick={() => onRemove(i)}>✕</button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td style={{ ...tdStyle, color: 'var(--color-outline)' }} colSpan={head.length}>None yet — use “+ Add”.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  )
}
