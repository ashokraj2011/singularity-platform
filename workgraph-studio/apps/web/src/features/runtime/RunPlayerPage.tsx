/**
 * RunPlayerPage — single-page browser-driven workflow runtime.
 *
 *   /play/new?workflowId=…  → bootstrap a new run from the URL params, redirect to /play/:runId
 *   /play/:runId            → main player surface
 *
 * Renders a full-bleed React Flow canvas with live status colours; clicking
 * an ACTIVE interactive node opens NodeRunModal which dispatches actions into
 * the BrowserWorkflowRuntime. State is persisted via the engine hook (IndexedDB
 * + server snapshot).
 */

import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import ReactFlow, {
  Background, BackgroundVariant, Controls, MiniMap,
  type Node, type Edge,
} from 'reactflow'
import 'reactflow/dist/style.css'
import {
  ArrowLeft, Pause, Play, Square, Bell,
  CheckCircle2, AlertCircle, Loader2,
} from 'lucide-react'
import type { RunState, RunNodeState, EngineNodeDef, WorkflowDefinition } from '@workgraph/engine'
import { useRunPlayer, createBrowserRun } from '../../lib/engineHooks'
import { useAuthStore } from '../../store/auth.store'
import { NodeRunModal } from './NodeRunModal'

// ─── Status palette ─────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, { bg: string; ring: string; label: string }> = {
  PENDING:   { bg: '#f1f5f9', ring: '#cbd5e1', label: 'Pending' },
  ACTIVE:    { bg: '#dcfce7', ring: '#22c55e', label: 'Active' },
  COMPLETED: { bg: '#bbf7d0', ring: '#16a34a', label: 'Done' },
  FAILED:    { bg: '#fee2e2', ring: '#ef4444', label: 'Failed' },
  SKIPPED:   { bg: '#f1f5f9', ring: '#94a3b8', label: 'Skipped' },
}

const RUN_STATUS_VISUAL: Record<string, { bg: string; ring: string; color: string }> = {
  DRAFT:     { bg: 'rgba(100,116,139,0.10)', ring: 'rgba(100,116,139,0.30)', color: '#475569' },
  ACTIVE:    { bg: 'rgba(34,197,94,0.10)',   ring: 'rgba(34,197,94,0.35)',   color: '#16a34a' },
  PAUSED:    { bg: 'rgba(245,158,11,0.10)',  ring: 'rgba(245,158,11,0.35)',  color: '#d97706' },
  COMPLETED: { bg: 'rgba(34,197,94,0.10)',   ring: 'rgba(34,197,94,0.35)',   color: '#15803d' },
  FAILED:    { bg: 'rgba(239,68,68,0.10)',   ring: 'rgba(239,68,68,0.35)',   color: '#b91c1c' },
  CANCELLED: { bg: 'rgba(100,116,139,0.10)', ring: 'rgba(100,116,139,0.30)', color: '#475569' },
}

const INTERACTIVE_NODE_TYPES = new Set([
  'HUMAN_TASK', 'WORKBENCH_TASK', 'APPROVAL', 'CONSUMABLE_CREATION', 'DECISION_GATE',
])

// ─── Bootstrap entry: /play/new ─────────────────────────────────────────────

export function RunPlayerEntry() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const user = useAuthStore(s => s.user)
  const [error, setError] = useState<string | null>(null)
  // One-shot guard: stops duplicate run creation under React StrictMode and
  // when `user` hydrates a moment after first render.
  const startedRef = useRef(false)

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true

    const workflowId = searchParams.get('workflowId') ?? ''
    const name = searchParams.get('name') ?? `Run ${new Date().toLocaleString()}`
    if (!workflowId) {
      setError('workflowId is required')
      return
    }
    let varsParam: Record<string, unknown> = {}
    let globalsParam: Record<string, unknown> = {}
    try {
      const v = searchParams.get('vars')
      if (v) varsParam = JSON.parse(decodeURIComponent(v))
    } catch { /* ignore */ }
    try {
      const g = searchParams.get('globals')
      if (g) globalsParam = JSON.parse(decodeURIComponent(g))
    } catch { /* ignore */ }

    createBrowserRun({
      workflowId,
      name,
      params: varsParam,
      globalsOverride: globalsParam,
      createdById: user?.id,
    })
      .then(run => navigate(`/play/${run.runId}`, { replace: true }))
      .catch(e => {
        startedRef.current = false   // allow a retry if the create failed
        setError(e?.message ?? 'Failed to start run')
      })
    // Intentionally empty deps — startedRef gates everything. We capture the
    // current snapshot of searchParams / user once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <CenteredMessage
      icon={error ? <AlertCircle size={32} /> : <Loader2 size={32} className="animate-spin" />}
      title={error ? 'Could not start run' : 'Starting workflow…'}
      subtitle={error ?? 'Hydrating definition and creating local run state'}
    />
  )
}

// ─── Main: /play/:runId ─────────────────────────────────────────────────────

export function RunPlayerPage() {
  const { runId } = useParams<{ runId: string }>()
  const navigate = useNavigate()
  const user = useAuthStore(s => s.user)
  const { state, runtime, definition, isLoading, error } = useRunPlayer(runId)
  const [openNodeId, setOpenNodeId] = useState<string | null>(null)
  const [notifyOpen, setNotifyOpen] = useState(false)

  // Auto-start a DRAFT run on first hydration
  useEffect(() => {
    if (state && state.status === 'DRAFT' && runtime) {
      runtime.start(user?.email)
    }
  }, [state?.runId, state?.status, runtime, user?.email])

  if (isLoading) {
    return <CenteredMessage icon={<Loader2 size={32} className="animate-spin" />} title="Loading run…" />
  }
  if (error) {
    return <CenteredMessage icon={<AlertCircle size={32} />} title="Run not found" subtitle={error.message} />
  }
  if (!state || !runtime || !definition) {
    return <CenteredMessage icon={<AlertCircle size={32} />} title="No run data" />
  }

  const openNode = openNodeId
    ? definition.nodes.find(n => n.id === openNodeId)
    : null
  const openNodeState = openNodeId ? state.nodes[openNodeId] : null

  const counts = countByStatus(state)
  const total = Object.keys(state.nodes).length
  const progress = total > 0 ? Math.round((counts.COMPLETED / total) * 100) : 0

  // ── React Flow data
  const rfNodes: Node[] = definition.nodes.map(n => {
    const ns = state.nodes[n.id] ?? { status: 'PENDING' as const }
    const palette = STATUS_COLORS[ns.status] ?? STATUS_COLORS.PENDING
    const interactive = ns.status === 'ACTIVE' && INTERACTIVE_NODE_TYPES.has(n.nodeType)
    return {
      id: n.id,
      position: nodePosition(n, definition.nodes),
      data: { label: nodeLabel(n, ns) },
      style: {
        background: palette.bg,
        border: `2px solid ${palette.ring}`,
        borderRadius: 12,
        padding: 10,
        fontSize: 12,
        fontWeight: 600,
        minWidth: 160,
        cursor: interactive ? 'pointer' : 'default',
        boxShadow: interactive ? '0 0 0 4px rgba(34,197,94,0.18)' : 'none',
      },
    }
  })

  const rfEdges: Edge[] = definition.edges.map(e => {
    const traversed = state.edges[e.id]?.traversed
    return {
      id: e.id,
      source: e.sourceNodeId,
      target: e.targetNodeId,
      animated: traversed,
      style: {
        stroke: traversed ? '#16a34a' : '#cbd5e1',
        strokeWidth: traversed ? 2.5 : 1.5,
        strokeDasharray: traversed ? undefined : '4 4',
      },
    }
  })

  const runVisual = RUN_STATUS_VISUAL[state.status] ?? RUN_STATUS_VISUAL.DRAFT

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '12px 18px',
        borderBottom: '1px solid var(--color-outline-variant)',
        background: 'var(--color-surface)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            onClick={() => navigate('/runs')}
            style={iconBtn()}
            aria-label="Back to runs"
          >
            <ArrowLeft size={15} />
          </button>
          <div>
            <p style={{
              fontSize: 9, fontWeight: 700, textTransform: 'uppercase',
              letterSpacing: '0.16em', color: 'var(--color-outline)',
            }}>
              Browser Run · {definition.name}
            </p>
            <h1 style={{ fontSize: 16, fontWeight: 700, color: 'var(--color-on-surface)', marginTop: 2 }}>
              {state.name}
            </h1>
          </div>
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '4px 10px', borderRadius: 20,
            background: runVisual.bg, border: `1px solid ${runVisual.ring}`,
            color: runVisual.color,
            fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.12em',
          }}>
            {state.status === 'COMPLETED' && <CheckCircle2 size={12} />}
            {state.status}
          </span>
          <span style={{
            fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.12em',
            color: 'var(--color-outline)',
          }}>
            v{definition.versionHash}
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button
            onClick={() => setNotifyOpen(true)}
            title="Send an email or post to Teams using this run's context"
            style={pillBtn()}
          >
            <Bell size={13} /> Notify
          </button>
          {state.status === 'ACTIVE' && (
            <button
              onClick={() => runtime.pause(user?.email)}
              style={pillBtn()}
            >
              <Pause size={13} /> Pause
            </button>
          )}
          {state.status === 'PAUSED' && (
            <button
              onClick={() => runtime.resume(user?.email)}
              style={pillBtn('var(--color-primary)', '#fff')}
            >
              <Play size={13} /> Resume
            </button>
          )}
          {(state.status === 'ACTIVE' || state.status === 'PAUSED' || state.status === 'DRAFT') && (
            <button
              onClick={() => {
                if (confirm('Cancel this run? Any pending nodes will be skipped.')) {
                  runtime.cancel('User cancelled', user?.email)
                }
              }}
              style={pillBtn()}
            >
              <Square size={13} /> Cancel
            </button>
          )}
        </div>
      </div>

      {/* Canvas */}
      <div style={{ flex: 1, position: 'relative', background: '#fafafa' }}>
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          fitView
          fitViewOptions={{ padding: 0.25 }}
          panOnDrag
          panOnScroll
          zoomOnScroll
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable
          onNodeClick={(_, n) => {
            const ns = state.nodes[n.id]
            const def = definition.nodes.find(x => x.id === n.id)
            if (!ns || !def) return
            if (ns.status !== 'ACTIVE') return
            if (!INTERACTIVE_NODE_TYPES.has(def.nodeType)) return
            setOpenNodeId(n.id)
          }}
        >
          <Background color="#cbd5e1" gap={24} variant={BackgroundVariant.Dots} />
          <Controls position="bottom-right" />
          <MiniMap pannable zoomable />
        </ReactFlow>
      </div>

      {/* Bottom strip */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 18px',
        borderTop: '1px solid var(--color-outline-variant)',
        background: 'var(--color-surface)',
        gap: 12,
        flexWrap: 'wrap',
      }}>
        <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
          <ProgressBar pct={progress} />
          <Chip color="#16a34a"  label={`${counts.COMPLETED}/${total} done`} />
          <Chip color="#22c55e"  label={`${counts.ACTIVE} active`} />
          {counts.FAILED  > 0 && <Chip color="#ef4444" label={`${counts.FAILED} failed`} />}
          {counts.SKIPPED > 0 && <Chip color="#94a3b8" label={`${counts.SKIPPED} skipped`} />}
        </div>
        <span style={{ fontSize: 10, color: 'var(--color-outline)' }}>
          v{state.version} · synced via IndexedDB + server snapshot
        </span>
      </div>

      {/* Modal */}
      {openNode && openNodeState && (
        <NodeRunModal
          runtime={runtime}
          node={openNode}
          nodeState={openNodeState}
          actorEmail={user?.email}
          onClose={() => setOpenNodeId(null)}
        />
      )}

      {notifyOpen && (
        <NotifyModal
          state={state}
          definition={definition}
          onClose={() => setNotifyOpen(false)}
        />
      )}
    </div>
  )
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function nodeLabel(n: EngineNodeDef, ns: RunNodeState): string {
  const sub = STATUS_COLORS[ns.status]?.label ?? ns.status
  return `${n.label || n.id}\n· ${sub}`
}

function nodePosition(node: EngineNodeDef, allNodes: EngineNodeDef[]): { x: number; y: number } {
  // Fall back to a deterministic grid layout if positions aren't part of the
  // definition. The design-graph endpoint actually returns positionX/positionY
  // but we don't pull them through into EngineNodeDef — quick placeholder.
  const cfg = (node.config ?? {}) as Record<string, unknown>
  if (typeof cfg.positionX === 'number' && typeof cfg.positionY === 'number') {
    return { x: cfg.positionX as number, y: cfg.positionY as number }
  }
  const idx = allNodes.findIndex(n => n.id === node.id)
  return { x: 80 + (idx % 4) * 220, y: 60 + Math.floor(idx / 4) * 160 }
}

function countByStatus(state: RunState) {
  const out = { PENDING: 0, ACTIVE: 0, COMPLETED: 0, FAILED: 0, SKIPPED: 0 }
  for (const n of Object.values(state.nodes)) {
    out[n.status as keyof typeof out] = (out[n.status as keyof typeof out] ?? 0) + 1
  }
  return out
}

function ProgressBar({ pct }: { pct: number }) {
  return (
    <div style={{ width: 160, height: 6, borderRadius: 999, background: 'var(--color-outline-variant)' }}>
      <div style={{
        width: `${pct}%`, height: '100%', borderRadius: 999,
        background: 'var(--color-primary)', transition: 'width 200ms ease',
      }} />
    </div>
  )
}

function Chip({ color, label }: { color: string; label: string }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: '3px 8px', borderRadius: 999,
      background: `${color}1A`, color,
      fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em',
    }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: color }} />
      {label}
    </span>
  )
}

function iconBtn(): React.CSSProperties {
  return {
    width: 32, height: 32, borderRadius: 10, border: '1px solid var(--color-outline-variant)',
    background: 'transparent', cursor: 'pointer',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    color: 'var(--color-outline)',
  }
}

function pillBtn(bg = 'transparent', color = 'var(--color-on-surface)'): React.CSSProperties {
  return {
    padding: '6px 12px', borderRadius: 8,
    border: bg === 'transparent' ? '1px solid var(--color-outline-variant)' : 'none',
    background: bg, color,
    fontSize: 12, fontWeight: 600, cursor: 'pointer',
    display: 'inline-flex', alignItems: 'center', gap: 6,
  }
}

// ─── Notify modal ───────────────────────────────────────────────────────────
//
// Lightweight composer that posts to /api/notify/email or /api/notify/teams.
// The current run context is sent along so `{{vars.X}}`, `{{globals.X}}`, etc.
// in the subject / body get substituted server-side.

import { api } from '../../lib/api'

function NotifyModal({
  state, definition, onClose,
}: {
  state: RunState
  definition: WorkflowDefinition
  onClose: () => void
}) {
  const [tab, setTab] = useState<'email' | 'teams'>('email')
  const [busy, setBusy] = useState(false)
  const [err,  setErr]  = useState<string | null>(null)
  const [okMsg, setOkMsg] = useState<string | null>(null)

  // Email fields
  const [to, setTo] = useState('')
  const [subject, setSubject] = useState(`[${definition.name}] ${state.name}`)
  const [body, setBody] = useState('Run “{{run.name}}” advanced.\nStatus: {{run.status}}\n')

  // Teams fields
  const [message, setMessage] = useState('Run “{{run.name}}” advanced. Status: {{run.status}}')
  const [webhookUrl, setWebhookUrl] = useState('')

  const baseContext = {
    ...state.context,
    _run: { name: state.name, status: state.status, runId: state.runId, workflow: definition.name },
  }

  const send = async () => {
    setBusy(true); setErr(null); setOkMsg(null)
    try {
      if (tab === 'email') {
        const recipients = to.split(',').map(s => s.trim()).filter(Boolean)
        if (recipients.length === 0) throw new Error('At least one recipient is required')
        await api.post('/notify/email', {
          to: recipients.length === 1 ? recipients[0] : recipients,
          subject, body, context: baseContext,
        })
        setOkMsg(`Sent to ${recipients.length} recipient(s).`)
      } else {
        await api.post('/notify/teams', {
          message,
          webhookUrl: webhookUrl.trim() || undefined,
          context: baseContext,
        })
        setOkMsg('Posted to Teams.')
      }
    } catch (ex: any) {
      setErr(ex?.response?.data?.error ?? ex?.message ?? 'Send failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      role="dialog" aria-modal="true"
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 100,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(15,23,42,0.55)', backdropFilter: 'blur(2px)',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 540, maxWidth: '92vw', maxHeight: '85vh',
          background: 'var(--color-surface)', borderRadius: 14,
          boxShadow: '0 20px 60px rgba(0,0,0,0.35)',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
          border: '1px solid var(--color-outline-variant)',
        }}
      >
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '12px 16px', borderBottom: '1px solid var(--color-outline-variant)',
        }}>
          <h3 style={{ fontSize: 14, fontWeight: 700, color: 'var(--color-on-surface)', margin: 0 }}>
            Send notification
          </h3>
          <button
            onClick={onClose}
            style={{ width: 28, height: 28, borderRadius: 8, border: '1px solid var(--color-outline-variant)', background: 'transparent', cursor: 'pointer', color: 'var(--color-outline)' }}
          >
            ✕
          </button>
        </div>

        <div style={{ padding: 14, overflow: 'auto' }}>
          <div style={{ display: 'inline-flex', gap: 4, padding: 3, borderRadius: 8, border: '1px solid var(--color-outline-variant)', marginBottom: 12 }}>
            {(['email', 'teams'] as const).map(t => (
              <button
                key={t}
                onClick={() => setTab(t)}
                style={{
                  padding: '4px 12px', borderRadius: 5, border: 'none', cursor: 'pointer',
                  background: tab === t ? 'var(--color-primary)' : 'transparent',
                  color:      tab === t ? '#fff' : 'var(--color-outline)',
                  fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
                }}
              >
                {t}
              </button>
            ))}
          </div>

          {tab === 'email' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <FieldLabel>To (comma-separated)</FieldLabel>
              <input value={to} onChange={e => setTo(e.target.value)} placeholder="alice@example.com, bob@example.com" style={inputBox()} />
              <FieldLabel>Subject</FieldLabel>
              <input value={subject} onChange={e => setSubject(e.target.value)} style={inputBox()} />
              <FieldLabel>Body</FieldLabel>
              <textarea value={body} onChange={e => setBody(e.target.value)} rows={6} style={{ ...inputBox(), resize: 'vertical', fontFamily: 'monospace' }} />
              <p style={{ fontSize: 10, color: 'var(--color-outline)' }}>
                Tokens: <code style={{ fontFamily: 'monospace' }}>{'{{run.name}}'}</code>{' · '}
                <code style={{ fontFamily: 'monospace' }}>{'{{vars.X}}'}</code>{' · '}
                <code style={{ fontFamily: 'monospace' }}>{'{{globals.X}}'}</code>{' · '}
                <code style={{ fontFamily: 'monospace' }}>{'{{output.X}}'}</code>
              </p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <FieldLabel>Message</FieldLabel>
              <textarea value={message} onChange={e => setMessage(e.target.value)} rows={4} style={{ ...inputBox(), resize: 'vertical', fontFamily: 'monospace' }} />
              <FieldLabel>Override webhook URL (optional)</FieldLabel>
              <input value={webhookUrl} onChange={e => setWebhookUrl(e.target.value)} placeholder="https://outlook.office.com/webhook/…" style={inputBox()} />
              <p style={{ fontSize: 10, color: 'var(--color-outline)' }}>
                If left blank, the connector's default Teams webhook (or Graph channel) is used.
              </p>
            </div>
          )}

          {err && (
            <div style={{ marginTop: 10, padding: '7px 10px', borderRadius: 7, background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c', fontSize: 11 }}>
              {err}
            </div>
          )}
          {okMsg && (
            <div style={{ marginTop: 10, padding: '7px 10px', borderRadius: 7, background: '#ecfdf5', border: '1px solid #a7f3d0', color: '#047857', fontSize: 11 }}>
              {okMsg}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', padding: 12, borderTop: '1px solid var(--color-outline-variant)' }}>
          <button onClick={onClose} style={{ padding: '7px 14px', borderRadius: 8, border: '1px solid var(--color-outline-variant)', background: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
            Close
          </button>
          <button onClick={send} disabled={busy} style={{ padding: '7px 14px', borderRadius: 8, border: 'none', background: 'var(--color-primary)', color: '#fff', fontSize: 12, fontWeight: 700, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1 }}>
            {busy ? 'Sending…' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  )
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <label style={{ fontSize: 9, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
      {children}
    </label>
  )
}

function inputBox(): React.CSSProperties {
  return {
    width: '100%', boxSizing: 'border-box', padding: '7px 10px', borderRadius: 7,
    border: '1px solid var(--color-outline-variant)', fontSize: 12,
    outline: 'none', fontFamily: 'inherit', color: 'var(--color-on-surface)',
  }
}

function CenteredMessage({ icon, title, subtitle }: { icon: React.ReactNode; title: string; subtitle?: string }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      height: '100%', gap: 10, color: 'var(--color-outline)', textAlign: 'center', padding: 24,
    }}>
      {icon}
      <h3 style={{ fontSize: 16, fontWeight: 700, color: 'var(--color-on-surface)' }}>{title}</h3>
      {subtitle && <p style={{ fontSize: 12 }}>{subtitle}</p>}
    </div>
  )
}
