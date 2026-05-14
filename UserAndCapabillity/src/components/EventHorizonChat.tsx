import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { Bot, RefreshCcw, Send, Sparkles, Trash2, X } from 'lucide-react'
import { api } from '@/lib/api'
import { useAuthStore } from '@/store/auth.store'

type ChatMessage = { id: string; role: 'assistant' | 'user'; text: string; createdAt: string }
type ContextSnapshot = {
  app: string
  path: string
  surface: string
  capability?: Record<string, unknown> | null
  team?: Record<string, unknown> | null
  hints: string[]
}

const SESSION_KEY = 'event-horizon.iam.session'
const SESSION_ID_KEY = 'event-horizon.iam.session-id'
const DEFAULT_CAPABILITY_ID = import.meta.env.VITE_EVENT_HORIZON_CAPABILITY_ID ?? '00000000-0000-0000-0000-00000000aaaa'
const EVENT_HORIZON_PROVIDER = import.meta.env.VITE_EVENT_HORIZON_PROVIDER
const EVENT_HORIZON_MODEL = import.meta.env.VITE_EVENT_HORIZON_MODEL

function newId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function surfaceFor(path: string) {
  if (path.startsWith('/capabilities/')) return 'Capability Governance'
  if (path.startsWith('/capabilities')) return 'Capabilities'
  if (path.startsWith('/teams/')) return 'Team Detail'
  if (path.startsWith('/teams')) return 'Teams'
  if (path.startsWith('/roles')) return 'Roles'
  if (path.startsWith('/users')) return 'Users'
  if (path.startsWith('/audit')) return 'Audit'
  return 'IAM Admin'
}

function greeting(path: string): ChatMessage {
  return {
    id: newId(),
    role: 'assistant',
    text: `I am Event Horizon. I can help with IAM context, teams, roles, capability memberships, and how those govern agents and workflows. Current path: ${path}.`,
    createdAt: new Date().toISOString(),
  }
}

function extract(path: string, prefix: string) {
  const match = path.match(new RegExp(`^/${prefix}/([^/]+)`))
  return match?.[1] ?? null
}

function summarizeCapability(capability?: Record<string, unknown> | null) {
  if (!capability) return 'No capability is selected on this screen.'
  return `Capability: ${String(capability.name ?? capability.capability_id ?? capability.id ?? 'selected capability')}. Status: ${String(capability.status ?? 'unknown')}.`
}

function summarizeTeam(team?: Record<string, unknown> | null) {
  if (!team) return 'No team is selected on this screen.'
  return `Team: ${String(team.name ?? team.team_key ?? team.id ?? 'selected team')}.`
}

function answer(question: string, ctx: ContextSnapshot) {
  const q = question.toLowerCase()
  if (q.includes('clear') || q.includes('fresh') || q.includes('reset')) {
    return 'Use Clear session in this panel. I will forget this local conversation and start again from the current IAM context.'
  }
  if (q.includes('capability')) {
    return `${summarizeCapability(ctx.capability)} IAM capabilities are the authorization references. Agent Runtime owns capability agents, knowledge, and tools, but IAM owns membership and access.`
  }
  if (q.includes('team')) {
    return `${summarizeTeam(ctx.team)} Teams should be assigned to users and referenced by workflow templates through the Workgraph IAM mirror.`
  }
  if (q.includes('role') || q.includes('permission')) {
    return 'Roles define what a user can do. Capability memberships connect users or teams to capability-scoped permissions, and those permissions should be reflected in Workflow Manager and Agent Runtime.'
  }
  if (q.includes('workflow') || q.includes('agent')) {
    return 'Workflow Manager consumes IAM teams/capabilities for routing and permissions. Agent Runtime uses the same capability identity for agents, tools, prompt profiles, and knowledge.'
  }
  if (q.includes('where') || q.includes('screen') || q.includes('context')) {
    return `You are in ${ctx.app}, surface ${ctx.surface}, path ${ctx.path}. ${ctx.hints.join(' ')}`
  }
  return `For this ${ctx.surface} screen: ${ctx.hints.join(' ')} Ask about capability memberships, team setup, roles, workflow access, or agent governance.`
}

export function EventHorizonChat() {
  const token = useAuthStore(s => s.token)
  const location = useLocation()
  const path = location.pathname
  const capabilityId = useMemo(() => extract(path, 'capabilities'), [path])
  const teamId = useMemo(() => extract(path, 'teams'), [path])
  const [open, setOpen] = useState(false)
  const [input, setInput] = useState('')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [sessionId, setSessionId] = useState('')
  const [thinking, setThinking] = useState(false)
  const [ctx, setCtx] = useState<ContextSnapshot>({
    app: 'Identity & Access',
    path,
    surface: surfaceFor(path),
    hints: ['Use this utility to manage users, teams, roles, permissions, and capability memberships.'],
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
      const next: ContextSnapshot = {
        app: 'Identity & Access',
        path,
        surface: surfaceFor(path),
        hints: ['This is the control plane for access, membership, and governance references.'],
      }
      if (capabilityId) {
        try {
          next.capability = await api.get(`/capabilities/${encodeURIComponent(capabilityId)}`).then(r => r.data)
          next.hints.push(summarizeCapability(next.capability))
        } catch {
          next.hints.push(`Capability ${capabilityId} is in the URL, but I could not load details.`)
        }
      }
      if (teamId) {
        try {
          next.team = await api.get(`/teams/${encodeURIComponent(teamId)}`).then(r => r.data)
          next.hints.push(summarizeTeam(next.team))
        } catch {
          next.hints.push(`Team ${teamId} is in the URL, but I could not load details.`)
        }
      }
      if (path.startsWith('/roles')) next.hints.push('Roles are reusable permission bundles.')
      if (path.startsWith('/users')) next.hints.push('Users receive access through roles, teams, and capability memberships.')
      if (!cancelled) setCtx(next)
    }
    if (token) void load()
    return () => { cancelled = true }
  }, [capabilityId, path, teamId, token])

  if (!token) return null

  async function callEventHorizon(text: string) {
    const sid = activeSessionId()
    const capability = String(ctx.capability?.id ?? ctx.capability?.capability_id ?? capabilityId ?? DEFAULT_CAPABILITY_ID)
    const payload = {
      trace_id: `event-horizon:${sid}:${Date.now()}`,
      idempotency_key: `event-horizon:${sid}:${Date.now()}`,
      run_context: {
        workflow_instance_id: `event-horizon-${sid}`,
        workflow_node_id: 'event-horizon-chat',
        agent_run_id: `event-horizon-${Date.now()}`,
        capability_id: capability,
        user_id: token ? 'iam-user' : undefined,
        trace_id: `event-horizon:${sid}`,
      },
      system_prompt: [
        'You are Event Horizon, the Singularity IAM and capability governance assistant.',
        'Help with users, teams, roles, permissions, capability memberships, and cross-platform governance.',
        'Answer concisely and do not claim you performed mutations.',
      ].join('\n'),
      task: [
        `User question: ${text}`,
        `Current app: ${ctx.app}`,
        `Current surface: ${ctx.surface}`,
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
    const res = await fetch('/api/cf/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) throw new Error((await res.text()).slice(0, 300) || `Context Fabric returned ${res.status}`)
    const json = await res.json() as { finalResponse?: string; status?: string }
    return json.finalResponse || `Event Horizon completed with status ${json.status ?? 'UNKNOWN'}, but returned no text.`
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
                <div className="mt-1 text-xs text-emerald-100">{ctx.surface} · {ctx.app}</div>
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
              <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void send() }} placeholder="Ask about access or governance..." className="min-w-0 flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-emerald-500" />
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
