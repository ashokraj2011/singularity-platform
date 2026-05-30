import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { motion, AnimatePresence } from 'motion/react'
import {
  ArrowLeft, CheckCircle2, Circle, Clock, AlertCircle, Workflow as WorkflowIcon,
  Pause, Play as PlayIcon, RotateCw, GitFork, Network, ExternalLink,
} from 'lucide-react'
import { api } from '../../lib/api'
import { RuntimeWidgetForm, type RuntimeFormSubmitTarget } from '../forms/widgets/RuntimeWidgetForm'
import { widgetHasValue, type FormWidget } from '../forms/widgets/types'
import { LiveEventsPanel } from './LiveEventsPanel'
import { CodeChangesPanel } from './CodeChangesPanel'
import { CapabilityPicker } from '../../components/lookup/EntityPickers'
import { useCapabilityLabels } from './useCapabilityLabels'

const BLUEPRINT_WORKBENCH_URL = import.meta.env.VITE_BLUEPRINT_WORKBENCH_URL
  ?? `${window.location.protocol}//${window.location.hostname}:5176/`
const BLUEPRINT_WORKBENCH_ORIGIN = new URL(BLUEPRINT_WORKBENCH_URL, window.location.href).origin

// Terminal workflow-instance statuses — mirror of the runtime's own set in
// WorkflowRuntime.ts (COMPLETED | CANCELLED | FAILED). Once a run reaches one
// of these it can no longer change, so the live polls should fall silent
// instead of hammering the API at 5s forever on a finished run.
const TERMINAL_RUN_STATUSES = new Set(['COMPLETED', 'CANCELLED', 'FAILED'])
function isTerminalRunStatus(status: string | undefined | null): boolean {
  return TERMINAL_RUN_STATUSES.has((status ?? '').toUpperCase())
}

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

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.origin !== BLUEPRINT_WORKBENCH_ORIGIN) return
      const data = event.data
      if (!data || typeof data !== 'object' || data.type !== 'blueprintWorkbench.auth.request') return
      const token = readWorkgraphToken()
      if (token && event.source && 'postMessage' in event.source) {
        ;(event.source as Window).postMessage({ type: 'blueprintWorkbench.auth', token }, event.origin)
      }
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [])

  const { data: instance, isLoading } = useQuery<{
    id: string; name: string; status: string;
    templateId?: string; templateVersion?: number | null;
    createdAt: string; startedAt?: string;
    context?: Record<string, unknown>;
  }>({
    queryKey: ['run-instance', id],
    queryFn:  () => api.get(`/workflow-instances/${id}`).then(r => r.data),
    enabled: !!id,
    // Poll only while the run is still live; stop once it reaches a terminal
    // status. staleTime just under the interval keeps remounts/focus from
    // piling an extra fetch onto the 5s cadence.
    refetchInterval: (query) =>
      isTerminalRunStatus(query.state.data?.status) ? false : 5_000,
    staleTime: 4_750,
  })

  // Derived from the instance status above; gates the nodes/edges polls so
  // they also fall silent on a finished run instead of polling indefinitely.
  const isRunLive = !isTerminalRunStatus(instance?.status)

  const { data: nodes = [] } = useQuery<RunNode[]>({
    queryKey: ['run-instance', id, 'nodes'],
    queryFn:  () => api.get(`/workflow-instances/${id}/nodes`).then(r => r.data),
    enabled: !!id, refetchInterval: isRunLive ? 5_000 : false, staleTime: 4_750,
  })

  const { data: edges = [] } = useQuery<RunEdge[]>({
    queryKey: ['run-instance', id, 'edges'],
    queryFn:  () => api.get(`/workflow-instances/${id}/edges`).then(r => r.data),
    enabled: !!id, refetchInterval: isRunLive ? 5_000 : false, staleTime: 4_750,
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
            {/* Mission Control — live evidence, timing, budget, artifacts, receipts. */}
            <button
              onClick={() => navigate(`/mission-control/${instance.id}`)}
              style={{
                fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 4,
                background: 'rgba(0,132,61,0.10)', color: '#00843D',
                border: '1px solid rgba(0,132,61,0.22)', cursor: 'pointer',
                letterSpacing: '0.06em', textTransform: 'uppercase',
              }}
              title="Open Mission Control — live events, receipts, budget, artifacts, code evidence"
            >
              Mission Control →
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
            instanceContext={asRecord(instance.context)}
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
  node, instanceId, instanceName, instanceContext, position, isLast,
}: {
  node: RunNode
  instanceId: string
  instanceName: string
  instanceContext: Record<string, unknown>
  position: number
  isLast: boolean
}) {
  const visual = STATUS_VISUAL[node.status] ?? STATUS_VISUAL.PENDING
  const isActive    = node.status === 'ACTIVE'
  const isCompleted = node.status === 'COMPLETED'
  const isFailed    = node.status === 'FAILED'
  const isBlocked   = node.status === 'BLOCKED'
  const blockDetails = blockingDetailsForNode(node, instanceContext)
  const queryClient = useQueryClient()
  const restartMut = useMutation({
    mutationFn: () => api.post(`/workflow-instances/${instanceId}/nodes/${node.id}/restart`).then(r => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['run-instance', instanceId] })
      queryClient.invalidateQueries({ queryKey: ['run-instance', instanceId, 'nodes'] })
      queryClient.invalidateQueries({ queryKey: ['run-instance', instanceId, 'edges'] })
    },
  })
  const canRestart = node.status === 'COMPLETED' || node.status === 'FAILED' || node.status === 'BLOCKED'

  // M98 — Operator escape hatch: mark any non-completed node done with a
  // comment and advance the workflow. Unblocks runs stuck on a failed/blocked
  // node (e.g. a GitHub push the operator finished by hand).
  const [showComplete, setShowComplete] = useState(false)
  const [completeComment, setCompleteComment] = useState('')
  const forceCompleteMut = useMutation({
    mutationFn: (comment: string) =>
      api.post(`/workflow-instances/${instanceId}/nodes/${node.id}/force-complete`, { comment }).then(r => r.data),
    onSuccess: () => {
      setShowComplete(false)
      setCompleteComment('')
      queryClient.invalidateQueries({ queryKey: ['run-instance', instanceId] })
      queryClient.invalidateQueries({ queryKey: ['run-instance', instanceId, 'nodes'] })
      queryClient.invalidateQueries({ queryKey: ['run-instance', instanceId, 'edges'] })
    },
  })
  const canForceComplete = node.status !== 'COMPLETED' && node.status !== 'SKIPPED'

  const restartLabel = node.nodeType === 'GIT_PUSH' && blockDetails?.retryable
    ? (restartMut.isPending ? 'Retrying push...' : 'Retry push')
    : (restartMut.isPending ? 'Restarting...' : 'Restart stage')
  const restartTitle = node.nodeType === 'GIT_PUSH' && blockDetails?.retryable
    ? 'Retry only this Git Push node after fixing credentials or remote access'
    : 'Reset this stage and downstream stages, then run this stage again'

  // The inline form-fill panel is only useful for HUMAN_TASK / APPROVAL /
  // CONSUMABLE_CREATION nodes that have a defined widget form. WORK_ITEM
  // has its own packet/target panel below.
  const fillKind: 'task' | 'approval' | 'consumable' | null = (() => {
    const t = node.nodeType
    if (t === 'HUMAN_TASK')          return 'task'
    if (t === 'APPROVAL')            return 'approval'
    if (t === 'CONSUMABLE_CREATION') return 'consumable'
    return null
  })()

  const formWidgets = (node.config?.formWidgets ?? null) as FormWidget[] | null
  const hasFormWidgets = Boolean(formWidgets && formWidgets.length > 0)

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
            : isFailed || isBlocked ? <AlertCircle size={16} />
            : <span>{position}</span>}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-on-surface)' }}>
              {node.label}
            </span>
            <span style={{ fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 3, color: visual.color, background: visual.tagBg, letterSpacing: '0.08em', textTransform: 'uppercase', fontFamily: 'monospace' }}>
              {node.status}
            </span>
            <span style={{ fontSize: 9, color: 'var(--color-outline)', fontFamily: 'monospace' }}>
              {node.nodeType}
            </span>
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
              {canForceComplete && (
                <button
                  type="button"
                  style={{
                    ...smallSecondaryButton,
                    padding: '5px 8px',
                    fontSize: 10,
                    opacity: forceCompleteMut.isPending ? 0.65 : 1,
                  }}
                  disabled={forceCompleteMut.isPending}
                  onClick={() => setShowComplete(v => !v)}
                  title="Mark this node complete with a comment and advance the workflow without re-running it"
                >
                  <CheckCircle2 size={12} />
                  {forceCompleteMut.isPending ? 'Completing...' : 'Complete & advance'}
                </button>
              )}
              {canRestart && (
                <button
                  type="button"
                  style={{
                    ...smallSecondaryButton,
                    padding: '5px 8px',
                    fontSize: 10,
                    opacity: restartMut.isPending ? 0.65 : 1,
                  }}
                  disabled={restartMut.isPending}
                  onClick={() => restartMut.mutate()}
                  title={restartTitle}
                >
                  <RotateCw size={12} />
                  {restartLabel}
                </button>
              )}
            </div>
          </div>

          {/* M98 — Inline operator comment box for manual completion */}
          {showComplete && canForceComplete && (
            <div style={{
              marginTop: 10,
              padding: 10,
              borderRadius: 8,
              background: 'rgba(34,197,94,0.06)',
              border: '1px solid rgba(34,197,94,0.30)',
              display: 'grid',
              gap: 8,
            }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: '#166534' }}>
                Manually complete this node and advance the workflow. Add a comment explaining why (it is recorded in the audit trail).
              </span>
              <textarea
                value={completeComment}
                onChange={e => setCompleteComment(e.target.value)}
                placeholder="e.g. Pushed the branch to GitHub by hand after the token was rotated."
                rows={3}
                maxLength={1000}
                style={{
                  width: '100%',
                  resize: 'vertical',
                  padding: '8px 10px',
                  borderRadius: 7,
                  border: '1px solid var(--color-outline-variant)',
                  fontSize: 11,
                  fontFamily: 'inherit',
                  boxSizing: 'border-box',
                }}
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button
                  type="button"
                  style={{
                    ...smallPrimaryButton,
                    background: '#16a34a',
                    padding: '6px 10px',
                    fontSize: 11,
                    opacity: !completeComment.trim() || forceCompleteMut.isPending ? 0.55 : 1,
                  }}
                  disabled={!completeComment.trim() || forceCompleteMut.isPending}
                  onClick={() => forceCompleteMut.mutate(completeComment.trim())}
                >
                  <CheckCircle2 size={12} />
                  {forceCompleteMut.isPending ? 'Completing...' : 'Confirm complete'}
                </button>
                <button
                  type="button"
                  style={{ ...smallSecondaryButton, padding: '6px 10px', fontSize: 11 }}
                  disabled={forceCompleteMut.isPending}
                  onClick={() => { setShowComplete(false); setCompleteComment('') }}
                >
                  Cancel
                </button>
              </div>
              {forceCompleteMut.isError && (
                <p style={{ margin: 0, fontSize: 11, color: '#991b1b' }}>
                  {(forceCompleteMut.error as Error).message}
                </p>
              )}
            </div>
          )}

          {blockDetails && (
            <div style={{
              marginTop: 10,
              padding: 10,
              borderRadius: 8,
              background: 'rgba(245,158,11,0.08)',
              border: '1px solid rgba(245,158,11,0.28)',
              display: 'grid',
              gap: 6,
            }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                <AlertCircle size={14} style={{ color: '#d97706', marginTop: 1 }} />
                <div style={{ flex: 1 }}>
                  <strong style={{ display: 'block', fontSize: 12, color: '#92400e' }}>
                    {blockDetails.title}
                  </strong>
                  <p style={{ margin: '3px 0 0', fontSize: 11, color: '#92400e', lineHeight: 1.45 }}>
                    {blockDetails.message}
                  </p>
                </div>
              </div>
              {blockDetails.details.length > 0 && (
                <details>
                  <summary style={{ fontSize: 10, fontWeight: 800, color: '#92400e', cursor: 'pointer' }}>
                    Technical details
                  </summary>
                  <dl style={{
                    margin: '6px 0 0',
                    display: 'grid',
                    gridTemplateColumns: 'max-content minmax(0, 1fr)',
                    gap: '4px 10px',
                    fontSize: 10,
                    color: '#78350f',
                  }}>
                    {blockDetails.details.map(item => (
                      <FragmentRow key={item.label} label={item.label} value={item.value} />
                    ))}
                  </dl>
                </details>
              )}
              {blockDetails.fixCommands.length > 0 && (
                <div style={{ display: 'grid', gap: 5 }}>
                  <strong style={{ fontSize: 10, color: '#92400e', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                    Fix commands
                  </strong>
                  <pre style={{
                    margin: 0,
                    padding: 8,
                    borderRadius: 7,
                    background: 'rgba(15,23,42,0.08)',
                    color: '#78350f',
                    fontSize: 10,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}>{blockDetails.fixCommands.join('\n')}</pre>
                </div>
              )}
              {restartMut.isError && (
                <p style={{ margin: 0, fontSize: 11, color: '#991b1b' }}>
                  {(restartMut.error as Error).message}
                </p>
              )}
            </div>
          )}

          {!blockDetails && restartMut.isError && (
            <p style={{ margin: '8px 0 0', fontSize: 11, color: '#991b1b' }}>
              {(restartMut.error as Error).message}
            </p>
          )}

          {/* Active step: inline form fill (when applicable) */}
          <AnimatePresence>
            {isActive && fillKind && hasFormWidgets && (
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
                  widgets={formWidgets ?? []}
                />
              </motion.div>
            )}
          </AnimatePresence>

          {isActive && node.nodeType === 'WORK_ITEM' && (
            <WorkItemInlinePanel node={node} instanceId={instanceId} />
          )}

          {isActive && node.nodeType === 'WORKBENCH_TASK' && (
            <WorkbenchTaskInlinePanel node={node} instanceId={instanceId} instanceContext={instanceContext} />
          )}

          {/* M94.7 — CALL_WORKFLOW: link to the spawned agent sub-run. */}
          {isActive && node.nodeType === 'CALL_WORKFLOW' && (
            <CallWorkflowInlinePanel node={node} />
          )}

          {isActive && node.nodeType === 'APPROVAL' && !hasFormWidgets && (
            <ApprovalInlinePanel node={node} instanceId={instanceId} />
          )}

          {/* Active step without form: simple "Mark complete" prompt */}
          {isActive && node.nodeType !== 'WORK_ITEM' && node.nodeType !== 'WORKBENCH_TASK' && node.nodeType !== 'CALL_WORKFLOW' && node.nodeType !== 'APPROVAL' && (!fillKind || !hasFormWidgets) && (
            <div style={{ marginTop: 10, padding: '8px 12px', borderRadius: 8, background: 'rgba(14,165,233,0.06)', border: '1px solid rgba(14,165,233,0.20)' }}>
              <p style={{ fontSize: 11, color: '#0c4a6e' }}>
                Waiting for the runtime to advance.  HUMAN_TASK / APPROVAL nodes show a form-fill here when they're claimable;
                automated nodes complete on their own.
              </p>
            </div>
          )}

          {isCompleted && node.nodeType === 'WORK_ITEM' && (
            <WorkItemInlinePanel node={node} instanceId={instanceId} compact />
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

function WorkbenchTaskInlinePanel({
  node,
  instanceId,
  instanceContext,
}: {
  node: RunNode
  instanceId: string
  instanceContext: Record<string, unknown>
}) {
  const workbenchConfig = asRecord(node.config?.workbench)
  const neoUrl = buildWorkbenchLaunchUrl(instanceId, node.id, workbenchConfig, 'neo', instanceContext)

  return (
    <div style={{
      marginTop: 10,
      padding: 12,
      borderRadius: 10,
      background: 'rgba(14,165,233,0.06)',
      border: '1px solid rgba(14,165,233,0.22)',
      display: 'grid',
      gap: 10,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9 }}>
        <WorkflowIcon size={16} style={{ color: '#0284c7', marginTop: 2 }} />
        <div>
          <strong style={{ display: 'block', fontSize: 12, color: 'var(--color-on-surface)' }}>
            Approve inside Blueprint Workbench first
          </strong>
          <p style={{ margin: '3px 0 0', fontSize: 11, lineHeight: 1.45, color: '#0c4a6e' }}>
            This workflow is waiting for the Workbench final pack. Open WorkbenchNeo, approve or send back the stage artifacts,
            then finalize the pack. After that, this run advances to “Human final sign-off,” where the normal approval form appears here and in Runtime Inbox.
          </p>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <a href={neoUrl} target="_blank" rel="opener" style={smallPrimaryButton}>
          <ExternalLink size={13} /> Open WorkbenchNeo
        </a>
      </div>
    </div>
  )
}

// M94.7 (2026-05-28) — Inline panel for an ACTIVE CALL_WORKFLOW node.
//
// When a workflow reaches a CALL_WORKFLOW stage (e.g. the agentic
// starter's "Run agent loop"), the node spawns a child sub-workflow and
// then waits for it to complete. Previously the run view showed only the
// generic "Waiting for the runtime to advance" text with no way to reach
// the child — so an operator couldn't open the agent workbench/sub-run
// once it reached that stage. This panel surfaces a direct link to the
// child sub-run (where the agent stages + their live events render, and
// any WORKBENCH_TASK stage shows its own "Open WorkbenchNeo" button).
//
// The child instance id is stamped on the node config as _childInstanceId
// by CallWorkflowExecutor once the child is spawned. Before that (brief
// window between activation and spawn) we show a spawning state.
function CallWorkflowInlinePanel({ node }: { node: RunNode }) {
  const navigate = useNavigate()
  const childInstanceId = typeof node.config?._childInstanceId === 'string'
    ? node.config._childInstanceId
    : null

  // M94.8 (2026-05-28) — One-click into the workbench. Fetch the child
  // instance's nodes; if a WORKBENCH_TASK exists, build the same
  // blueprint-workbench (:5176) launch URL the WorkbenchTaskInlinePanel
  // uses and offer "Open Workbench" directly — no intermediate
  // Mission-Control hop. Falls back to "Open agent sub-run" (the child's
  // run timeline) when the child has no workbench node (e.g. AGENT_TASK
  // stages that run headless).
  const { data: childNodes = [] } = useQuery<RunNode[]>({
    queryKey: ['run-instance', childInstanceId, 'nodes'],
    queryFn: () => api.get(`/workflow-instances/${childInstanceId}/nodes`).then(r => r.data),
    enabled: Boolean(childInstanceId),
    refetchInterval: 5_000,
  })
  const workbenchNode = childNodes.find(n => n.nodeType === 'WORKBENCH_TASK')
  const workbenchUrl = workbenchNode && childInstanceId
    ? buildWorkbenchLaunchUrl(childInstanceId, workbenchNode.id, asRecord(workbenchNode.config?.workbench), 'neo')
    : null

  return (
    <div style={{
      marginTop: 10,
      padding: 12,
      borderRadius: 10,
      background: 'rgba(124,58,237,0.06)',
      border: '1px solid rgba(124,58,237,0.22)',
      display: 'grid',
      gap: 10,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9 }}>
        <GitFork size={16} style={{ color: '#7c3aed', marginTop: 2 }} />
        <div>
          <strong style={{ display: 'block', fontSize: 12, color: 'var(--color-on-surface)' }}>
            Agent sub-workflow {childInstanceId ? 'running' : 'starting…'}
          </strong>
          <p style={{ margin: '3px 0 0', fontSize: 11, lineHeight: 1.45, color: '#5b21b6' }}>
            {childInstanceId
              ? (workbenchUrl
                  ? 'This stage runs the agent workbench (Story Intake → Design → Develop → QA). Open WorkbenchNeo to drive each stage with artifacts + approvals; this run advances automatically when the workbench finalizes.'
                  : 'This stage dispatched the agent loop as a sub-workflow. Open it to watch or drive each agent stage; this run advances automatically when the sub-workflow completes.')
              : 'The agent sub-workflow is being spawned. Refresh in a moment to open it.'}
          </p>
        </div>
      </div>
      {childInstanceId && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {workbenchUrl && (
            <a href={workbenchUrl} target="_blank" rel="opener" style={smallPrimaryButton}>
              <ExternalLink size={13} /> Open Workbench
            </a>
          )}
          <button
            type="button"
            style={workbenchUrl ? smallSecondaryButton : smallPrimaryButton}
            onClick={() => navigate(`/runs/${childInstanceId}`)}
          >
            <ExternalLink size={13} /> {workbenchUrl ? 'View sub-run' : 'Open agent sub-run'}
          </button>
        </div>
      )}
    </div>
  )
}

function ApprovalInlinePanel({ node, instanceId }: { node: RunNode; instanceId: string }) {
  const queryClient = useQueryClient()
  const approvalQuery = useQuery<ApprovalRow | null>({
    queryKey: ['runtime-approval', instanceId, node.id],
    queryFn: () => api.get('/approvals', {
      params: { instanceId, nodeId: node.id, status: 'PENDING', size: 1 },
    }).then(r => unwrapItems<ApprovalRow>(r.data)[0] ?? null),
    enabled: Boolean(instanceId && node.id),
    refetchInterval: 4_000,
  })

  const refreshRun = () => {
    approvalQuery.refetch()
    queryClient.invalidateQueries({ queryKey: ['run-instance', instanceId] })
    queryClient.invalidateQueries({ queryKey: ['run-instance', instanceId, 'nodes'] })
  }

  const ensureMut = useMutation({
    mutationFn: () => api.post(`/approvals/workflow-node/${node.id}/ensure`).then(r => r.data as ApprovalRow),
    onSuccess: refreshRun,
  })
  const decisionMut = useMutation({
    mutationFn: (decision: 'APPROVED' | 'REJECTED') => {
      const approval = approvalQuery.data
      if (!approval) throw new Error('Approval request is not ready yet')
      return api.post(`/approvals/${approval.id}/decision`, {
        decision,
        notes: decision === 'APPROVED'
          ? 'Approved from workflow run timeline'
          : 'Rejected from workflow run timeline',
      }).then(r => r.data)
    },
    onSuccess: refreshRun,
  })

  const shouldEnsureApproval =
    approvalQuery.isFetched &&
    !approvalQuery.data &&
    !approvalQuery.error &&
    !ensureMut.isPending &&
    !ensureMut.isSuccess &&
    !ensureMut.isError

  useEffect(() => {
    if (shouldEnsureApproval) ensureMut.mutate()
  }, [shouldEnsureApproval])

  const approval = approvalQuery.data
  const busy = approvalQuery.isLoading || ensureMut.isPending || decisionMut.isPending

  if (approvalQuery.isLoading) {
    return (
      <div style={approvalPanelStyle}>
        <Clock size={14} style={{ color: '#0284c7' }} />
        <p style={{ ...mutedTextStyle, color: '#0c4a6e' }}>Looking for the approval request...</p>
      </div>
    )
  }

  if (approvalQuery.error) {
    return (
      <div style={{ ...approvalPanelStyle, borderColor: 'rgba(239,68,68,0.25)', background: 'rgba(239,68,68,0.04)' }}>
        <AlertCircle size={14} style={{ color: '#dc2626' }} />
        <p style={{ ...mutedTextStyle, color: '#991b1b' }}>
          Unable to load approval request: {(approvalQuery.error as Error).message}
        </p>
      </div>
    )
  }

  if (!approval) {
    return (
      <div style={approvalPanelStyle}>
        <Clock size={14} style={{ color: '#0284c7' }} />
        <div style={{ flex: 1 }}>
          <strong style={{ display: 'block', fontSize: 12, color: 'var(--color-on-surface)' }}>
            Human sign-off is waiting for an approval record
          </strong>
          <p style={{ margin: '3px 0 0', fontSize: 11, color: '#0c4a6e', lineHeight: 1.45 }}>
            The workflow reached this approval node, but no pending approval request was found. The runtime is creating one now; if it does not appear, retry here.
          </p>
          {ensureMut.isError && (
            <p style={{ margin: '6px 0 0', fontSize: 11, color: '#991b1b' }}>
              {(ensureMut.error as Error).message}
            </p>
          )}
        </div>
        <button
          type="button"
          style={{ ...smallPrimaryButton, opacity: busy ? 0.65 : 1 }}
          disabled={busy}
          onClick={() => ensureMut.mutate()}
        >
          {ensureMut.isPending ? 'Creating...' : 'Retry approval'}
        </button>
      </div>
    )
  }

  return (
    <div style={approvalPanelStyle}>
      <CheckCircle2 size={14} style={{ color: '#0284c7' }} />
      <div style={{ flex: 1 }}>
        <strong style={{ display: 'block', fontSize: 12, color: 'var(--color-on-surface)' }}>
          Human sign-off ready
        </strong>
        <p style={{ margin: '3px 0 0', fontSize: 11, color: '#0c4a6e', lineHeight: 1.45 }}>
          Approval request {approval.id.slice(0, 8)} is pending. Approving advances the workflow to the next step.
        </p>
        {decisionMut.isError && (
          <p style={{ margin: '6px 0 0', fontSize: 11, color: '#991b1b' }}>
            {(decisionMut.error as Error).message}
          </p>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button
          type="button"
          style={{ ...smallPrimaryButton, background: '#16a34a', opacity: busy ? 0.65 : 1 }}
          disabled={busy}
          onClick={() => decisionMut.mutate('APPROVED')}
        >
          {decisionMut.isPending ? 'Saving...' : 'Approve'}
        </button>
        <button
          type="button"
          style={{ ...smallSecondaryButton, color: '#991b1b', opacity: busy ? 0.65 : 1 }}
          disabled={busy}
          onClick={() => decisionMut.mutate('REJECTED')}
        >
          Reject
        </button>
      </div>
    </div>
  )
}

function WorkItemInlinePanel({
  node, instanceId, compact = false,
}: {
  node: RunNode
  instanceId: string
  compact?: boolean
}) {
  const navigate = useNavigate()
  const standard = asRecord(node.config?.standard)
  const plannedTitle = String(standard.title ?? node.config?.title ?? node.label ?? 'Delegated work item')
  const plannedDescription = String(standard.description ?? node.config?.description ?? '')
  const configuredWorkItemId = typeof node.config?._workItemId === 'string' ? node.config._workItemId : ''
  const [selectedWorkflowByTarget, setSelectedWorkflowByTarget] = useState<Record<string, string>>({})
  const [clarificationAnswers, setClarificationAnswers] = useState<Record<string, string>>({})
  const [createDraft, setCreateDraft] = useState({
    title: plannedTitle,
    description: plannedDescription,
    targetCapabilityId: '',
    childWorkflowTemplateId: '',
    urgency: 'NORMAL',
    requiredBy: '',
    budget: '',
    details: '',
  })
  const { labelForCapability } = useCapabilityLabels()

  const { data: workItem, isLoading, error, refetch } = useQuery<RunWorkItemRow | null>({
    queryKey: ['run-workitem-inline', instanceId, node.id, configuredWorkItemId],
    queryFn: async () => {
      if (configuredWorkItemId) {
        return api.get(`/work-items/${configuredWorkItemId}`).then(r => r.data as RunWorkItemRow)
      }
      const res = await api.get('/work-items', {
        params: { sourceWorkflowInstanceId: instanceId, sourceWorkflowNodeId: node.id, limit: 1 },
      })
      return unwrapItems<RunWorkItemRow>(res.data)[0] ?? null
    },
    enabled: Boolean(instanceId && node.id),
    refetchInterval: compact ? false : 5_000,
  })

  const activeTarget = workItem?.targets[0]
  const selectedTemplate = activeTarget ? selectedWorkflowByTarget[activeTarget.id] ?? '' : ''
  const effectiveTemplate = activeTarget?.childWorkflowTemplateId || selectedTemplate
  const openClarifications = (workItem?.clarifications ?? []).filter(item => item.status === 'OPEN')
  const workflowCapabilityId = activeTarget?.targetCapabilityId ?? createDraft.targetCapabilityId

  // M93.C — Same profile=main filter as WorkItemsPage / WorkDetailPage.
  // The pre-start workflow picker on the run viewer is also a WorkItem-
  // attach surface; workbench templates can't be its target.
  const workflowsQuery = useQuery<WorkflowTemplateOption[]>({
    queryKey: ['run-workitem-workflows', workflowCapabilityId],
    enabled: Boolean(workflowCapabilityId && (!activeTarget || !activeTarget.childWorkflowInstanceId)),
    queryFn: () => api.get('/workflows', { params: { capabilityId: workflowCapabilityId, size: 100, profile: 'main' } })
      .then(r => unwrapItems<WorkflowTemplateOption>(r.data)),
  })
  const allWorkflowsQuery = useQuery<WorkflowTemplateOption[]>({
    queryKey: ['run-workitem-workflows-all'],
    enabled: Boolean(workflowCapabilityId && ((workflowsQuery.isSuccess && (workflowsQuery.data ?? []).length === 0) || workflowsQuery.isError)),
    queryFn: () => api.get('/workflows', { params: { size: 100, profile: 'main' } })
      .then(r => unwrapItems<WorkflowTemplateOption>(r.data)),
  })
  const workflowOptions = workflowsQuery.data?.length
    ? workflowsQuery.data
    : allWorkflowsQuery.data ?? []
  const missingCapabilityWorkflows = workflowsQuery.isError || (workflowsQuery.isSuccess && (workflowsQuery.data ?? []).length === 0)
  const usingFallbackWorkflows = Boolean(workflowCapabilityId && missingCapabilityWorkflows && workflowOptions.length > 0)
  const createMut = useMutation({
    mutationFn: () => {
      const trimmedBudget = createDraft.budget.trim()
      const trimmedDetails = createDraft.details.trim()
      return api.post('/work-items', {
        title: createDraft.title.trim() || plannedTitle,
        description: createDraft.description.trim() || undefined,
        originType: 'PARENT_DELEGATED',
        sourceWorkflowInstanceId: instanceId,
        sourceWorkflowNodeId: node.id,
        input: {
          source: 'workflow-run-inline',
          workflowInstanceId: instanceId,
          workflowNodeId: node.id,
          title: createDraft.title.trim() || plannedTitle,
          description: createDraft.description.trim() || undefined,
          details: trimmedDetails || undefined,
        },
        details: {
          source: 'workflow-run-inline',
          workflowInstanceId: instanceId,
          workflowNodeId: node.id,
          requestDetails: trimmedDetails || null,
          title: createDraft.title.trim() || plannedTitle,
          description: createDraft.description.trim() || null,
        },
        budget: trimmedBudget ? { operatorNote: trimmedBudget } : {},
        urgency: createDraft.urgency,
        requiredBy: createDraft.requiredBy ? new Date(createDraft.requiredBy).toISOString() : undefined,
        targets: [{
          targetCapabilityId: createDraft.targetCapabilityId,
          childWorkflowTemplateId: createDraft.childWorkflowTemplateId || undefined,
        }],
      }).then(r => r.data)
    },
    onSuccess: () => refetch(),
  })
  const claimMut = useMutation({
    mutationFn: (targetId: string) => api.post(`/work-items/${workItem?.id}/targets/${targetId}/claim`).then(r => r.data),
    onSuccess: () => refetch(),
  })
  const startMut = useMutation({
    mutationFn: ({ targetId, childWorkflowTemplateId }: { targetId: string; childWorkflowTemplateId?: string }) =>
      api.post(`/work-items/${workItem?.id}/targets/${targetId}/start`, childWorkflowTemplateId ? { childWorkflowTemplateId } : {}).then(r => r.data),
    onSuccess: () => refetch(),
  })
  const answerMut = useMutation({
    mutationFn: ({ clarificationId, answer }: { clarificationId: string; answer: string }) =>
      api.post(`/work-items/${workItem?.id}/clarifications/${clarificationId}/answer`, { answer }).then(r => r.data),
    onSuccess: (_data, vars) => {
      setClarificationAnswers(prev => ({ ...prev, [vars.clarificationId]: '' }))
      refetch()
    },
  })

  if (isLoading) {
    return (
      <div style={workItemPanelStyle}>
        <p style={mutedTextStyle}>Creating or loading the WorkItem request packet...</p>
      </div>
    )
  }

  if (error) {
    return (
      <div style={{ ...workItemPanelStyle, borderColor: 'rgba(239,68,68,0.25)', background: 'rgba(239,68,68,0.04)' }}>
        <p style={{ ...mutedTextStyle, color: '#991b1b' }}>Unable to load the WorkItem: {(error as Error).message}</p>
      </div>
    )
  }

  if (!workItem) {
    const canCreate = createDraft.targetCapabilityId.trim().length > 0 && createDraft.title.trim().length > 0
    return (
      <div style={workItemPanelStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <Network size={14} style={{ color: '#7c3aed' }} />
          <strong style={{ fontSize: 12, color: 'var(--color-on-surface)' }}>Create WorkItem request packet</strong>
        </div>
        <p style={{ ...mutedTextStyle, marginBottom: 10 }}>
          This run has reached a WorkItem node, but no request packet exists yet. Capture the details here, choose the
          child capability, and the run will have a durable WorkItem to claim, attach, start, clarify, and audit.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
          <label style={smallLabelStyle}>
            Title
            <input
              value={createDraft.title}
              onChange={event => setCreateDraft(prev => ({ ...prev, title: event.target.value }))}
              style={inlineInputStyle}
              placeholder="Short WorkItem title"
            />
          </label>
          <label style={smallLabelStyle}>
            Target child capability
            <CapabilityPicker
              value={createDraft.targetCapabilityId}
              onChange={value => setCreateDraft(prev => ({ ...prev, targetCapabilityId: value, childWorkflowTemplateId: '' }))}
              placeholder="Select child capability..."
              filterToMemberships={false}
              autoDefault={false}
            />
          </label>
          <label style={smallLabelStyle}>
            Workflow to attach
            <select
              value={createDraft.childWorkflowTemplateId}
              onChange={event => setCreateDraft(prev => ({ ...prev, childWorkflowTemplateId: event.target.value }))}
              style={smallSelectStyle}
              disabled={!createDraft.targetCapabilityId}
            >
              <option value="">{createDraft.targetCapabilityId ? 'Attach later or select workflow' : 'Select capability first'}</option>
              {workflowOptions.map(workflow => <option key={workflow.id} value={workflow.id}>{workflow.name}{workflow.capabilityId && workflow.capabilityId !== createDraft.targetCapabilityId ? ` · ${labelForCapability(workflow.capabilityId)}` : ''}</option>)}
            </select>
            {usingFallbackWorkflows && <span style={{ color: '#92400e', fontSize: 10, textTransform: 'none', letterSpacing: 0 }}>No capability-specific workflows returned; showing all templates.</span>}
          </label>
          <label style={smallLabelStyle}>
            Urgency
            <select
              value={createDraft.urgency}
              onChange={event => setCreateDraft(prev => ({ ...prev, urgency: event.target.value }))}
              style={smallSelectStyle}
            >
              <option value="LOW">Low</option>
              <option value="NORMAL">Normal</option>
              <option value="HIGH">High</option>
              <option value="CRITICAL">Critical</option>
            </select>
          </label>
          <label style={smallLabelStyle}>
            Required by
            <input
              type="datetime-local"
              value={createDraft.requiredBy}
              onChange={event => setCreateDraft(prev => ({ ...prev, requiredBy: event.target.value }))}
              style={inlineInputStyle}
            />
          </label>
          <label style={smallLabelStyle}>
            Budget / constraint note
            <input
              value={createDraft.budget}
              onChange={event => setCreateDraft(prev => ({ ...prev, budget: event.target.value }))}
              style={inlineInputStyle}
              placeholder="e.g. 2 days, 40k tokens, no schema change"
            />
          </label>
        </div>
        <label style={{ ...smallLabelStyle, marginTop: 10 }}>
          WorkItem details
          <textarea
            rows={5}
            value={createDraft.details}
            onChange={event => setCreateDraft(prev => ({ ...prev, details: event.target.value }))}
            style={inlineTextareaStyle}
            placeholder="Describe the requested outcome, acceptance criteria, constraints, repo/path hints, and what the child capability should return."
          />
        </label>
        {createMut.isError && (
          <p style={{ margin: '8px 0 0', fontSize: 11, color: '#991b1b' }}>
            {(createMut.error as Error).message}
          </p>
        )}
        <button
          type="button"
          style={{ ...smallPrimaryButton, marginTop: 10, opacity: canCreate ? 1 : 0.55 }}
          disabled={!canCreate || createMut.isPending}
          onClick={() => createMut.mutate()}
        >
          {createMut.isPending ? 'Creating WorkItem...' : 'Create WorkItem packet'}
        </button>
        <p style={{ ...mutedTextStyle, marginTop: 8 }}>
          After creation, this same panel will show claim/start actions, clarification answers, child run links, and the immutable details packet.
        </p>
      </div>
    )
  }

  const canClaim = activeTarget && ['QUEUED', 'REWORK_REQUESTED'].includes(activeTarget.status) && !activeTarget.claimedById
  const canStart = activeTarget && activeTarget.status === 'CLAIMED' && !!activeTarget.claimedById && !!effectiveTemplate && !activeTarget.childWorkflowInstanceId

  return (
    <div style={workItemPanelStyle}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 10 }}>
        <div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <Network size={14} style={{ color: '#7c3aed' }} />
            <strong style={{ fontSize: 13, color: 'var(--color-on-surface)' }}>
              {workItem.workCode ?? workItem.id.slice(0, 8)} · {workItem.title}
            </strong>
            <StatusChip status={workItem.status} />
          </div>
          {workItem.description && <p style={{ ...mutedTextStyle, marginTop: 4 }}>{workItem.description}</p>}
        </div>
        <button type="button" onClick={() => navigate(`/runtime/work/workitem/${workItem.id}`)} style={smallSecondaryButton}>
          <ExternalLink size={12} /> Open WorkItem
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8, marginBottom: 10 }}>
        <KeyValueBox label="Type" value={workItem.originType === 'PARENT_DELEGATED' ? 'Parent delegated' : 'Local capability'} />
        <KeyValueBox label="Urgency" value={workItem.urgency ?? 'NORMAL'} />
        <KeyValueBox label="Required by" value={formatDateValue(workItem.requiredBy ?? workItem.dueAt)} />
        <KeyValueBox label="Details" value={workItem.detailsLocked ? 'Locked packet' : 'Editable'} />
      </div>

      {!compact && workItem.details && Object.keys(workItem.details).length > 0 && (
        <details style={{ marginBottom: 10 }}>
          <summary style={summaryStyle}>Request details</summary>
          <pre style={inlinePreStyle}>{JSON.stringify(workItem.details, null, 2)}</pre>
        </details>
      )}

      {activeTarget && (
        <div style={{ padding: 10, borderRadius: 9, border: '1px solid rgba(124,58,237,0.18)', background: '#fff' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between', marginBottom: 8 }}>
            <div>
              <strong style={{ fontSize: 12, color: 'var(--color-on-surface)' }}>Child capability target</strong>
              <div style={{ fontSize: 10, color: 'var(--color-outline)' }}>{labelForCapability(activeTarget.targetCapabilityId)}</div>
            </div>
            <StatusChip status={activeTarget.status} />
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
            {canClaim && (
              <button type="button" style={smallPrimaryButton} disabled={claimMut.isPending} onClick={() => claimMut.mutate(activeTarget.id)}>
                {claimMut.isPending ? 'Claiming...' : 'Claim WorkItem'}
              </button>
            )}
            {activeTarget.status === 'CLAIMED' && !activeTarget.childWorkflowInstanceId && (
              <select
                value={activeTarget.childWorkflowTemplateId ?? selectedTemplate}
                disabled={Boolean(activeTarget.childWorkflowTemplateId)}
                onChange={event => setSelectedWorkflowByTarget(prev => ({ ...prev, [activeTarget.id]: event.target.value }))}
                style={smallSelectStyle}
              >
                <option value="">
                  {workflowsQuery.isLoading ? 'Loading workflow templates...'
                    : workflowOptions.length === 0 ? 'No workflow templates found'
                      : usingFallbackWorkflows ? 'Attach workflow (showing all templates)'
                        : 'Attach workflow before start'}
                </option>
                {workflowOptions.map(workflow => <option key={workflow.id} value={workflow.id}>{workflow.name}{workflow.capabilityId && workflow.capabilityId !== activeTarget.targetCapabilityId ? ` · ${labelForCapability(workflow.capabilityId)}` : ''}</option>)}
              </select>
            )}
            {usingFallbackWorkflows && (
              <span style={{ alignSelf: 'center', color: '#92400e', fontSize: 10 }}>
                No capability-specific workflows returned; showing all templates.
              </span>
            )}
            {canStart && (
              <button
                type="button"
                style={smallPrimaryButton}
                disabled={startMut.isPending}
                onClick={() => startMut.mutate({ targetId: activeTarget.id, childWorkflowTemplateId: selectedTemplate || undefined })}
              >
                {startMut.isPending ? 'Starting...' : 'Start child workflow'}
              </button>
            )}
            {activeTarget.childWorkflowInstanceId && (
              <button type="button" style={smallSecondaryButton} onClick={() => navigate(`/runs/${activeTarget.childWorkflowInstanceId}`)}>
                <ExternalLink size={12} /> Open child run
              </button>
            )}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8 }}>
            <KeyValueBox label="Workflow" value={activeTarget.childWorkflowTemplateId || selectedTemplate || 'Not attached'} />
            <KeyValueBox label="Claimed by" value={activeTarget.claimedById ?? 'Unclaimed'} />
            <KeyValueBox label="Role" value={activeTarget.roleKey ?? 'Any eligible member'} />
          </div>
        </div>
      )}

      {openClarifications.length > 0 && (
        <div style={{ marginTop: 10, display: 'grid', gap: 8 }}>
          <strong style={{ fontSize: 12, color: 'var(--color-on-surface)' }}>Parent clarification needed</strong>
          {openClarifications.map(item => (
            <div key={item.id} style={{ padding: 10, borderRadius: 9, border: '1px solid rgba(245,158,11,0.25)', background: 'rgba(245,158,11,0.05)' }}>
              <p style={{ margin: '0 0 8px', fontSize: 12, color: '#78350f' }}>{item.question}</p>
              <textarea
                rows={3}
                value={clarificationAnswers[item.id] ?? ''}
                onChange={event => setClarificationAnswers(prev => ({ ...prev, [item.id]: event.target.value }))}
                placeholder="Give the missing WorkItem details or decision..."
                style={inlineTextareaStyle}
              />
              <button
                type="button"
                style={{ ...smallPrimaryButton, marginTop: 8 }}
                disabled={answerMut.isPending || !(clarificationAnswers[item.id] ?? '').trim()}
                onClick={() => answerMut.mutate({ clarificationId: item.id, answer: clarificationAnswers[item.id] ?? '' })}
              >
                Save answer for child capability
              </button>
            </div>
          ))}
        </div>
      )}
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

  const entityQuery = useQuery<unknown>({
    queryKey: ['run-fill-entity', kind, node.id, instanceId],
    queryFn:  () => api.get(path, { params: { nodeId: node.id, instanceId } }).then(r => r.data),
    enabled:  !!node.id && !!instanceId,
  })
  const [approvalSnapshot, setApprovalSnapshot] = useState<{ data: Record<string, unknown>; attachmentIds: string[] }>({
    data: {},
    attachmentIds: [],
  })

  const ensureApprovalMut = useMutation({
    mutationFn: () => api.post(`/approvals/workflow-node/${node.id}/ensure`).then(r => r.data),
    onSuccess: () => entityQuery.refetch(),
  })

  const entity = unwrapItems<{ id: string; formData?: Record<string, unknown>; attachments?: any[] }>(entityQuery.data)[0] ?? null

  const shouldEnsureApproval =
    kind === 'approval' &&
    entityQuery.isFetched &&
    !entity &&
    !entityQuery.error &&
    !ensureApprovalMut.isPending &&
    !ensureApprovalMut.isSuccess &&
    !ensureApprovalMut.isError

  useEffect(() => {
    if (shouldEnsureApproval) ensureApprovalMut.mutate()
  }, [shouldEnsureApproval])

  if (!entity) {
    if (kind === 'approval') {
      return (
        <div style={approvalPanelStyle}>
          <Clock size={14} style={{ color: '#0284c7' }} />
          <div style={{ flex: 1 }}>
            <strong style={{ display: 'block', fontSize: 12, color: 'var(--color-on-surface)' }}>
              Human sign-off is waiting for an approval record
            </strong>
            <p style={{ margin: '3px 0 0', fontSize: 11, color: '#0c4a6e', lineHeight: 1.45 }}>
              The workflow reached this approval form, but no pending approval request was found. The runtime is creating one now; if it does not appear, retry here.
            </p>
            {ensureApprovalMut.isError && (
              <p style={{ margin: '6px 0 0', fontSize: 11, color: '#991b1b' }}>
                {(ensureApprovalMut.error as Error).message}
              </p>
            )}
          </div>
          <button
            type="button"
            style={{ ...smallPrimaryButton, opacity: ensureApprovalMut.isPending ? 0.65 : 1 }}
            disabled={ensureApprovalMut.isPending}
            onClick={() => ensureApprovalMut.mutate()}
          >
            {ensureApprovalMut.isPending ? 'Creating...' : 'Retry approval'}
          </button>
        </div>
      )
    }
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
        onSubmitted={() => entityQuery.refetch()}
        onValuesChange={kind === 'approval' ? setApprovalSnapshot : undefined}
        hideActions={kind === 'approval'}
        primaryLabel={kind === 'approval' ? 'Save sign-off form' : undefined}
      />
      {kind === 'approval' && (
        <ApprovalDecisionControls
          approvalId={entity.id}
          instanceId={instanceId}
          nodeId={node.id}
          widgets={widgets}
          snapshot={approvalSnapshot}
          onDone={() => entityQuery.refetch()}
        />
      )}
    </div>
  )
}

function ApprovalDecisionControls({
  approvalId, instanceId, nodeId, widgets, snapshot, onDone,
}: {
  approvalId: string
  instanceId: string
  nodeId: string
  widgets: FormWidget[]
  snapshot: { data: Record<string, unknown>; attachmentIds: string[] }
  onDone: () => void
}) {
  const queryClient = useQueryClient()
  const [validationError, setValidationError] = useState<string | null>(null)
  const decisionMut = useMutation({
    mutationFn: async (decision: 'APPROVED' | 'REJECTED') => {
      setValidationError(null)
      if (decision === 'APPROVED') {
        const err = validateWidgetSnapshot(widgets, snapshot.data)
        if (err) {
          setValidationError(err)
          throw new Error(err)
        }
      }
      await api.post(`/approvals/${approvalId}/form-submission`, {
        data: snapshot.data,
        attachmentIds: snapshot.attachmentIds,
      })
      return api.post(`/approvals/${approvalId}/decision`, {
        decision,
        notes: decision === 'APPROVED'
          ? 'Approved from workflow run timeline'
          : 'Rejected from workflow run timeline',
      }).then(r => r.data)
    },
    onSuccess: () => {
      onDone()
      queryClient.invalidateQueries({ queryKey: ['run-instance', instanceId] })
      queryClient.invalidateQueries({ queryKey: ['run-instance', instanceId, 'nodes'] })
      queryClient.invalidateQueries({ queryKey: ['run-fill-entity', 'approval', nodeId, instanceId] })
    },
  })

  const busy = decisionMut.isPending
  const error = validationError ?? (decisionMut.isError ? (decisionMut.error as Error).message : null)

  return (
    <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--color-outline-variant)' }}>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        <button
          type="button"
          style={{ ...smallSecondaryButton, color: '#991b1b', opacity: busy ? 0.65 : 1 }}
          disabled={busy}
          onClick={() => decisionMut.mutate('REJECTED')}
        >
          Reject
        </button>
        <button
          type="button"
          style={{ ...smallPrimaryButton, background: '#16a34a', opacity: busy ? 0.65 : 1 }}
          disabled={busy}
          onClick={() => decisionMut.mutate('APPROVED')}
        >
          {busy ? 'Saving...' : 'Approve and advance'}
        </button>
      </div>
      {error && (
        <p style={{ margin: '8px 0 0', fontSize: 11, color: '#991b1b', textAlign: 'right' }}>
          {error}
        </p>
      )}
    </div>
  )
}

function validateWidgetSnapshot(widgets: FormWidget[], data: Record<string, unknown>): string | null {
  for (const w of widgets) {
    if (!widgetHasValue(w.type) || !w.required || !w.key) continue
    const v = data[w.key]
    const isEmpty =
      v === undefined || v === null || v === '' ||
      (Array.isArray(v) && v.length === 0) ||
      (typeof v === 'object' && v && Object.keys(v).length === 0)
    if (w.type === 'SIGNATURE') {
      const sig = v as { name?: string } | undefined
      if (!sig?.name?.trim()) return `"${w.label ?? w.key}" is required.`
    } else if (isEmpty) {
      return `"${w.label ?? w.key}" is required.`
    }
  }
  return null
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

  const { data } = useQuery<unknown>({
    queryKey: ['run-completed-entity', kind, node.id, instanceId],
    queryFn:  () => api.get(path, { params: { nodeId: node.id, instanceId } }).then(r => r.data),
    enabled:  !!node.id && !!instanceId,
  })
  const entity = unwrapItems<{ id: string; formData?: Record<string, unknown> }>(data)[0] ?? null
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

function KeyValueBox({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ padding: 8, borderRadius: 8, border: '1px solid var(--color-outline-variant)', background: '#fff' }}>
      <div style={{ fontSize: 9, color: 'var(--color-outline)', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.1em' }}>{label}</div>
      <div style={{ marginTop: 3, fontSize: 11, color: 'var(--color-on-surface)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</div>
    </div>
  )
}

function FragmentRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt style={{ fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{label}</dt>
      <dd style={{ margin: 0, minWidth: 0, wordBreak: 'break-word', fontFamily: 'monospace' }}>{value}</dd>
    </>
  )
}

function unwrapItems<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[]
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>
    if (Array.isArray(obj.content)) return obj.content as T[]
    if (Array.isArray(obj.items)) return obj.items as T[]
    if (Array.isArray(obj.data)) return obj.data as T[]
  }
  return []
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function stringField(root: Record<string, unknown>, key: string): string {
  const value = root[key]
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

function redactDisplayValue(value: string): string {
  return value
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/sk-proj-[A-Za-z0-9_-]{20,}/g, '[REDACTED_OPENAI_KEY]')
    .replace(/sk-[A-Za-z0-9_-]{32,}/g, '[REDACTED_OPENAI_KEY]')
    .replace(/sk-ant-[A-Za-z0-9_-]{20,}/g, '[REDACTED_ANTHROPIC_KEY]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, 'Bearer [REDACTED_TOKEN]')
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[REDACTED_JWT]')
    .replace(/https?:\/\/([^/\s:@]+):([^@\s/]+)@/g, 'https://[REDACTED_CREDENTIALS]@')
}

function blockingDetailsForNode(
  node: RunNode,
  context: Record<string, unknown>,
): { title: string; message: string; details: { label: string; value: string }[]; fixCommands: string[]; retryable: boolean } | null {
  const config = asRecord(node.config)
  const lastError = asRecord(config._lastError)
  const blockKey =
    node.nodeType === 'GIT_PUSH' ? '_blockedByGitPush' :
    node.nodeType === 'POLICY_CHECK' ? '_blockedByPolicyCheck' :
    node.nodeType === 'EVAL_GATE' ? '_blockedByEvalGate' :
    ''
  const direct = blockKey ? asRecord(context[blockKey]) : {}
  const fallback = Object.entries(context)
    .find(([key, value]) => key.startsWith('_blockedBy') && value && typeof value === 'object' && !Array.isArray(value))?.[1]
  const blocked = Object.keys(direct).length > 0 ? direct : asRecord(fallback)
  const source = Object.keys(blocked).length > 0 ? blocked : lastError
  if (node.status !== 'BLOCKED' && node.status !== 'FAILED' && Object.keys(source).length === 0) return null

  const pushError = stringField(source, 'pushError')
  const message =
    stringField(source, 'message') ||
    stringField(source, 'reason') ||
    pushError ||
    stringField(source, 'code') ||
    (node.status === 'FAILED' ? 'This stage failed. Restart the stage after reviewing the details.' : 'This stage is blocked.')

  const detailKeys = ['blockedCode', 'remote', 'branch', 'commitSha', 'workspaceRoot', 'pushError', 'evidenceSource', 'toolInvocationId', 'approvalRequestId', 'code', 'retryable']
  const details = detailKeys
    .map(key => {
      const value = source[key]
      if (value === undefined || value === null || value === '') return null
      return { label: key, value: redactDisplayValue(Array.isArray(value) ? value.join(', ') : String(value)) }
    })
    .filter((item): item is { label: string; value: string } => Boolean(item))
  const fixCommands = Array.isArray(source.fixCommands)
    ? source.fixCommands.map(String).map(redactDisplayValue)
    : []

  return {
    title: node.status === 'FAILED' ? 'Failure reason' : 'Blocking reason',
    message: redactDisplayValue(message),
    details,
    fixCommands,
    retryable: source.retryable === true,
  }
}

function readWorkgraphToken(): string {
  try {
    const raw = window.localStorage.getItem('workgraph-auth')
    if (!raw) return ''
    const parsed = JSON.parse(raw) as { state?: { token?: string | null } }
    return parsed.state?.token ?? ''
  } catch {
    return ''
  }
}

function buildWorkbenchLaunchUrl(
  workflowInstanceId: string,
  workflowNodeId: string,
  config: Record<string, unknown>,
  uiMode: 'neo',
  runtimeContext: Record<string, unknown> = {},
) {
  const url = new URL(BLUEPRINT_WORKBENCH_URL, window.location.href)
  const renderedConfig = renderWorkbenchConfig(config, runtimeContext)
  const bindings = asRecord(renderedConfig.agentBindings)
  url.searchParams.set('workflowInstanceId', workflowInstanceId)
  url.searchParams.set('workflowNodeId', workflowNodeId)
  url.searchParams.set('ui', uiMode)
  const phaseId = cleanLaunchString(renderedConfig.phaseId)
  const goal = cleanLaunchString(renderedConfig.goal) || cleanLaunchString(renderedConfig.task)
  const sourceUri = cleanLaunchString(renderedConfig.sourceUri)
  const sourceRef = cleanLaunchString(renderedConfig.sourceRef)
  const capabilityId = cleanLaunchString(renderedConfig.capabilityId)
  if (phaseId) url.searchParams.set('phaseId', phaseId)
  if (goal) url.searchParams.set('goal', goal)
  if (renderedConfig.sourceType === 'github' || renderedConfig.sourceType === 'localdir') url.searchParams.set('sourceType', renderedConfig.sourceType)
  if (sourceUri) url.searchParams.set('sourceUri', sourceUri)
  if (sourceRef) url.searchParams.set('sourceRef', sourceRef)
  if (capabilityId) url.searchParams.set('capabilityId', capabilityId)
  setCleanParam(url, 'architectAgentTemplateId', bindings.architectAgentTemplateId)
  setCleanParam(url, 'developerAgentTemplateId', bindings.developerAgentTemplateId)
  setCleanParam(url, 'qaAgentTemplateId', bindings.qaAgentTemplateId)
  setCleanParam(url, 'productOwnerAgentTemplateId', bindings.productOwnerAgentTemplateId)
  setCleanParam(url, 'securityAgentTemplateId', bindings.securityAgentTemplateId)
  setCleanParam(url, 'devopsAgentTemplateId', bindings.devopsAgentTemplateId)
  if (renderedConfig.gateMode === 'auto' || renderedConfig.gateMode === 'manual') url.searchParams.set('gateMode', renderedConfig.gateMode)
  if (renderedConfig.loopDefinition && typeof window !== 'undefined') {
    try {
      url.searchParams.set('loopDefinition', window.btoa(JSON.stringify(renderedConfig.loopDefinition)))
    } catch {
      // Keep run approval usable if a malformed Workbench config sneaks in.
    }
  }
  return url.toString()
}

function setCleanParam(url: URL, key: string, value: unknown) {
  const text = cleanLaunchString(value)
  if (text) url.searchParams.set(key, text)
}

function cleanLaunchString(value: unknown): string {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  if (!text || /\{\{[^}]+}}/.test(text)) return ''
  return text
}

function renderWorkbenchConfig(config: Record<string, unknown>, runtimeContext: Record<string, unknown>): Record<string, unknown> {
  return renderWorkbenchValue(config, {
    context: runtimeContext,
    instance: {
      vars: asRecord(runtimeContext._vars),
      globals: asRecord(runtimeContext._globals),
      params: asRecord(runtimeContext._params),
    },
    vars: asRecord(runtimeContext._vars),
    globals: asRecord(runtimeContext._globals),
    params: asRecord(runtimeContext._params),
  }) as Record<string, unknown>
}

function renderWorkbenchValue(value: unknown, context: Record<string, unknown>): unknown {
  if (typeof value === 'string') return renderWorkbenchTemplate(value, context)
  if (Array.isArray(value)) return value.map(item => renderWorkbenchValue(item, context))
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, renderWorkbenchValue(child, context)]))
  }
  return value
}

function renderWorkbenchTemplate(template: string, context: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, rawPath: string) => {
    const value = lookupWorkbenchPath(context, rawPath.trim())
    return value === undefined || value === null ? '' : String(value)
  })
}

function lookupWorkbenchPath(root: Record<string, unknown>, path: string): unknown {
  const direct = root[path]
  if (direct !== undefined) return direct
  return path.split('.').reduce<unknown>((cursor, segment) => {
    const object = cursor && typeof cursor === 'object' && !Array.isArray(cursor) ? cursor as Record<string, unknown> : null
    return object ? object[segment] : undefined
  }, root)
}

function formatDateValue(value?: string | null) {
  return value ? new Date(value).toLocaleString() : 'Not set'
}

const workItemPanelStyle: CSSProperties = {
  marginTop: 10,
  padding: 12,
  borderRadius: 10,
  background: 'rgba(139,92,246,0.05)',
  border: '1px solid rgba(139,92,246,0.22)',
}

const approvalPanelStyle: CSSProperties = {
  marginTop: 10,
  padding: 12,
  borderRadius: 10,
  background: 'rgba(14,165,233,0.06)',
  border: '1px solid rgba(14,165,233,0.22)',
  display: 'flex',
  alignItems: 'flex-start',
  gap: 10,
  flexWrap: 'wrap',
}

const mutedTextStyle: CSSProperties = {
  margin: 0,
  fontSize: 11,
  color: 'var(--color-outline)',
}

const smallPrimaryButton: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '7px 10px',
  borderRadius: 8,
  border: 'none',
  background: '#7c3aed',
  color: '#fff',
  fontSize: 11,
  fontWeight: 800,
  cursor: 'pointer',
}

const smallSecondaryButton: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '7px 10px',
  borderRadius: 8,
  border: '1px solid var(--color-outline-variant)',
  background: '#fff',
  color: 'var(--color-on-surface)',
  fontSize: 11,
  fontWeight: 800,
  cursor: 'pointer',
}

const smallSelectStyle: CSSProperties = {
  minWidth: 220,
  width: '100%',
  padding: '7px 10px',
  borderRadius: 8,
  border: '1px solid var(--color-outline-variant)',
  background: '#fff',
  color: 'var(--color-on-surface)',
  fontSize: 11,
  fontWeight: 700,
}

const smallLabelStyle: CSSProperties = {
  display: 'grid',
  gap: 5,
  fontSize: 10,
  color: 'var(--color-outline)',
  fontWeight: 800,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
}

const inlineInputStyle: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: 9,
  borderRadius: 8,
  border: '1px solid var(--color-outline-variant)',
  background: '#fff',
  color: 'var(--color-on-surface)',
  fontSize: 12,
  textTransform: 'none',
  letterSpacing: 0,
  fontWeight: 600,
}

const inlinePreStyle: CSSProperties = {
  marginTop: 6,
  maxHeight: 180,
  overflow: 'auto',
  padding: 9,
  borderRadius: 8,
  background: '#f8fafc',
  border: '1px solid var(--color-outline-variant)',
  fontSize: 10,
  fontFamily: 'monospace',
  color: '#334155',
}

const inlineTextareaStyle: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: 9,
  borderRadius: 8,
  border: '1px solid var(--color-outline-variant)',
  background: '#fff',
  color: 'var(--color-on-surface)',
  fontSize: 12,
  resize: 'vertical',
}

const summaryStyle: CSSProperties = {
  cursor: 'pointer',
  color: '#5b21b6',
  fontSize: 11,
  fontWeight: 800,
}

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
  BLOCKED:    { bg: 'rgba(245,158,11,0.10)', border: 'rgba(245,158,11,0.28)', color: '#d97706',
                tagBg: 'rgba(245,158,11,0.10)', Icon: AlertCircle },
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

type ApprovalRow = {
  id: string
  status: string
  assignedToId?: string | null
  createdAt?: string
}

type RunWorkItemTarget = {
  id: string
  targetCapabilityId: string
  childWorkflowTemplateId?: string | null
  childWorkflowInstanceId?: string | null
  roleKey?: string | null
  status: string
  claimedById?: string | null
  output?: Record<string, unknown> | null
}

type RunWorkItemClarification = {
  id: string
  targetId?: string | null
  question: string
  answer?: string | null
  status: string
  createdAt: string
}

type RunWorkItemRow = {
  id: string
  workCode?: string | null
  title: string
  description?: string | null
  originType: string
  status: string
  details?: Record<string, unknown> | null
  budget?: Record<string, unknown> | null
  urgency?: string | null
  requiredBy?: string | null
  dueAt?: string | null
  detailsLocked: boolean
  targets: RunWorkItemTarget[]
  clarifications?: RunWorkItemClarification[]
}

type WorkflowTemplateOption = {
  id: string
  name: string
  capabilityId?: string | null
}

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
