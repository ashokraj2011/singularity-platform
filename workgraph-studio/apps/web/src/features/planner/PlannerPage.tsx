/**
 * Planner — a conversational, milestone-grouped roadmap.
 *
 * Left "Idea Inbox": describe a goal, chat to tweak/regenerate; the agent may
 * ask clarifying questions. Right "Active Roadmap": milestones with task cards.
 * Commit → each task becomes a WorkItem in its capability's inbox.
 *
 * Two server calls: POST /planner/converse (one chat turn — questions or an
 * updated roadmap + critic; creates nothing) and POST /planner/commit.
 */
import { useState, useRef, useEffect, type CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import {
  Lightbulb, Sparkles, Send, Trash2, AlertTriangle, CheckCircle2, XCircle, Loader2, HelpCircle, Rocket,
} from 'lucide-react'
import { api } from '../../lib/api'
import { useActiveContextStore } from '../../store/activeContext.store'

const PRIORITIES = ['HIGH', 'MEDIUM', 'LOW'] as const
type Priority = (typeof PRIORITIES)[number]

interface Task { title: string; description: string; category: string; capabilityId: string; priority: Priority; aiSuggested: boolean; rationale?: string }
interface Milestone { id: string; title: string; summary: string; tasks: Task[] }
interface ChatMessage { role: 'user' | 'assistant'; content: string }
interface Cap { id: string; name: string }
interface CriticIssue { dimension: string; itemRef: string; message: string; fix?: string }
interface ConverseResult {
  reply: string
  needsClarification: boolean
  questions: string[]
  milestones: Milestone[]
  assignableCapabilities: Cap[]
  homeCapabilityId: string
  deterministic: { repairedAssignments: number; duplicatePairs: Array<{ a: number; b: number; score: number }>; coverageGaps: string[] }
  critic: { verdict: 'pass' | 'warn' | 'fail'; issues: CriticIssue[] } | null
  usage: { inputTokens: number; outputTokens: number; estimatedCostUsd: number; calls: number }
  parseError?: string
  raw?: string
}
interface CommitResult { created: Array<{ id: string; workCode: string; capabilityId: string; milestone: string }>; failed: Array<{ title: string; error: string }> }

const ink = '#0f172a'
const panel: CSSProperties = { background: '#fff', border: '1px solid #e6ebf1', borderRadius: 14 }
const btn = (bg: string): CSSProperties => ({ background: bg, color: '#fff', border: 'none', borderRadius: 10, padding: '11px 16px', fontSize: 14, fontWeight: 700, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8 })
const ghost: CSSProperties = { background: '#fff', color: '#334155', border: '1px solid #dbe4ec', borderRadius: 9, padding: '8px 13px', fontSize: 13, fontWeight: 600, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }
const chip: CSSProperties = { fontSize: 10.5, fontWeight: 800, letterSpacing: 0.4, textTransform: 'uppercase', color: '#475569', background: '#eef2f6', padding: '3px 8px', borderRadius: 6 }
const priorityColor: Record<Priority, string> = { HIGH: '#dc2626', MEDIUM: '#475569', LOW: '#94a3b8' }
const verdictStyle: Record<string, { bg: string; fg: string; Icon: typeof CheckCircle2 }> = {
  pass: { bg: '#ecfdf5', fg: '#047857', Icon: CheckCircle2 },
  warn: { bg: '#fffbeb', fg: '#b45309', Icon: AlertTriangle },
  fail: { bg: '#fef2f2', fg: '#b91c1c', Icon: XCircle },
}

export function PlannerPage() {
  const navigate = useNavigate()
  const active = useActiveContextStore((s) => s.active)
  const capabilityId = active?.capabilityId ?? ''

  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [plan, setPlan] = useState<Milestone[]>([])
  const [last, setLast] = useState<ConverseResult | null>(null)
  const [input, setInput] = useState('')
  const [allowChildren, setAllowChildren] = useState(true)
  const threadRef = useRef<HTMLDivElement>(null)

  const converseMut = useMutation<ConverseResult, unknown, ChatMessage[]>({
    mutationFn: (msgs) =>
      api.post('/planner/converse', { capabilityId, messages: msgs, plan, allowChildren, maxItems: 16 }).then((r) => r.data),
    onSuccess: (res) => {
      setMessages((prev) => [...prev, { role: 'assistant', content: res.reply }])
      if (res.milestones?.length) setPlan(res.milestones)
      setLast(res)
    },
  })
  const commitMut = useMutation<CommitResult>({
    mutationFn: () => api.post('/planner/commit', { capabilityId, milestones: plan }).then((r) => r.data),
  })

  useEffect(() => { threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: 'smooth' }) }, [messages.length, converseMut.isPending])

  const caps = last?.assignableCapabilities ?? []
  const capName = (id: string) => caps.find((c) => c.id === id)?.name ?? id
  const home = last?.homeCapabilityId ?? capabilityId
  const taskCount = plan.reduce((n, m) => n + m.tasks.length, 0)
  const started = messages.length > 0

  const send = () => {
    const text = input.trim()
    if (text.length < 3 || converseMut.isPending) return
    const next = [...messages, { role: 'user' as const, content: text }]
    setMessages(next)
    setInput('')
    converseMut.mutate(next)
  }

  const setTask = (mi: number, ti: number, patch: Partial<Task>) =>
    setPlan((prev) => prev.map((m, i) => (i === mi ? { ...m, tasks: m.tasks.map((t, j) => (j === ti ? { ...t, ...patch } : t)) } : m)))
  const removeTask = (mi: number, ti: number) =>
    setPlan((prev) => prev.map((m, i) => (i === mi ? { ...m, tasks: m.tasks.filter((_, j) => j !== ti) } : m)).filter((m) => m.tasks.length > 0))

  if (!capabilityId) {
    return (
      <div style={{ padding: 24 }}>
        <div style={{ ...panel, maxWidth: 560, padding: 18 }}>
          <h2 style={{ margin: '0 0 8px' }}>Planner</h2>
          <p style={{ color: '#64748b', fontSize: 14 }}>Pick an active capability (top-right switcher) — the planner scopes work items to it and its children.</p>
        </div>
      </div>
    )
  }

  if (commitMut.isSuccess && commitMut.data) {
    const { created, failed } = commitMut.data
    return (
      <div style={{ padding: 24, maxWidth: 720 }}>
        <div style={{ ...panel, padding: 20 }}>
          <h2 style={{ margin: '0 0 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <CheckCircle2 size={20} color="#047857" /> Created {created.length} work item{created.length === 1 ? '' : 's'}
          </h2>
          <ul style={{ fontSize: 13, color: '#334155', lineHeight: 1.7 }}>
            {created.map((c) => (
              <li key={c.id}><strong>{c.workCode}</strong> · {c.milestone} → {capName(c.capabilityId)}{c.capabilityId !== home ? ' (delegated)' : ''}</li>
            ))}
          </ul>
          {failed.length > 0 && <div style={{ marginTop: 10, color: '#b91c1c', fontSize: 13 }}>{failed.length} failed: {failed.map((f) => f.title).join(', ')}</div>}
          <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
            <button style={btn('#2563eb')} onClick={() => navigate('/runtime')}>Go to Inbox</button>
            <button style={ghost} onClick={() => { commitMut.reset(); converseMut.reset(); setMessages([]); setPlan([]); setLast(null) }}>Plan another</button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 56px)', overflow: 'hidden', background: '#f6f8fb' }}>
      {/* ── Left: Idea Inbox / chat ───────────────────────────────────── */}
      <aside style={{ width: 380, minWidth: 380, borderRight: '1px solid #e6ebf1', background: '#fff', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '18px 20px 12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <Lightbulb size={18} color="#7c3aed" />
            <h2 style={{ margin: 0, fontSize: 16 }}>Idea Inbox</h2>
          </div>
          <p style={{ margin: '4px 0 0', fontSize: 12.5, color: '#64748b' }}>Describe a goal — the agent breaks it into milestones &amp; tasks. Keep chatting to tweak.</p>
        </div>

        {/* thread */}
        <div ref={threadRef} style={{ flex: 1, overflowY: 'auto', padding: '6px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {!started && (
            <div style={{ color: '#94a3b8', fontSize: 13, padding: '10px 4px' }}>e.g. “Add passwordless email login with rate limiting and an audit trail for auth events.”</div>
          )}
          {messages.map((m, i) => (
            <Bubble key={i} role={m.role}>{m.content}</Bubble>
          ))}
          {last?.needsClarification && last.questions.length > 0 && (
            <div style={{ ...panel, padding: 12, borderColor: '#ddd6fe', background: '#faf8ff' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700, color: '#6d28d9', marginBottom: 6 }}>
                <HelpCircle size={14} /> A few questions
              </div>
              <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: '#475569', lineHeight: 1.6 }}>
                {last.questions.map((q, k) => <li key={k}>{q}</li>)}
              </ol>
              <p style={{ fontSize: 11, color: '#94a3b8', margin: '8px 0 0' }}>Answer below and I'll build the roadmap.</p>
            </div>
          )}
          {converseMut.isPending && <Bubble role="assistant"><span style={{ display: 'inline-flex', gap: 7, alignItems: 'center', color: '#64748b' }}><Loader2 size={14} className="animate-spin" /> thinking…</span></Bubble>}
          {converseMut.isError && <div style={{ color: '#b91c1c', fontSize: 12 }}>Request failed — try again.</div>}
        </div>

        {/* AI insight */}
        {last?.reply && !converseMut.isPending && (
          <div style={{ margin: '0 16px 8px', background: '#f5f3ff', border: '1px solid #ede9fe', borderRadius: 10, padding: '9px 11px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 700, color: '#7c3aed' }}><Sparkles size={12} /> AI Insight</div>
            <p style={{ margin: '3px 0 0', fontSize: 12, color: '#475569', lineHeight: 1.5 }}>{last.reply}</p>
          </div>
        )}

        {/* composer */}
        <div style={{ borderTop: '1px solid #eef2f6', padding: 14 }}>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send() }}
            rows={started ? 2 : 4}
            placeholder={started ? 'Tweak it — “split milestone 2”, “add a fraud task”…' : 'Describe the feature or goal…'}
            style={{ width: '100%', boxSizing: 'border-box', border: '1px solid #dbe4ec', borderRadius: 10, padding: 11, fontSize: 13, fontFamily: 'inherit', resize: 'vertical', outline: 'none', color: ink }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#64748b', cursor: 'pointer' }}>
              <input type="checkbox" checked={allowChildren} onChange={(e) => setAllowChildren(e.target.checked)} /> child caps
            </label>
            <button
              style={{ ...btn('#7c3aed'), flex: 1, opacity: input.trim().length < 3 || converseMut.isPending ? 0.55 : 1 }}
              disabled={input.trim().length < 3 || converseMut.isPending}
              onClick={send}
            >
              {converseMut.isPending ? <Loader2 size={16} className="animate-spin" /> : started ? <Send size={16} /> : <Rocket size={16} />}
              {started ? 'Send' : 'Plan Now'}
            </button>
          </div>
        </div>
      </aside>

      {/* ── Right: Active Roadmap ─────────────────────────────────────── */}
      <main style={{ flex: 1, overflowY: 'auto', padding: '20px 28px 60px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 6 }}>
          <h1 style={{ margin: 0, fontSize: 24, color: ink }}>Active Roadmap</h1>
          <span style={{ fontSize: 12.5, color: '#94a3b8' }}>{active?.capabilityName}</span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 10 }}>
            {plan.length > 0 && (
              <button
                style={{ ...btn('#2563eb'), opacity: commitMut.isPending || taskCount === 0 ? 0.55 : 1 }}
                disabled={commitMut.isPending || taskCount === 0}
                onClick={() => commitMut.mutate()}
              >
                {commitMut.isPending ? <Loader2 size={16} className="animate-spin" /> : <CheckCircle2 size={16} />}
                Create {taskCount} work item{taskCount === 1 ? '' : 's'}
              </button>
            )}
          </div>
        </div>

        {last && !last.parseError && plan.length > 0 && last.critic && (
          <CriticBar critic={last.critic} deterministic={last.deterministic} usage={last.usage} />
        )}
        {last?.parseError && (
          <div style={{ ...panel, padding: 14, borderColor: '#fecaca', background: '#fef2f2', marginBottom: 14 }}>
            <strong style={{ color: '#b91c1c' }}>The agent didn't return a usable plan.</strong>
            {last.raw && <pre style={{ fontSize: 11, background: '#fff', padding: 10, borderRadius: 8, overflow: 'auto', maxHeight: 160, marginTop: 8 }}>{last.raw}</pre>}
          </div>
        )}

        {plan.length === 0 ? (
          <div style={{ ...panel, padding: 40, textAlign: 'center', color: '#94a3b8', marginTop: 30 }}>
            <Sparkles size={26} color="#c4b5fd" />
            <p style={{ fontSize: 14, marginTop: 10 }}>Describe a goal on the left and hit <strong>Plan Now</strong>.<br />The agent will draft a milestone roadmap here.</p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 26, marginTop: 8 }}>
            {plan.map((m, mi) => (
              <section key={m.id}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 4 }}>
                  <h2 style={{ margin: 0, fontSize: 19, color: ink }}>Milestone {mi + 1}: {m.title}</h2>
                  <span style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 700, color: '#94a3b8' }}>{m.tasks.length} task{m.tasks.length === 1 ? '' : 's'} · Planned</span>
                </div>
                {m.summary && <p style={{ margin: '0 0 6px', fontSize: 13, color: '#64748b' }}>{m.summary}</p>}
                <div style={{ height: 6, background: '#e9eef4', borderRadius: 99, overflow: 'hidden', marginBottom: 14 }}>
                  <div style={{ width: '0%', height: '100%', background: '#7c3aed' }} />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(330px, 1fr))', gap: 14 }}>
                  {m.tasks.map((t, ti) => (
                    <TaskCard
                      key={ti} task={t} caps={caps} home={home}
                      onChange={(patch) => setTask(mi, ti, patch)}
                      onRemove={() => removeTask(mi, ti)}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </main>
    </div>
  )
}

function Bubble({ role, children }: { role: 'user' | 'assistant'; children: React.ReactNode }) {
  const isUser = role === 'user'
  return (
    <div style={{ alignSelf: isUser ? 'flex-end' : 'flex-start', maxWidth: '92%', background: isUser ? '#7c3aed' : '#f1f5f9', color: isUser ? '#fff' : '#0f172a', borderRadius: 12, borderBottomRightRadius: isUser ? 3 : 12, borderBottomLeftRadius: isUser ? 12 : 3, padding: '9px 12px', fontSize: 13, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
      {children}
    </div>
  )
}

function TaskCard({ task, caps, home, onChange, onRemove }: { task: Task; caps: Cap[]; home: string; onChange: (p: Partial<Task>) => void; onRemove: () => void }) {
  const delegated = task.capabilityId !== home
  const capLabel = caps.find((c) => c.id === task.capabilityId)?.name ?? task.capabilityId
  return (
    <div style={{ ...panel, padding: 14, display: 'flex', flexDirection: 'column', gap: 8, position: 'relative' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {task.aiSuggested
          ? <span style={{ ...chip, color: '#1d4ed8', background: '#dbeafe', display: 'inline-flex', alignItems: 'center', gap: 4 }}><Sparkles size={10} /> AI Suggested</span>
          : task.category ? <span style={chip}>{task.category}</span> : <span style={chip}>Task</span>}
        <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 700, color: '#64748b', background: '#f1f5f9', padding: '3px 9px', borderRadius: 6 }}>To Do</span>
        <button onClick={onRemove} title="Remove" style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#cbd5e1', padding: 2 }}><Trash2 size={14} /></button>
      </div>
      <input value={task.title} onChange={(e) => onChange({ title: e.target.value })} style={{ border: 'none', outline: 'none', fontSize: 15, fontWeight: 700, color: ink, width: '100%', padding: 0 }} />
      <textarea value={task.description} onChange={(e) => onChange({ description: e.target.value })} rows={2} style={{ border: 'none', outline: 'none', fontSize: 13, color: '#475569', width: '100%', resize: 'vertical', padding: 0, fontFamily: 'inherit', lineHeight: 1.45 }} />
      <div style={{ borderTop: '1px solid #eef2f6', paddingTop: 9, display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 20, height: 20, borderRadius: 99, background: delegated ? '#ede9fe' : '#e0e7ff', color: delegated ? '#7c3aed' : '#4338ca', fontSize: 10, fontWeight: 800, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{(capLabel[0] ?? '?').toUpperCase()}</span>
        <select value={task.capabilityId} onChange={(e) => onChange({ capabilityId: e.target.value })} title="Assign capability"
          style={{ border: 'none', background: 'none', fontSize: 12, color: '#334155', fontWeight: 600, cursor: 'pointer', maxWidth: 150, outline: 'none' }}>
          {caps.map((c) => <option key={c.id} value={c.id}>{c.name}{c.id === home ? '' : ' (child)'}</option>)}
        </select>
        {delegated && <span style={{ fontSize: 9.5, fontWeight: 800, color: '#7c3aed', background: '#f3e8ff', padding: '2px 6px', borderRadius: 99 }}>DELEGATED</span>}
        <select value={task.priority} onChange={(e) => onChange({ priority: e.target.value as Priority })}
          style={{ marginLeft: 'auto', border: 'none', background: 'none', fontSize: 11.5, fontWeight: 800, color: priorityColor[task.priority], cursor: 'pointer', outline: 'none' }}>
          {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      </div>
    </div>
  )
}

function CriticBar({ critic, deterministic, usage }: Pick<ConverseResult, 'critic' | 'deterministic' | 'usage'> & { critic: NonNullable<ConverseResult['critic']> }) {
  const v = verdictStyle[critic.verdict] ?? verdictStyle.warn
  const detFlags = [
    deterministic.repairedAssignments > 0 ? `${deterministic.repairedAssignments} invalid capability → reset to home` : null,
    ...deterministic.duplicatePairs.map((p) => `tasks #${p.a + 1} and #${p.b + 1} look similar (${Math.round(p.score * 100)}%)`),
    deterministic.coverageGaps.length ? `goal terms not clearly covered: ${deterministic.coverageGaps.join(', ')}` : null,
  ].filter(Boolean) as string[]
  return (
    <div style={{ ...panel, padding: 12, marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: v.bg, color: v.fg, padding: '4px 11px', borderRadius: 999, fontSize: 12, fontWeight: 700 }}>
          <v.Icon size={14} /> Critic: {critic.verdict.toUpperCase()}
        </span>
        <span style={{ fontSize: 11, color: '#94a3b8', marginLeft: 'auto' }}>
          {usage.calls} call{usage.calls === 1 ? '' : 's'} · {usage.inputTokens + usage.outputTokens} tokens{usage.estimatedCostUsd > 0 ? ` · ~$${usage.estimatedCostUsd.toFixed(3)}` : ''}
        </span>
      </div>
      {(critic.issues.length > 0 || detFlags.length > 0) && (
        <ul style={{ fontSize: 12, color: '#475569', margin: '10px 0 0', paddingLeft: 18, lineHeight: 1.6 }}>
          {detFlags.map((f, k) => <li key={`d${k}`} style={{ color: '#92400e' }}>{f}</li>)}
          {critic.issues.map((iss, k) => (
            <li key={`c${k}`}><strong style={{ color: '#334155' }}>{iss.dimension}</strong>{iss.itemRef && iss.itemRef !== 'plan' ? ` (${iss.itemRef})` : ''}: {iss.message}{iss.fix ? <em style={{ color: '#64748b' }}> — {iss.fix}</em> : null}</li>
          ))}
        </ul>
      )}
    </div>
  )
}
