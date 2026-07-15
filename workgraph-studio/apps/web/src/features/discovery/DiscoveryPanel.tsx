import { useState, type CSSProperties } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Sparkles, Loader2, HelpCircle, Lightbulb, Check, X, Plus } from 'lucide-react'
import { api } from '../../lib/api'

/**
 * Shared Discovery & Elicitation panel (ADR 0006 Slice 3).
 *
 * One reusable surface for "reducing the unknowns": it resolves (get-or-create)
 * the unified DiscoverySession for a scope, lists blocking/optional questions
 * and assumptions, lets a human answer/dismiss/validate, add their own, and ask
 * the governed LLM gateway / Copilot to surface more unknowns via elicit.
 *
 * Embedded in the studio stage canvas (scopeType WORKFLOW_STAGE) and the work
 * item detail (scopeType WORK_ITEM); works for RUN scope too. Talks only to
 * /api/discovery so it stays host-agnostic.
 */

type ScopeType = 'WORKFLOW_STAGE' | 'WORK_ITEM' | 'RUN'
type SessionStatus = 'OPEN' | 'RESOLVING' | 'BLOCKED' | 'RESOLVED' | 'ABANDONED'
type QuestionStatus = 'OPEN' | 'ANSWERED' | 'DISMISSED'
type AssumptionStatus = 'PROPOSED' | 'ACCEPTED' | 'REJECTED' | 'VALIDATED' | 'INVALIDATED'

interface Question {
  id: string
  text: string
  kind: string
  source: string
  blocking: boolean
  status: QuestionStatus
  answer?: string | null
  proposedAnswer?: string | null
  ordinal: number
}
interface Assumption {
  id: string
  text: string
  confidence: number
  status: AssumptionStatus
}
interface Session {
  id: string
  scopeType: ScopeType
  scopeId: string
  status: SessionStatus
  questions: Question[]
  assumptions: Assumption[]
}

interface Palette { bg: string; fg: string }
const GREEN: Palette = { bg: '#dcfce7', fg: '#166534' }
const AMBER: Palette = { bg: '#fef3c7', fg: '#92400e' }
const RED: Palette = { bg: '#fee2e2', fg: '#991b1b' }
const BLUE: Palette = { bg: '#dbeafe', fg: '#1e40af' }
const SLATE: Palette = { bg: '#e2e8f0', fg: '#334155' }
const VIOLET: Palette = { bg: '#ede9fe', fg: '#5b21b6' }

const SESSION_PALETTE: Record<SessionStatus, Palette> = {
  OPEN: BLUE, RESOLVING: AMBER, BLOCKED: RED, RESOLVED: GREEN, ABANDONED: SLATE,
}
const QUESTION_PALETTE: Record<QuestionStatus, Palette> = { OPEN: AMBER, ANSWERED: GREEN, DISMISSED: SLATE }
const ASSUMPTION_PALETTE: Record<AssumptionStatus, Palette> = {
  PROPOSED: BLUE, ACCEPTED: GREEN, VALIDATED: GREEN, REJECTED: RED, INVALIDATED: RED,
}

function pill(p: Palette): CSSProperties {
  return {
    display: 'inline-block', padding: '2px 8px', borderRadius: 999,
    background: p.bg, color: p.fg, fontSize: 11, fontWeight: 800, whiteSpace: 'nowrap',
  }
}

const card: CSSProperties = {
  padding: 14, borderRadius: 12, background: '#fff',
  border: '1px solid var(--color-outline-variant)', marginBottom: 14,
}
const primaryBtn: CSSProperties = {
  padding: '8px 13px', borderRadius: 9, border: 'none', background: '#8b5cf6',
  color: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 800,
  display: 'inline-flex', alignItems: 'center', gap: 6,
}
const secondaryBtn: CSSProperties = {
  padding: '6px 11px', borderRadius: 9, border: '1px solid var(--color-outline-variant)',
  background: '#fff', color: 'var(--color-on-surface)', cursor: 'pointer',
  fontSize: 12, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 6,
}
const input: CSSProperties = {
  width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--color-outline-variant)',
  fontSize: 12, color: 'var(--color-on-surface)', background: '#fff', boxSizing: 'border-box',
}
const muted: CSSProperties = { fontSize: 12, color: 'var(--color-outline)' }
const sectionTitle: CSSProperties = {
  margin: 0, fontSize: 14, color: 'var(--color-on-surface)', display: 'inline-flex', alignItems: 'center', gap: 6,
}

function errText(e: unknown): string {
  if (e && typeof e === 'object' && 'response' in e) {
    const data = (e as { response?: { data?: unknown } }).response?.data as
      | { error?: { message?: string } | string; message?: string } | string | undefined
    if (typeof data === 'string' && data) return data
    if (data && typeof data === 'object') {
      if (typeof data.error === 'object' && data.error?.message) return data.error.message
      if (typeof data.error === 'string' && data.error) return data.error
      if (data.message) return data.message
    }
  }
  if (e instanceof Error) return e.message
  return 'Request failed'
}

export interface DiscoveryPanelProps {
  scopeType: ScopeType
  scopeId: string
  touchPoint?: string
  title?: string
  /** Show the "Ask AI to find unknowns" elicit control (default true). */
  allowElicit?: boolean
}

export function DiscoveryPanel({ scopeType, scopeId, touchPoint, title, allowElicit = true }: DiscoveryPanelProps) {
  const qc = useQueryClient()
  const key = ['discovery-session', scopeType, scopeId]
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [hint, setHint] = useState('')
  const [newQ, setNewQ] = useState('')
  const [newQBlocking, setNewQBlocking] = useState(true)
  const [newA, setNewA] = useState('')

  const sessionQ = useQuery<Session>({
    queryKey: key,
    queryFn: () => api.post('/discovery/sessions/resolve', { scopeType, scopeId, touchPoint }).then(r => r.data),
  })
  const session = sessionQ.data
  const refresh = () => qc.invalidateQueries({ queryKey: key })
  const wrap = <T,>(fn: () => T) => { setError(null); setNote(null); return fn() }

  const elicit = useMutation({
    mutationFn: () => api.post(`/discovery/sessions/${session!.id}/elicit`, hint.trim() ? { hint } : {}).then(r => r.data),
    onSuccess: (d: any) => {
      setHint('')
      const notes: string[] = d?.notes ?? []
      setNote(`Elicited ${d?.addedQuestions?.length ?? 0} question(s), ${d?.addedAssumptions?.length ?? 0} assumption(s).${notes.length ? ' ' + notes.join(' ') : ''}`)
      refresh()
    },
    onError: (e) => setError(errText(e)),
  })
  const answer = useMutation({
    mutationFn: ({ id, text }: { id: string; text: string }) => api.post(`/discovery/questions/${id}/answer`, { answer: text }).then(r => r.data),
    onSuccess: (_d, v) => { setAnswers(a => { const n = { ...a }; delete n[v.id]; return n }); refresh() },
    onError: (e) => setError(errText(e)),
  })
  const dismiss = useMutation({
    mutationFn: (id: string) => api.post(`/discovery/questions/${id}/dismiss`).then(r => r.data),
    onSuccess: () => refresh(),
    onError: (e) => setError(errText(e)),
  })
  const addQuestion = useMutation({
    mutationFn: () => api.post(`/discovery/sessions/${session!.id}/questions`, { text: newQ, blocking: newQBlocking }).then(r => r.data),
    onSuccess: () => { setNewQ(''); refresh() },
    onError: (e) => setError(errText(e)),
  })
  const addAssumption = useMutation({
    mutationFn: () => api.post(`/discovery/sessions/${session!.id}/assumptions`, { text: newA }).then(r => r.data),
    onSuccess: () => { setNewA(''); refresh() },
    onError: (e) => setError(errText(e)),
  })
  const validateAssumption = useMutation({
    mutationFn: ({ id, status }: { id: string; status: AssumptionStatus }) => api.post(`/discovery/assumptions/${id}/validate`, { status }).then(r => r.data),
    onSuccess: () => refresh(),
    onError: (e) => setError(errText(e)),
  })

  if (sessionQ.isLoading) return <p style={muted}>Loading discovery…</p>
  if (sessionQ.isError || !session) {
    return <section style={card}><p style={{ ...muted, color: '#991b1b' }}>Could not load discovery for this scope. {sessionQ.error ? errText(sessionQ.error) : ''}</p></section>
  }

  const questions = [...session.questions].sort((a, b) => a.ordinal - b.ordinal)
  const openQuestions = questions.filter(q => q.status === 'OPEN')
  const blockingOpen = openQuestions.filter(q => q.blocking).length
  const busy = answer.isPending || dismiss.isPending

  return (
    <div>
      <section style={{ ...card, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h3 style={sectionTitle}><Sparkles style={{ width: 15, height: 15, color: '#8b5cf6' }} /> {title ?? 'Discovery — reduce the unknowns'}</h3>
          <div style={{ ...muted, marginTop: 6, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={pill(SESSION_PALETTE[session.status])}>{session.status}</span>
            <span>{openQuestions.length} open · {blockingOpen} blocking · {session.assumptions.length} assumption(s)</span>
          </div>
        </div>
        {allowElicit && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', maxWidth: 460 }}>
            <input
              style={{ ...input, width: 240 }}
              placeholder="Focus for the AI (optional), e.g. data-model unknowns"
              value={hint}
              onChange={e => setHint(e.target.value)}
            />
            <button style={primaryBtn} disabled={elicit.isPending} onClick={() => wrap(() => elicit.mutate())}>
              {elicit.isPending ? <Loader2 style={{ width: 13, height: 13 }} className="animate-spin" /> : <Sparkles style={{ width: 13, height: 13 }} />}
              {elicit.isPending ? 'Asking…' : 'Ask AI to find unknowns'}
            </button>
          </div>
        )}
      </section>

      {error && <div style={{ ...card, background: '#fee2e2', border: '1px solid #fecaca', color: '#991b1b', fontSize: 12 }}>{error}</div>}
      {note && <div style={{ ...card, background: '#ecfdf5', border: '1px solid #a7f3d0', color: '#065f46', fontSize: 12 }}>{note}</div>}

      <section style={card}>
        <h4 style={{ ...sectionTitle, fontSize: 13, marginBottom: 10 }}><HelpCircle style={{ width: 14, height: 14, color: 'var(--color-outline)' }} /> Questions ({questions.length})</h4>
        {questions.length === 0 ? (
          <p style={muted}>No open questions. Ask the AI to surface unknowns, or add one below.</p>
        ) : (
          <div style={{ display: 'grid', gap: 8 }}>
            {questions.map(q => (
              <div key={q.id} style={{ border: '1px solid var(--color-outline-variant)', borderRadius: 10, padding: 10, opacity: q.status === 'DISMISSED' ? 0.6 : 1 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                  {q.blocking && <span style={pill(RED)}>blocking</span>}
                  <span style={pill(QUESTION_PALETTE[q.status])}>{q.status}</span>
                  <span style={pill(VIOLET)}>{q.source}</span>
                  <span style={{ fontSize: 13, color: 'var(--color-on-surface)', fontWeight: 600 }}>{q.text}</span>
                </div>
                {q.status === 'ANSWERED' && q.answer && (
                  <div style={{ ...muted, marginTop: 6, color: 'var(--color-on-surface)' }}>↳ {q.answer}</div>
                )}
                {q.status === 'OPEN' && (
                  <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <input
                      style={{ ...input, flex: 1, minWidth: 200 }}
                      placeholder={q.proposedAnswer ? `Suggested: ${q.proposedAnswer}` : 'Type an answer…'}
                      value={answers[q.id] ?? ''}
                      onChange={e => setAnswers(a => ({ ...a, [q.id]: e.target.value }))}
                    />
                    <button
                      style={primaryBtn}
                      disabled={busy || !(answers[q.id] ?? '').trim()}
                      onClick={() => wrap(() => answer.mutate({ id: q.id, text: (answers[q.id] ?? '').trim() }))}
                    >
                      <Check style={{ width: 13, height: 13 }} /> Answer
                    </button>
                    <button style={secondaryBtn} disabled={busy} onClick={() => wrap(() => dismiss.mutate(q.id))}>
                      <X style={{ width: 13, height: 13 }} /> Dismiss
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <input style={{ ...input, flex: 1, minWidth: 220 }} placeholder="Add a question of your own…" value={newQ} onChange={e => setNewQ(e.target.value)} />
          <label style={{ ...muted, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <input type="checkbox" checked={newQBlocking} onChange={e => setNewQBlocking(e.target.checked)} /> blocking
          </label>
          <button style={secondaryBtn} disabled={addQuestion.isPending || !newQ.trim()} onClick={() => wrap(() => addQuestion.mutate())}>
            <Plus style={{ width: 13, height: 13 }} /> Add
          </button>
        </div>
      </section>

      <section style={card}>
        <h4 style={{ ...sectionTitle, fontSize: 13, marginBottom: 10 }}><Lightbulb style={{ width: 14, height: 14, color: 'var(--color-outline)' }} /> Assumptions ({session.assumptions.length})</h4>
        {session.assumptions.length === 0 ? (
          <p style={muted}>No assumptions recorded yet.</p>
        ) : (
          <div style={{ display: 'grid', gap: 8 }}>
            {session.assumptions.map(a => (
              <div key={a.id} style={{ border: '1px solid var(--color-outline-variant)', borderRadius: 10, padding: 10 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                  <span style={pill(ASSUMPTION_PALETTE[a.status])}>{a.status}</span>
                  <span style={muted}>conf {Math.round((a.confidence ?? 0) * 100)}%</span>
                  <span style={{ fontSize: 13, color: 'var(--color-on-surface)' }}>{a.text}</span>
                </div>
                {(a.status === 'PROPOSED' || a.status === 'ACCEPTED') && (
                  <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                    <button style={secondaryBtn} disabled={validateAssumption.isPending} onClick={() => wrap(() => validateAssumption.mutate({ id: a.id, status: 'VALIDATED' }))}>
                      <Check style={{ width: 13, height: 13 }} /> Validate
                    </button>
                    <button style={secondaryBtn} disabled={validateAssumption.isPending} onClick={() => wrap(() => validateAssumption.mutate({ id: a.id, status: 'REJECTED' }))}>
                      <X style={{ width: 13, height: 13 }} /> Reject
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <input style={{ ...input, flex: 1, minWidth: 220 }} placeholder="Record an assumption to validate later…" value={newA} onChange={e => setNewA(e.target.value)} />
          <button style={secondaryBtn} disabled={addAssumption.isPending || !newA.trim()} onClick={() => wrap(() => addAssumption.mutate())}>
            <Plus style={{ width: 13, height: 13 }} /> Add
          </button>
        </div>
      </section>
    </div>
  )
}
