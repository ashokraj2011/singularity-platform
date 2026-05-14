import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { Bot, RefreshCcw, Send, Sparkles, Trash2, X } from 'lucide-react'
import { api } from '@/lib/api'
import { useAuthStore } from '@/store/auth.store'

type ChatMessage = { id: string; role: 'assistant' | 'user'; text: string; createdAt: string }
type ActionIntent = 'explain_stuck_nodes' | 'summarize_run' | 'find_evidence' | 'draft_approval_note' | 'recommend_budget_model'
type ContextSnapshot = {
  app: string
  path: string
  surface: string
  run?: Record<string, unknown> | null
  budget?: Record<string, unknown> | null
  insights?: Record<string, unknown> | null
  actionIntent?: ActionIntent | null
  hints: string[]
}

const SESSION_KEY = 'event-horizon.workgraph.session'
const SESSION_ID_KEY = 'event-horizon.workgraph.session-id'

function newId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function surfaceFor(path: string) {
  if (path.startsWith('/design/')) return 'Workflow Designer'
  if (path.startsWith('/runs/') && path.endsWith('/insights')) return 'Run Insights'
  if (path.startsWith('/mission-control/')) return 'Mission Control'
  if (path.startsWith('/runs/')) return 'Run Viewer'
  if (path.startsWith('/runs')) return 'Runs'
  if (path.startsWith('/runtime')) return 'Runtime Inbox'
  if (path.startsWith('/workflows')) return 'Workflow Templates'
  if (path.startsWith('/dashboard')) return 'Dashboard'
  return 'Workflow Manager'
}

function extractRunId(path: string) {
  const match = path.match(/^\/(?:runs|mission-control)\/([^/]+)/)
  return match?.[1] ?? null
}

function greeting(path: string): ChatMessage {
  return {
    id: newId(),
    role: 'assistant',
    text: `I am Event Horizon. I can help with workflow design, runtime status, node evidence, budgets, approvals, and run troubleshooting. Current path: ${path}.`,
    createdAt: new Date().toISOString(),
  }
}

function summarizeRun(run?: Record<string, unknown> | null) {
  if (!run) return 'No workflow run is selected on this screen.'
  const name = String(run.name ?? run.id ?? 'selected run')
  const status = String(run.status ?? 'unknown')
  return `Run: ${name}. Status: ${status}.`
}

function summarizeBudget(budget?: Record<string, unknown> | null) {
  if (!budget) return 'No run budget snapshot is loaded.'
  const consumed = budget.consumedTotalTokens ?? budget.consumed_tokens ?? 'unknown'
  const remaining = budget.remainingTotalTokens ?? budget.remaining_tokens ?? 'unknown'
  const status = budget.status ? ` Status: ${budget.status}.` : ''
  return `Budget tokens consumed: ${consumed}. Remaining: ${remaining}.${status}`
}

function summarizeInsights(insights?: Record<string, unknown> | null) {
  if (!insights) return 'No Mission Control insight packet is loaded.'
  const mission = insights.missionControl as Record<string, unknown> | undefined
  const totals = insights.totals as Record<string, unknown> | undefined
  const receipts = mission?.receiptsCount ?? 'unknown'
  const approvals = mission?.approvalWaits ?? 0
  const citations = mission?.citationCount ?? 0
  const workspace = mission?.workspaceSteps ?? 0
  const nodes = totals?.nodes ?? 'unknown'
  return `Mission Control: ${nodes} nodes, ${receipts} receipts, ${citations} citations, ${workspace} workspace evidence items, ${approvals} approval waits.`
}

function answer(question: string, ctx: ContextSnapshot) {
  const q = question.toLowerCase()
  if (q.includes('clear') || q.includes('fresh') || q.includes('reset')) {
    return 'Use Clear session in this panel. I will forget this local conversation and answer from the current workflow context only.'
  }
  if (q.includes('status') || q.includes('run') || q.includes('execution')) {
    return `${summarizeRun(ctx.run)} ${summarizeBudget(ctx.budget)} ${summarizeInsights(ctx.insights)} Open Run Insights for node-level events, citations, token budget, branch, commit, and artifact evidence.`
  }
  if (q.includes('budget') || q.includes('token') || q.includes('cost')) {
    return `${summarizeBudget(ctx.budget)} Workflow budgets are copied to each run and updated from Context Fabric receipts after each LLM-backed step.`
  }
  if (q.includes('agent') || q.includes('approval')) {
    return `Agent tasks run through Context Fabric and MCP, and governed tool or budget overruns can pause for human approval. ${summarizeInsights(ctx.insights)} Check pending approval panels or Run Insights for the exact wait reason.`
  }
  if (q.includes('capability')) {
    return 'Capabilities scope the agents, prompt profiles, tools, knowledge, and IAM access used by workflow nodes. In an AGENT_TASK, the selected capability controls what runtime context can be composed.'
  }
  if (q.includes('where') || q.includes('screen') || q.includes('context')) {
    return `You are in ${ctx.app}, surface ${ctx.surface}, path ${ctx.path}. ${ctx.hints.join(' ')} ${summarizeInsights(ctx.insights)}`
  }
  if (q.includes('node') || q.includes('designer')) {
    return 'In the designer, use the node inspector to configure capability, agent template, context policy, workbench behavior, and human approval points. Runtime-only evidence appears under Runs and Run Insights.'
  }
  return `For this ${ctx.surface} screen: ${ctx.hints.join(' ')} ${summarizeInsights(ctx.insights)} Ask about run status, budgets, approvals, workflow nodes, capability context, or where to inspect execution evidence.`
}

const ACTIONS: Array<{ intent: ActionIntent; label: string; prompt: string }> = [
  { intent: 'summarize_run', label: 'Summarize run', prompt: 'Summarize this run, including current status, active waits, budget risk, and next operator action.' },
  { intent: 'explain_stuck_nodes', label: 'Explain stuck nodes', prompt: 'Find any stuck, failed, paused, or waiting nodes and explain likely causes and what to inspect next.' },
  { intent: 'find_evidence', label: 'Find evidence', prompt: 'Tell me where to inspect prompt assemblies, model receipts, citations, artifacts, code changes, and audit evidence for this run.' },
  { intent: 'draft_approval_note', label: 'Draft approval note', prompt: 'Draft a concise approval note for the current pending approval or artifact promotion, including risks to check before approving.' },
  { intent: 'recommend_budget_model', label: 'Budget/model advice', prompt: 'Review token budget and model choice for this context and recommend safer or cheaper settings if needed.' },
]

export function EventHorizonChat() {
  const token = useAuthStore(s => s.token)
  const location = useLocation()
  const path = location.pathname
  const [open, setOpen] = useState(false)
  const [input, setInput] = useState('')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [sessionId, setSessionId] = useState('')
  const [thinking, setThinking] = useState(false)
  const [ctx, setCtx] = useState<ContextSnapshot>({
    app: 'Workflow Manager',
    path,
    surface: surfaceFor(path),
    hints: ['I can explain the current workflow surface and summarize selected run evidence when available.'],
  })
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const runId = useMemo(() => extractRunId(path), [path])

  function activeSessionId() {
    if (sessionId) return sessionId
    const fresh = newId()
    localStorage.setItem(SESSION_ID_KEY, fresh)
    setSessionId(fresh)
    return fresh
  }

  useEffect(() => {
    const existingSession = localStorage.getItem(SESSION_ID_KEY)
    if (existingSession) {
      setSessionId(existingSession)
    } else {
      const fresh = newId()
      localStorage.setItem(SESSION_ID_KEY, fresh)
      setSessionId(fresh)
    }
    const raw = localStorage.getItem(SESSION_KEY)
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as ChatMessage[]
        if (Array.isArray(parsed) && parsed.length) {
          setMessages(parsed)
          return
        }
      } catch {
        // ignore corrupt session
      }
    }
    setMessages([greeting(path)])
  }, [])

  useEffect(() => {
    localStorage.setItem(SESSION_KEY, JSON.stringify(messages))
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    let cancelled = false
    async function load() {
      const next: ContextSnapshot = {
        app: 'Workflow Manager',
        path,
        surface: surfaceFor(path),
        hints: ['Use this utility to design workflows, run them, approve pauses, and inspect execution evidence.'],
      }
      if (runId) {
        try {
          const run = await api.get(`/workflow-instances/${encodeURIComponent(runId)}`).then(r => r.data)
          next.run = run
          next.hints.push(summarizeRun(run))
        } catch {
          next.hints.push(`Run ${runId} is in the URL, but I could not load the run record.`)
        }
        try {
          next.budget = await api.get(`/workflow-instances/${encodeURIComponent(runId)}/budget`).then(r => r.data)
          next.hints.push(summarizeBudget(next.budget))
        } catch {
          next.hints.push('No budget snapshot is available for this run yet.')
        }
        try {
          next.insights = await api.get(`/workflow-instances/${encodeURIComponent(runId)}/insights`).then(r => r.data)
          next.hints.push(summarizeInsights(next.insights))
        } catch {
          next.hints.push('Mission Control evidence is not available yet.')
        }
      }
      if (path.startsWith('/design/')) next.hints.push('This is authoring mode; execution evidence appears after starting a run.')
      if (path.startsWith('/runtime')) next.hints.push('This is the end-user task and approval inbox.')
      if (!cancelled) setCtx(next)
    }
    if (token) void load()
    return () => { cancelled = true }
  }, [path, runId, token])

  if (!token) return null

  async function callEventHorizon(text: string) {
    const sid = activeSessionId()
    const response = await api.post('/event-horizon/chat', {
      message: text,
      sessionId: sid,
      app: ctx.app,
      surface: ctx.surface,
      path: ctx.path,
      capabilityId: (ctx.run?.capabilityId ?? ctx.run?.capability_id) as string | undefined,
      actionIntent: ctx.actionIntent ?? undefined,
      context: ctx,
    }).then(r => r.data as { response?: string; status?: string })
    return response.response || `Event Horizon completed with status ${response.status ?? 'UNKNOWN'}, but returned no text.`
  }

  async function send() {
    const text = input.trim()
    if (!text) return
    setMessages(m => [...m, { id: newId(), role: 'user', text, createdAt: new Date().toISOString() }])
    setInput('')
    setThinking(true)
    try {
      const llmText = await callEventHorizon(text)
      setMessages(m => [...m, { id: newId(), role: 'assistant', text: llmText, createdAt: new Date().toISOString() }])
    } catch (err) {
      setMessages(m => [...m, {
        id: newId(),
        role: 'assistant',
        text: `${answer(text, ctx)}\n\nContext Fabric/MCP call failed: ${(err as Error).message}`,
        createdAt: new Date().toISOString(),
      }])
    } finally {
      setThinking(false)
    }
  }

  async function sendAction(intent: ActionIntent, prompt: string) {
    setCtx(c => ({ ...c, actionIntent: intent }))
    setInput(prompt)
    const userText = prompt
    setMessages(m => [...m, { id: newId(), role: 'user', text: userText, createdAt: new Date().toISOString() }])
    setThinking(true)
    try {
      const sid = activeSessionId()
      const response = await api.post('/event-horizon/chat', {
        message: userText,
        sessionId: sid,
        app: ctx.app,
        surface: ctx.surface,
        path: ctx.path,
        capabilityId: (ctx.run?.capabilityId ?? ctx.run?.capability_id) as string | undefined,
        actionIntent: intent,
        context: { ...ctx, actionIntent: intent },
      }).then(r => r.data as { response?: string; status?: string })
      setMessages(m => [...m, {
        id: newId(),
        role: 'assistant',
        text: response.response || `Event Horizon completed with status ${response.status ?? 'UNKNOWN'}, but returned no text.`,
        createdAt: new Date().toISOString(),
      }])
    } catch (err) {
      setMessages(m => [...m, {
        id: newId(),
        role: 'assistant',
        text: `${answer(userText, { ...ctx, actionIntent: intent })}\n\nContext Fabric/MCP call failed: ${(err as Error).message}`,
        createdAt: new Date().toISOString(),
      }])
    } finally {
      setInput('')
      setThinking(false)
      setCtx(c => ({ ...c, actionIntent: null }))
    }
  }

  function clear() {
    const freshId = newId()
    localStorage.setItem(SESSION_ID_KEY, freshId)
    localStorage.removeItem(SESSION_KEY)
    setSessionId(freshId)
    setMessages([greeting(path)])
  }

  return (
    <div className="fixed bottom-5 right-5 z-[80]">
      {open ? (
        <div className="w-[380px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-emerald-200 bg-white shadow-2xl">
          <div className="bg-[linear-gradient(135deg,#082821,#0E3B2D)] p-4 text-white">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 text-sm font-bold"><Sparkles size={16} /> Event Horizon</div>
                <div className="mt-1 text-xs text-emerald-100">{ctx.surface} · {ctx.app}</div>
              </div>
              <div className="flex gap-1">
                <button onClick={clear} className="rounded-lg p-1.5 text-emerald-100 hover:bg-white/10" title="Clear session"><Trash2 size={14} /></button>
                <button onClick={() => setOpen(false)} className="rounded-lg p-1.5 text-emerald-100 hover:bg-white/10" title="Close"><X size={14} /></button>
              </div>
            </div>
          </div>
          <div className="max-h-[420px] space-y-3 overflow-y-auto bg-slate-50 p-4">
            <div className="flex flex-wrap gap-1.5">
              {ACTIONS.map(action => (
                <button
                  key={action.intent}
                  type="button"
                  onClick={() => void sendAction(action.intent, action.prompt)}
                  disabled={thinking}
                  className="rounded-full border border-emerald-200 bg-white px-2 py-1 text-[11px] font-semibold text-emerald-800 hover:bg-emerald-50 disabled:opacity-50"
                >
                  {action.label}
                </button>
              ))}
            </div>
            {messages.map(m => (
              <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-relaxed ${m.role === 'user' ? 'bg-emerald-700 text-white' : 'border border-slate-200 bg-white text-slate-700'}`}>{m.text}</div>
              </div>
            ))}
            {thinking && (
              <div className="flex justify-start">
                <div className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-500">
                  Event Horizon is routing through Context Fabric and MCP...
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>
          <div className="border-t border-slate-200 bg-white p-3">
            <div className="flex gap-2">
              <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void send() }} placeholder="Ask about this run or workflow..." className="min-w-0 flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-emerald-500" />
              <button onClick={() => void send()} disabled={thinking} className="rounded-xl bg-emerald-700 px-3 py-2 text-white hover:bg-emerald-800 disabled:opacity-50" title="Send"><Send size={16} /></button>
            </div>
            <button onClick={clear} className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-slate-500 hover:text-slate-800"><RefreshCcw size={12} /> Clear session and start fresh</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setOpen(true)} className="group flex items-center gap-2 rounded-full border border-emerald-200 bg-[linear-gradient(135deg,#082821,#0E3B2D)] px-4 py-3 text-sm font-bold text-white shadow-xl transition hover:scale-[1.02]">
          <Bot size={18} className="text-emerald-200" /> Event Horizon
        </button>
      )}
    </div>
  )
}
