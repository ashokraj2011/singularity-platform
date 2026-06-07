/**
 * Planner — describe a goal, an agent (context-fabric) breaks it into work
 * items (some assignable to child capabilities), an independent critic reviews
 * the breakdown, you edit, then commit. Committed items appear in the Inbox of
 * each owning capability.
 *
 * Two server calls: POST /planner/breakdown (preview, creates nothing) and
 * POST /planner/commit (creates the work items).
 */
import { useState, type CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import { Sparkles, Plus, Trash2, AlertTriangle, CheckCircle2, XCircle, Loader2 } from 'lucide-react'
import { api } from '../../lib/api'
import { useActiveContextStore } from '../../store/activeContext.store'

const URGENCIES = ['LOW', 'NORMAL', 'HIGH', 'CRITICAL'] as const
type Urgency = (typeof URGENCIES)[number]

interface PlannerItem {
  title: string
  description: string
  capabilityId: string
  priority: number
  urgency: Urgency
  estimate?: string
  rationale?: string
}
interface AssignableCapability { id: string; name: string }
interface CriticIssue { dimension: string; itemRef: string; message: string; fix?: string }
interface BreakdownResult {
  items: PlannerItem[]
  assignableCapabilities: AssignableCapability[]
  homeCapabilityId: string
  deterministic: { repairedAssignments: number; duplicatePairs: Array<{ a: number; b: number; score: number }>; coverageGaps: string[] }
  critic: { verdict: 'pass' | 'warn' | 'fail'; issues: CriticIssue[] }
  usage: { inputTokens: number; outputTokens: number; estimatedCostUsd: number; calls: number }
  parseError?: string
  raw?: string
}
interface CommitResult {
  created: Array<{ id: string; workCode: string; capabilityId: string }>
  failed: Array<{ title: string; error: string }>
}

const card: CSSProperties = { background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, padding: 18 }
const label: CSSProperties = { fontSize: 12, fontWeight: 600, color: '#42526a', marginBottom: 6, display: 'block' }
const input: CSSProperties = { width: '100%', boxSizing: 'border-box', background: '#fff', border: '1px solid #dbe4ec', borderRadius: 8, padding: '8px 11px', fontSize: 13, color: '#0f172a', outline: 'none' }
const btn = (bg: string): CSSProperties => ({ background: bg, color: '#fff', border: 'none', borderRadius: 8, padding: '9px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 7 })
const ghostBtn: CSSProperties = { background: '#fff', color: '#334155', border: '1px solid #dbe4ec', borderRadius: 8, padding: '7px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }

const verdictStyle: Record<string, { bg: string; fg: string; Icon: typeof CheckCircle2 }> = {
  pass: { bg: '#ecfdf5', fg: '#047857', Icon: CheckCircle2 },
  warn: { bg: '#fffbeb', fg: '#b45309', Icon: AlertTriangle },
  fail: { bg: '#fef2f2', fg: '#b91c1c', Icon: XCircle },
}

export function PlannerPage() {
  const navigate = useNavigate()
  const active = useActiveContextStore((s) => s.active)
  const capabilityId = active?.capabilityId ?? ''

  const [description, setDescription] = useState('')
  const [allowChildren, setAllowChildren] = useState(true)
  const [maxItems, setMaxItems] = useState(12)
  const [result, setResult] = useState<BreakdownResult | null>(null)
  const [items, setItems] = useState<PlannerItem[]>([])

  const breakdownMut = useMutation<BreakdownResult>({
    mutationFn: () =>
      api.post('/planner/breakdown', { description: description.trim(), capabilityId, allowChildren, maxItems }).then((r) => r.data),
    onSuccess: (data) => {
      setResult(data)
      setItems(data.items)
    },
  })

  const commitMut = useMutation<CommitResult>({
    mutationFn: () => api.post('/planner/commit', { capabilityId, items }).then((r) => r.data),
  })

  const caps = result?.assignableCapabilities ?? []
  const capName = (id: string) => caps.find((c) => c.id === id)?.name ?? id
  const home = result?.homeCapabilityId ?? capabilityId

  const setItem = (i: number, patch: Partial<PlannerItem>) =>
    setItems((prev) => prev.map((it, idx) => (idx === i ? { ...it, ...patch } : it)))
  const removeItem = (i: number) => setItems((prev) => prev.filter((_, idx) => idx !== i))
  const addItem = () =>
    setItems((prev) => [...prev, { title: '', description: '', capabilityId: home, priority: 50, urgency: 'NORMAL' }])

  if (!capabilityId) {
    return (
      <div style={{ padding: 24 }}>
        <div style={{ ...card, maxWidth: 560 }}>
          <h2 style={{ margin: '0 0 8px' }}>Planner</h2>
          <p style={{ color: '#64748b', fontSize: 14 }}>
            Pick an active capability first (top-right context switcher) — the planner scopes work items to it and its children.
          </p>
        </div>
      </div>
    )
  }

  // ── committed summary ──
  if (commitMut.isSuccess && commitMut.data) {
    const { created, failed } = commitMut.data
    return (
      <div style={{ padding: 24, maxWidth: 720 }}>
        <div style={card}>
          <h2 style={{ margin: '0 0 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <CheckCircle2 size={20} color="#047857" /> Created {created.length} work item{created.length === 1 ? '' : 's'}
          </h2>
          <ul style={{ fontSize: 13, color: '#334155', lineHeight: 1.7 }}>
            {created.map((c) => (
              <li key={c.id}>
                <strong>{c.workCode}</strong> → {capName(c.capabilityId)}{c.capabilityId !== home ? ' (delegated)' : ''}
              </li>
            ))}
          </ul>
          {failed.length > 0 && (
            <div style={{ marginTop: 10, color: '#b91c1c', fontSize: 13 }}>
              {failed.length} failed: {failed.map((f) => f.title).join(', ')}
            </div>
          )}
          <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
            <button style={btn('#2563eb')} onClick={() => navigate('/runtime')}>Go to Inbox</button>
            <button
              style={ghostBtn}
              onClick={() => { commitMut.reset(); breakdownMut.reset(); setResult(null); setItems([]); setDescription('') }}
            >
              Plan another
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div style={{ padding: 24, maxWidth: 980, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <h1 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 9, fontSize: 22 }}>
          <Sparkles size={22} color="#7c3aed" /> Planner
        </h1>
        <p style={{ color: '#64748b', fontSize: 13, margin: '6px 0 0' }}>
          Describe what you want. An agent breaks it into work items (some can go to child capabilities); an independent critic reviews
          the breakdown. Review &amp; edit, then create — items land in each capability's Inbox.
        </p>
      </div>

      {/* Step 1 — describe */}
      <div style={card}>
        <label style={label}>What do you want to build / achieve?</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={5}
          placeholder="e.g. Add passwordless email login with rate limiting and an audit trail for auth events…"
          style={{ ...input, resize: 'vertical', fontFamily: 'inherit' }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 18, marginTop: 12, flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 13, color: '#334155', cursor: 'pointer' }}>
            <input type="checkbox" checked={allowChildren} onChange={(e) => setAllowChildren(e.target.checked)} />
            Allow delegating to child capabilities
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 13, color: '#334155' }}>
            Max items
            <input
              type="number" min={1} max={40} value={maxItems}
              onChange={(e) => setMaxItems(Math.min(40, Math.max(1, Number(e.target.value) || 12)))}
              style={{ ...input, width: 64, padding: '6px 8px' }}
            />
          </label>
          <span style={{ marginLeft: 'auto', fontSize: 12, color: '#94a3b8' }}>Scope: {active?.capabilityName}</span>
          <button
            style={{ ...btn('#7c3aed'), opacity: description.trim().length < 8 || breakdownMut.isPending ? 0.55 : 1 }}
            disabled={description.trim().length < 8 || breakdownMut.isPending}
            onClick={() => breakdownMut.mutate()}
          >
            {breakdownMut.isPending ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
            {breakdownMut.isPending ? 'Breaking down…' : 'Break down'}
          </button>
        </div>
        {breakdownMut.isError && (
          <div style={{ marginTop: 10, color: '#b91c1c', fontSize: 13 }}>
            Breakdown failed: {(breakdownMut.error as any)?.response?.data?.error ?? (breakdownMut.error as any)?.message ?? 'unknown error'}
          </div>
        )}
      </div>

      {/* Parse failure (agent returned non-JSON) */}
      {result && result.parseError && (
        <div style={{ ...card, borderColor: '#fecaca', background: '#fef2f2' }}>
          <strong style={{ color: '#b91c1c' }}>The agent didn't return a usable plan.</strong>
          <p style={{ fontSize: 12, color: '#7f1d1d', margin: '6px 0' }}>{result.parseError}</p>
          {result.raw && <pre style={{ fontSize: 11, background: '#fff', padding: 10, borderRadius: 8, overflow: 'auto', maxHeight: 200 }}>{result.raw}</pre>}
          <button style={ghostBtn} onClick={() => breakdownMut.mutate()}>Try again</button>
        </div>
      )}

      {/* Step 2 — review */}
      {result && !result.parseError && items.length > 0 && (
        <>
          <CriticPanel critic={result.critic} deterministic={result.deterministic} usage={result.usage} />

          <div style={card}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
              <h3 style={{ margin: 0, fontSize: 15 }}>Proposed work items ({items.length})</h3>
              <button style={{ ...ghostBtn, marginLeft: 'auto' }} onClick={addItem}><Plus size={14} /> Add item</button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {items.map((it, i) => {
                const delegated = it.capabilityId !== home
                return (
                  <div key={i} style={{ border: '1px solid #e8edf3', borderRadius: 10, padding: 12, background: delegated ? '#faf9ff' : '#fbfdff' }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
                      <span style={{ fontSize: 12, color: '#94a3b8', fontWeight: 700, minWidth: 18 }}>{i + 1}</span>
                      <input value={it.title} onChange={(e) => setItem(i, { title: e.target.value })} placeholder="Title" style={{ ...input, fontWeight: 600 }} />
                      <button style={{ ...ghostBtn, padding: '7px 9px', color: '#b91c1c' }} onClick={() => removeItem(i)} title="Remove"><Trash2 size={14} /></button>
                    </div>
                    <textarea value={it.description} onChange={(e) => setItem(i, { description: e.target.value })} rows={2} placeholder="Description / acceptance" style={{ ...input, resize: 'vertical', fontFamily: 'inherit', marginBottom: 8 }} />
                    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                      <div style={{ flex: '1 1 240px' }}>
                        <select value={it.capabilityId} onChange={(e) => setItem(i, { capabilityId: e.target.value })} style={{ ...input, cursor: 'pointer' }}>
                          {caps.map((c) => (
                            <option key={c.id} value={c.id}>{c.name}{c.id === home ? ' (home)' : ' (child)'}</option>
                          ))}
                        </select>
                      </div>
                      <select value={it.urgency} onChange={(e) => setItem(i, { urgency: e.target.value as Urgency })} style={{ ...input, width: 120, cursor: 'pointer' }}>
                        {URGENCIES.map((u) => <option key={u} value={u}>{u}</option>)}
                      </select>
                      <label style={{ fontSize: 12, color: '#64748b', display: 'flex', alignItems: 'center', gap: 6 }}>
                        Priority
                        <input type="number" min={0} max={100} value={it.priority} onChange={(e) => setItem(i, { priority: Math.min(100, Math.max(0, Number(e.target.value) || 0)) })} style={{ ...input, width: 64, padding: '6px 8px' }} />
                      </label>
                      {delegated && <span style={{ fontSize: 11, fontWeight: 700, color: '#7c3aed', background: '#f3e8ff', padding: '3px 8px', borderRadius: 999 }}>→ delegated</span>}
                    </div>
                    {it.rationale && <p style={{ fontSize: 11, color: '#94a3b8', margin: '8px 0 0' }}>{it.rationale}</p>}
                  </div>
                )
              })}
            </div>

            <div style={{ display: 'flex', gap: 10, marginTop: 16, alignItems: 'center' }}>
              <button
                style={{ ...btn('#2563eb'), opacity: commitMut.isPending || items.some((it) => it.title.trim().length < 3) ? 0.55 : 1 }}
                disabled={commitMut.isPending || items.some((it) => it.title.trim().length < 3)}
                onClick={() => commitMut.mutate()}
              >
                {commitMut.isPending ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
                Create {items.length} work item{items.length === 1 ? '' : 's'}
              </button>
              <button style={ghostBtn} onClick={() => { setResult(null); setItems([]) }}>Discard</button>
              {commitMut.isError && <span style={{ color: '#b91c1c', fontSize: 13 }}>Create failed — try again.</span>}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function CriticPanel({ critic, deterministic, usage }: Pick<BreakdownResult, 'critic' | 'deterministic' | 'usage'>) {
  const v = verdictStyle[critic.verdict] ?? verdictStyle.warn
  const hasFlags =
    critic.issues.length > 0 || deterministic.repairedAssignments > 0 || deterministic.duplicatePairs.length > 0 || deterministic.coverageGaps.length > 0
  return (
    <div style={{ ...card, padding: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: v.bg, color: v.fg, padding: '4px 11px', borderRadius: 999, fontSize: 12, fontWeight: 700 }}>
          <v.Icon size={14} /> Critic: {critic.verdict.toUpperCase()}
        </span>
        <span style={{ fontSize: 11, color: '#94a3b8', marginLeft: 'auto' }}>
          {usage.calls} agent call{usage.calls === 1 ? '' : 's'} · {usage.inputTokens + usage.outputTokens} tokens
          {usage.estimatedCostUsd > 0 ? ` · ~$${usage.estimatedCostUsd.toFixed(3)}` : ''}
        </span>
      </div>

      {!hasFlags && <p style={{ fontSize: 12, color: '#64748b', margin: '10px 0 0' }}>No issues flagged. Review and create.</p>}

      {(deterministic.repairedAssignments > 0 || deterministic.duplicatePairs.length > 0 || deterministic.coverageGaps.length > 0) && (
        <ul style={{ fontSize: 12, color: '#92400e', margin: '10px 0 0', paddingLeft: 18, lineHeight: 1.6 }}>
          {deterministic.repairedAssignments > 0 && <li>{deterministic.repairedAssignments} item(s) had an invalid capability → reset to home.</li>}
          {deterministic.duplicatePairs.map((p, k) => <li key={`d${k}`}>Items #{p.a + 1} and #{p.b + 1} look similar ({Math.round(p.score * 100)}%).</li>)}
          {deterministic.coverageGaps.length > 0 && <li>Goal terms not clearly covered by any item: {deterministic.coverageGaps.join(', ')}.</li>}
        </ul>
      )}

      {critic.issues.length > 0 && (
        <ul style={{ fontSize: 12, color: '#475569', margin: '10px 0 0', paddingLeft: 18, lineHeight: 1.6 }}>
          {critic.issues.map((iss, k) => (
            <li key={`c${k}`}>
              <strong style={{ color: '#334155' }}>{iss.dimension}</strong>{iss.itemRef && iss.itemRef !== 'plan' ? ` (${iss.itemRef})` : ''}: {iss.message}
              {iss.fix ? <em style={{ color: '#64748b' }}> — {iss.fix}</em> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
