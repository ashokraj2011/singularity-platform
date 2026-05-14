import { useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { Bot, RefreshCcw, Send, Sparkles, Trash2, X } from 'lucide-react'
import { iamApi, workgraphApi, contextFabricApi } from '@/lib/api'
import { useAuthStore } from '@/store/auth.store'

type ChatMessage = { id: string; role: 'assistant' | 'user'; text: string; createdAt: string }
type ContextSnapshot = {
  app: string
  path: string
  health: string[]
  hints: string[]
}

const SESSION_KEY = 'event-horizon.portal.session'
const SESSION_ID_KEY = 'event-horizon.portal.session-id'
const DEFAULT_CAPABILITY_ID = import.meta.env.VITE_EVENT_HORIZON_CAPABILITY_ID ?? '00000000-0000-0000-0000-00000000aaaa'
const EVENT_HORIZON_PROVIDER = import.meta.env.VITE_EVENT_HORIZON_PROVIDER
const EVENT_HORIZON_MODEL = import.meta.env.VITE_EVENT_HORIZON_MODEL

function newId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function greeting(path: string): ChatMessage {
  return {
    id: newId(),
    role: 'assistant',
    text: `I am Event Horizon. I can help you choose the right utility, understand capability/workflow status, and explain what each tile means. Current path: ${path}.`,
    createdAt: new Date().toISOString(),
  }
}

function answer(question: string, ctx: ContextSnapshot) {
  const q = question.toLowerCase()
  if (q.includes('clear') || q.includes('fresh') || q.includes('reset')) {
    return 'Use Clear session in this panel. I will forget the local conversation and start fresh from portal context.'
  }
  if (q.includes('workflow') || q.includes('run') || q.includes('execution')) {
    return 'Workflow status lives in Workflow Manager. Use the Workflow Runs tile to jump to active and recent runs. Event Horizon inside Workflow Manager can summarize a selected run and budget.'
  }
  if (q.includes('capability')) {
    return 'Capabilities are governed in IAM and implemented in Agent Runtime. The portal capability tile shows visible IAM references; Agent Runtime shows agents, bindings, repos, knowledge, and prompt context.'
  }
  if (q.includes('token') || q.includes('cost')) {
    return 'Token and cost savings come from Context Fabric and the metrics ledger. Use cost tiles for rollups, then Run Insights for per-node token and budget details.'
  }
  if (q.includes('where') || q.includes('utility') || q.includes('app')) {
    return 'Use Identity & Access for users/teams/roles/capability membership, Agent Runtime for agents/tools/prompts/capability knowledge, and Workflow Manager for workflow design/runs/approvals.'
  }
  if (q.includes('status') || q.includes('health')) {
    return ctx.health.length ? `Current quick checks: ${ctx.health.join(' ')}` : 'I do not have live status loaded yet. The portal tiles show the best current cross-utility summary.'
  }
  return `From the portal: ${ctx.hints.join(' ')} Ask about which utility to open, capabilities, workflow runs, token savings, or status.`
}

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
    app: 'Singularity Portal',
    path,
    health: [],
    hints: ['This launchpad routes you to IAM, Agent Runtime, Workflow Manager, Context Fabric, and governance metrics.'],
  })
  const bottomRef = useRef<HTMLDivElement | null>(null)

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
      const health: string[] = []
      try {
        const caps = await iamApi.get('/capabilities', { params: { size: 1 } }).then(r => r.data as { total?: number })
        health.push(`IAM capabilities: ${caps.total ?? 'available'}.`)
      } catch {
        health.push('IAM capability lookup unavailable.')
      }
      try {
        const templates = await workgraphApi.get('/workflow-templates').then(r => r.data as unknown[])
        health.push(`Workflow templates: ${Array.isArray(templates) ? templates.length : 'available'}.`)
      } catch {
        health.push('Workflow Manager lookup unavailable.')
      }
      try {
        await contextFabricApi.get('/health')
        health.push('Context Fabric health endpoint responded.')
      } catch {
        health.push('Context Fabric health check unavailable.')
      }
      if (!cancelled) {
        setCtx({
          app: 'Singularity Portal',
          path,
          health,
          hints: ['Use the tiles for cross-platform status, then open the specific utility for detailed actions.'],
        })
      }
    }
    if (token) void load()
    return () => { cancelled = true }
  }, [path, token])

  if (!token) return null

  async function callEventHorizon(text: string) {
    const sid = activeSessionId()
    const payload = {
      trace_id: `event-horizon:${sid}:${Date.now()}`,
      idempotency_key: `event-horizon:${sid}:${Date.now()}`,
      run_context: {
        workflow_instance_id: `event-horizon-${sid}`,
        workflow_node_id: 'event-horizon-chat',
        agent_run_id: `event-horizon-${Date.now()}`,
        capability_id: DEFAULT_CAPABILITY_ID,
        user_id: token ? 'portal-user' : undefined,
        trace_id: `event-horizon:${sid}`,
      },
      system_prompt: [
        'You are Event Horizon, the Singularity cross-utility portal assistant.',
        'Help users choose the right utility and understand capability, workflow, token, and governance status.',
        'Answer concisely and do not claim you performed mutations.',
      ].join('\n'),
      task: [
        `User question: ${text}`,
        `Current app: ${ctx.app}`,
        `Current path: ${ctx.path}`,
        `Context JSON: ${JSON.stringify(ctx).slice(0, 6000)}`,
      ].join('\n\n'),
      model_overrides: { provider: EVENT_HORIZON_PROVIDER, model: EVENT_HORIZON_MODEL, temperature: 0.2, maxOutputTokens: 700 },
      context_policy: { optimizationMode: 'aggressive', maxContextTokens: 4000, compareWithRaw: false },
      limits: {
        inputTokenBudget: 4000,
        outputTokenBudget: 700,
        maxHistoryMessages: 4,
        maxSteps: 2,
        maxToolResultChars: 2000,
        maxPromptChars: 12000,
        timeoutSec: 180,
      },
      prefer_laptop: false,
    }
    const res = await contextFabricApi.post('/execute', payload).then(r => r.data as { finalResponse?: string; status?: string })
    return res.finalResponse || `Event Horizon completed with status ${res.status ?? 'UNKNOWN'}, but returned no text.`
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
                <div className="mt-1 text-xs text-emerald-100">{ctx.app}</div>
              </div>
              <div className="flex gap-1">
                <button onClick={clear} className="rounded-lg p-1.5 text-emerald-100 hover:bg-white/10" title="Clear session"><Trash2 size={14} /></button>
                <button onClick={() => setOpen(false)} className="rounded-lg p-1.5 text-emerald-100 hover:bg-white/10" title="Close"><X size={14} /></button>
              </div>
            </div>
          </div>
          <div className="max-h-[420px] space-y-3 overflow-y-auto bg-slate-50 p-4">
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
              <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void send() }} placeholder="Ask where to go next..." className="min-w-0 flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-emerald-500" />
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
