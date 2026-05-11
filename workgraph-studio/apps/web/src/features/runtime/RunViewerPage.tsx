import { useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { motion, AnimatePresence } from 'motion/react'
import {
  ArrowLeft, CheckCircle2, Circle, Clock, AlertCircle, Workflow as WorkflowIcon,
  Pause, Play as PlayIcon, RotateCw, GitFork,
} from 'lucide-react'
import { api } from '../../lib/api'
import { RuntimeWidgetForm, type RuntimeFormSubmitTarget } from '../forms/widgets/RuntimeWidgetForm'
import type { FormWidget } from '../forms/widgets/types'
import { LiveEventsPanel } from './LiveEventsPanel'
import { CodeChangesPanel } from './CodeChangesPanel'

/**
 * Step-by-step run viewer.  Lays out the run as a vertical timeline of steps;
 * the *current* step expands inline with the form-fill panel, completed steps
 * collapse to a summary, pending steps grey out.
 *
 * Reuses the same form-fill component the inbox uses, so submission /
 * complete behaviour is identical — just presented in run-context.
 */
export function RunViewerPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const { data: instance, isLoading } = useQuery<{
    id: string; name: string; status: string;
    templateId?: string; templateVersion?: number | null;
    createdAt: string; startedAt?: string;
  }>({
    queryKey: ['run-instance', id],
    queryFn:  () => api.get(`/workflow-instances/${id}`).then(r => r.data),
    enabled: !!id, refetchInterval: 5_000,
  })

  const { data: nodes = [] } = useQuery<RunNode[]>({
    queryKey: ['run-instance', id, 'nodes'],
    queryFn:  () => api.get(`/workflow-instances/${id}/nodes`).then(r => r.data),
    enabled: !!id, refetchInterval: 5_000,
  })

  const { data: edges = [] } = useQuery<RunEdge[]>({
    queryKey: ['run-instance', id, 'edges'],
    queryFn:  () => api.get(`/workflow-instances/${id}/edges`).then(r => r.data),
    enabled: !!id, refetchInterval: 5_000,
  })

  // Order nodes topologically (best-effort) so the timeline reads in
  // execution order.  Falls back to createdAt order if the graph has cycles
  // (FOREACH/EVENT_GATEWAY can produce them).
  const ordered = useMemo(() => topologicalOrder(nodes, edges), [nodes, edges])

  if (!id) return null
  if (isLoading) return <p style={{ padding: 24, color: 'var(--color-outline)' }}>Loading run…</p>
  if (!instance)  return <p style={{ padding: 24, color: '#ef4444' }}>Run not found.</p>

  const counts = {
    total:     ordered.length,
    completed: ordered.filter(n => n.status === 'COMPLETED').length,
    active:    ordered.filter(n => n.status === 'ACTIVE').length,
    failed:    ordered.filter(n => n.status === 'FAILED').length,
  }
  const progress = counts.total > 0 ? Math.round((counts.completed / counts.total) * 100) : 0

  return (
    <div style={{ padding: 24, maxWidth: 880, margin: '0 auto' }}>
      <button
        onClick={() => navigate(-1)}
        style={{
          display: 'flex', alignItems: 'center', gap: 5, padding: '5px 10px', borderRadius: 7,
          border: '1px solid var(--color-outline-variant)', background: 'transparent',
          cursor: 'pointer', color: 'var(--color-outline)', fontSize: 12, fontWeight: 600, marginBottom: 14,
        }}
      >
        <ArrowLeft size={12} /> Back
      </button>

      {/* Run header */}
      <div style={{
        display: 'flex', alignItems: 'flex-start', gap: 14,
        padding: '14px 16px', borderRadius: 12, marginBottom: 18,
        background: '#fff', border: '1px solid var(--color-outline-variant)',
      }}>
        <div style={{
          width: 38, height: 38, borderRadius: 10,
          background: 'rgba(14,165,233,0.10)', border: '1px solid rgba(14,165,233,0.25)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#0ea5e9',
          flexShrink: 0,
        }}>
          <GitFork size={17} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <h1 style={{ fontSize: 16, fontWeight: 800, color: 'var(--color-on-surface)', letterSpacing: '-0.01em' }}>
              {instance.name}
            </h1>
            <StatusChip status={instance.status} />
            {/* M24 — entry into the timing + cost + artifacts dashboard */}
            <button
              onClick={() => navigate(`/runs/${instance.id}/insights`)}
              style={{
                fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 4,
                background: 'rgba(0,132,61,0.10)', color: '#00843D',
                border: '1px solid rgba(0,132,61,0.22)', cursor: 'pointer',
                letterSpacing: '0.06em', textTransform: 'uppercase',
              }}
              title="Open run insights — duration per step, cost, artifacts produced"
            >
              Insights →
            </button>
            {typeof instance.templateVersion === 'number' && (
              <span title={`Cloned from design v${instance.templateVersion}`} style={{
                fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 4,
                background: 'rgba(99,102,241,0.10)', color: '#6366f1',
                border: '1px solid rgba(99,102,241,0.20)', fontFamily: 'monospace',
              }}>
                v{instance.templateVersion}
              </span>
            )}
          </div>
          <p style={{ fontSize: 11, color: 'var(--color-outline)', marginTop: 4 }}>
            Started {instance.startedAt ? new Date(instance.startedAt).toLocaleString() : '—'} ·{' '}
            {counts.completed}/{counts.total} steps complete · {progress}% done
            {counts.active  > 0 && ` · ${counts.active} active`}
            {counts.failed  > 0 && ` · ${counts.failed} failed`}
          </p>
          {/* Progress bar */}
          <div style={{ height: 4, marginTop: 8, borderRadius: 2, background: 'rgba(0,0,0,0.05)', overflow: 'hidden' }}>
            <div style={{
              width: `${progress}%`, height: '100%',
              background: 'linear-gradient(to right, #0ea5e9, #00843D)',
              transition: 'width 0.3s ease',
            }} />
          </div>
        </div>
      </div>

      {/* Step timeline */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {ordered.map((node, i) => (
          <StepCard
            key={node.id}
            node={node}
            instanceId={id}
            instanceName={instance.name}
            position={i + 1}
            isLast={i === ordered.length - 1}
          />
        ))}
      </div>

      {/* M9.y — live MCP event tap, scoped to this run */}
      {id && <LiveEventsPanel runId={id} />}

      {/* M13 — structured code-change provenance, joined via cf call_log */}
      {id && <CodeChangesPanel runId={id} />}
    </div>
  )
}

// ── Per-step card ───────────────────────────────────────────────────────────

function StepCard({
  node, instanceId, instanceName, position, isLast,
}: {
  node: RunNode
  instanceId: string
  instanceName: string
  position: number
  isLast: boolean
}) {
  const visual = STATUS_VISUAL[node.status] ?? STATUS_VISUAL.PENDING
  const isActive    = node.status === 'ACTIVE'
  const isCompleted = node.status === 'COMPLETED'
  const isFailed    = node.status === 'FAILED'

  // The inline form-fill panel is only useful for HUMAN_TASK / APPROVAL /
  // CONSUMABLE_CREATION nodes that have a defined widget form.
  const fillKind: 'task' | 'approval' | 'consumable' | null = (() => {
    const t = node.nodeType
    if (t === 'HUMAN_TASK')          return 'task'
    if (t === 'APPROVAL')            return 'approval'
    if (t === 'CONSUMABLE_CREATION') return 'consumable'
    return null
  })()

  const formWidgets = (node.config?.formWidgets ?? null) as FormWidget[] | null

  return (
    <div style={{ position: 'relative' }}>
      {/* Vertical connector line */}
      {!isLast && (
        <div style={{
          position: 'absolute', left: 18, top: 38, bottom: -10, width: 2,
          background: isCompleted ? '#22c55e' : 'var(--color-outline-variant)',
          opacity: 0.5,
        }} />
      )}

      <div style={{
        display: 'flex', gap: 12,
        padding: '14px 16px', borderRadius: 11,
        background: isActive ? 'rgba(14,165,233,0.05)' : '#fff',
        border: `1px solid ${isActive ? 'rgba(14,165,233,0.30)' : 'var(--color-outline-variant)'}`,
      }}>
        {/* Status orb + position number */}
        <div style={{
          width: 38, height: 38, borderRadius: '50%', flexShrink: 0,
          background: visual.bg, border: `2px solid ${visual.border}`,
          color: visual.color,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 11, fontWeight: 800,
        }}>
          {isCompleted ? <CheckCircle2 size={16} />
            : isActive  ? <visual.Icon size={16} />
            : isFailed  ? <AlertCircle size={16} />
            : <span>{position}</span>}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-on-surface)' }}>
              {node.label}
            </span>
            <span style={{ fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 3, color: visual.color, background: visual.tagBg, letterSpacing: '0.08em', textTransform: 'uppercase', fontFamily: 'monospace' }}>
              {node.status}
            </span>
            <span style={{ fontSize: 9, color: 'var(--color-outline)', fontFamily: 'monospace' }}>
              {node.nodeType}
            </span>
          </div>

          {/* Active step: inline form fill (when applicable) */}
          <AnimatePresence>
            {isActive && fillKind && formWidgets && formWidgets.length > 0 && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.18 }}
                style={{ overflow: 'hidden', marginTop: 12 }}
              >
                <ActiveStepFill
                  node={node}
                  instanceId={instanceId}
                  instanceName={instanceName}
                  kind={fillKind}
                  widgets={formWidgets}
                />
              </motion.div>
            )}
          </AnimatePresence>

          {/* Active step without form: simple "Mark complete" prompt */}
          {isActive && (!fillKind || !formWidgets || formWidgets.length === 0) && (
            <div style={{ marginTop: 10, padding: '8px 12px', borderRadius: 8, background: 'rgba(14,165,233,0.06)', border: '1px solid rgba(14,165,233,0.20)' }}>
              <p style={{ fontSize: 11, color: '#0c4a6e' }}>
                Waiting for the runtime to advance.  HUMAN_TASK / APPROVAL nodes show a form-fill here when they're claimable;
                automated nodes complete on their own.
              </p>
            </div>
          )}

          {/* Completed: any submitted form data shows below */}
          {isCompleted && fillKind && formWidgets && formWidgets.length > 0 && (
            <CompletedStepSummary node={node} instanceId={instanceId} kind={fillKind} widgets={formWidgets} />
          )}
        </div>
      </div>
    </div>
  )
}

// ── Active fill sub-component (queries the runtime entity, renders form) ────

function ActiveStepFill({
  node, instanceId, instanceName, kind, widgets,
}: {
  node: RunNode
  instanceId: string
  instanceName: string
  kind: 'task' | 'approval' | 'consumable'
  widgets: FormWidget[]
}) {
  const path =
    kind === 'task'     ? '/tasks' :
    kind === 'approval' ? '/approvals' :
                          '/consumables'

  const { data, refetch } = useQuery<{ data?: any[] } | any[]>({
    queryKey: ['run-fill-entity', kind, node.id, instanceId],
    queryFn:  () => api.get(path, { params: { nodeId: node.id, instanceId } }).then(r => r.data),
    enabled:  !!node.id && !!instanceId,
  })

  const entity = (() => {
    if (!data) return null
    if (Array.isArray(data)) return data[0] ?? null
    if (Array.isArray((data as any).data)) return (data as any).data[0] ?? null
    return null
  })() as { id: string; formData?: Record<string, unknown>; attachments?: any[] } | null

  if (!entity) {
    return (
      <p style={{ fontSize: 11, color: 'var(--color-outline)', fontStyle: 'italic', marginTop: 8 }}>
        Waiting for the {kind} record to be created…
      </p>
    )
  }

  const submitTo: RuntimeFormSubmitTarget = { kind, id: entity.id }
  return (
    <div style={{ background: '#fafafa', padding: 12, borderRadius: 9, border: '1px solid var(--color-outline-variant)' }}>
      <p style={{ fontSize: 10, color: 'var(--color-outline)', marginBottom: 8 }}>
        Fill the form below to complete this step. Run: <strong>{instanceName}</strong>.
      </p>
      <RuntimeWidgetForm
        widgets={widgets}
        submitTo={submitTo}
        link={{ taskId: kind === 'task' ? entity.id : undefined, nodeId: node.id, instanceId }}
        initialData={(entity.formData as Record<string, unknown>) ?? {}}
        initialAttachments={Array.isArray(entity.attachments) ? entity.attachments : []}
        canComplete={true}
        onSubmitted={() => refetch()}
      />
    </div>
  )
}

function CompletedStepSummary({
  node, instanceId, kind, widgets,
}: {
  node: RunNode
  instanceId: string
  kind: 'task' | 'approval' | 'consumable'
  widgets: FormWidget[]
}) {
  void widgets // referenced for parity; submitted data is sufficient as summary
  const path =
    kind === 'task'     ? '/tasks' :
    kind === 'approval' ? '/approvals' :
                          '/consumables'

  const { data } = useQuery<{ data?: any[] } | any[]>({
    queryKey: ['run-completed-entity', kind, node.id, instanceId],
    queryFn:  () => api.get(path, { params: { nodeId: node.id, instanceId } }).then(r => r.data),
    enabled:  !!node.id && !!instanceId,
  })
  const entity = (() => {
    if (!data) return null
    if (Array.isArray(data)) return data[0] ?? null
    if (Array.isArray((data as any).data)) return (data as any).data[0] ?? null
    return null
  })() as { id: string; formData?: Record<string, unknown> } | null
  if (!entity?.formData || Object.keys(entity.formData).length === 0) return null

  return (
    <details style={{ marginTop: 8 }}>
      <summary style={{ fontSize: 10, color: 'var(--color-outline)', cursor: 'pointer' }}>
        Submitted data
      </summary>
      <pre style={{
        marginTop: 6, padding: 9, borderRadius: 7,
        background: '#f8fafc', border: '1px solid var(--color-outline-variant)',
        fontSize: 10, fontFamily: 'monospace', color: '#334155',
        overflowX: 'auto',
      }}>
        {JSON.stringify(entity.formData, null, 2)}
      </pre>
    </details>
  )
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function StatusChip({ status }: { status: string }) {
  const v = STATUS_VISUAL[status] ?? STATUS_VISUAL.PENDING
  return (
    <span style={{
      fontSize: 9, fontWeight: 700, padding: '3px 8px', borderRadius: 6,
      background: v.tagBg, color: v.color, border: `1px solid ${v.border}`,
      letterSpacing: '0.12em', textTransform: 'uppercase', fontFamily: 'monospace',
    }}>
      {status}
    </span>
  )
}

const STATUS_VISUAL: Record<string, {
  bg: string; border: string; color: string; tagBg: string; Icon: React.ElementType
}> = {
  PENDING:    { bg: '#f1f5f9', border: 'var(--color-outline-variant)', color: '#64748b',
                tagBg: 'rgba(100,116,139,0.10)', Icon: Circle },
  ACTIVE:     { bg: 'rgba(14,165,233,0.12)', border: 'rgba(14,165,233,0.30)', color: '#0ea5e9',
                tagBg: 'rgba(14,165,233,0.10)', Icon: Clock },
  COMPLETED:  { bg: 'rgba(34,197,94,0.12)',  border: 'rgba(34,197,94,0.30)',  color: '#22c55e',
                tagBg: 'rgba(34,197,94,0.10)',  Icon: CheckCircle2 },
  FAILED:     { bg: 'rgba(239,68,68,0.10)',  border: 'rgba(239,68,68,0.25)',  color: '#ef4444',
                tagBg: 'rgba(239,68,68,0.10)',  Icon: AlertCircle },
  PAUSED:     { bg: 'rgba(245,158,11,0.10)', border: 'rgba(245,158,11,0.25)', color: '#f59e0b',
                tagBg: 'rgba(245,158,11,0.10)', Icon: Pause },
  CANCELLED:  { bg: 'rgba(100,116,139,0.10)', border: 'rgba(100,116,139,0.25)', color: '#64748b',
                tagBg: 'rgba(100,116,139,0.10)', Icon: PlayIcon },
  RETRYING:   { bg: 'rgba(245,158,11,0.10)', border: 'rgba(245,158,11,0.25)', color: '#f59e0b',
                tagBg: 'rgba(245,158,11,0.10)', Icon: RotateCw },
}

// Topological order with stable fallback to createdAt.
type RunNode = {
  id: string; nodeType: string; label: string; status: string;
  config: Record<string, unknown>;
  createdAt?: string;
}
type RunEdge = { id: string; sourceNodeId: string; targetNodeId: string; edgeType: string }

function topologicalOrder(nodes: RunNode[], edges: RunEdge[]): RunNode[] {
  if (nodes.length === 0) return []
  const byId    = new Map(nodes.map(n => [n.id, n]))
  const inDeg   = new Map<string, number>()
  const fwd     = new Map<string, string[]>()
  for (const n of nodes) { inDeg.set(n.id, 0); fwd.set(n.id, []) }
  for (const e of edges) {
    if (!byId.has(e.sourceNodeId) || !byId.has(e.targetNodeId)) continue
    fwd.get(e.sourceNodeId)!.push(e.targetNodeId)
    inDeg.set(e.targetNodeId, (inDeg.get(e.targetNodeId) ?? 0) + 1)
  }
  // Kahn's algorithm with createdAt-based tiebreak so order is stable.
  const ready: string[] = []
  for (const [id, deg] of inDeg) if (deg === 0) ready.push(id)
  const cmpCreated = (a: string, b: string) => {
    const ax = byId.get(a)?.createdAt ?? ''
    const bx = byId.get(b)?.createdAt ?? ''
    return ax.localeCompare(bx)
  }
  ready.sort(cmpCreated)
  const out: RunNode[] = []
  while (ready.length > 0) {
    const id = ready.shift()!
    const n = byId.get(id); if (n) out.push(n)
    for (const next of fwd.get(id) ?? []) {
      const d = (inDeg.get(next) ?? 0) - 1
      inDeg.set(next, d)
      if (d === 0) {
        // insert keeping created-order
        const idx = ready.findIndex(r => cmpCreated(r, next) > 0)
        if (idx === -1) ready.push(next)
        else ready.splice(idx, 0, next)
      }
    }
  }
  // Cycle: append leftover nodes by createdAt
  if (out.length < nodes.length) {
    const seen = new Set(out.map(n => n.id))
    const rest = nodes.filter(n => !seen.has(n.id)).sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''))
    out.push(...rest)
  }
  return out
}

void WorkflowIcon  // referenced for icon catalog parity; not used directly
