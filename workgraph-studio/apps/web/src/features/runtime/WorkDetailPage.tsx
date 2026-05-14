import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery, useMutation } from '@tanstack/react-query'
import { ArrowLeft, AlertCircle, CheckCircle2, XCircle, Workflow, Layers, ExternalLink, Route } from 'lucide-react'
import { api } from '../../lib/api'
import { RuntimeWidgetForm, type RuntimeFormSubmitTarget } from '../forms/widgets/RuntimeWidgetForm'
import type { FormWidget } from '../forms/widgets/types'
import type { UploadedDocument } from '../../lib/uploadAttachment'

type Kind = 'task' | 'approval' | 'consumable'

// ── Page ─────────────────────────────────────────────────────────────────────

export function WorkDetailPage() {
  const { kind, id } = useParams<{ kind: Kind; id: string }>()
  const navigate = useNavigate()

  if (!kind || !id || !['task', 'approval', 'consumable'].includes(kind)) {
    return <ErrorState message="Unknown work item" onBack={() => navigate('/runtime')} />
  }

  return (
    <div style={{ padding: 24, maxWidth: 880, margin: '0 auto' }}>
      <button
        onClick={() => navigate('/runtime')}
        style={{
          display: 'flex', alignItems: 'center', gap: 5, padding: '5px 10px', borderRadius: 7,
          border: '1px solid var(--color-outline-variant)', background: 'transparent',
          cursor: 'pointer', color: 'var(--color-outline)', fontSize: 12, fontWeight: 600, marginBottom: 14,
        }}
      >
        <ArrowLeft size={12} /> Back to inbox
      </button>

      {kind === 'task'       && <TaskDetail       id={id} />}
      {kind === 'approval'   && <ApprovalDetail   id={id} />}
      {kind === 'consumable' && <ConsumableDetail id={id} />}
    </div>
  )
}

// ── Task ─────────────────────────────────────────────────────────────────────

function TaskDetail({ id }: { id: string }) {
  const navigate = useNavigate()

  const { data: task, isLoading, refetch } = useQuery<TaskRow>({
    queryKey: ['runtime-task', id],
    queryFn:  () => api.get(`/tasks/${id}`).then(r => r.data),
  })

  const claimMut = useMutation({
    mutationFn: () => api.post(`/tasks/${id}/claim`).then(r => r.data),
    onSuccess: () => refetch(),
  })

  const { node, widgets, submitTarget, isLoading: nodeLoading } = useFormForNode(task?.instanceId, task?.nodeId, { kind: 'task', id })

  if (isLoading) return <p style={{ fontSize: 13, color: 'var(--color-outline)' }}>Loading task…</p>
  if (!task)     return <ErrorState message="Task not found" onBack={() => navigate('/runtime')} />

  const isClaimable = task.status === 'OPEN' && (task.queueItems?.length ?? 0) > 0
  const canWork = task.status === 'IN_PROGRESS'
    || (task.status === 'OPEN' && (task.assignments?.length ?? 0) > 0)
  const isWorkbenchNode = node?.nodeType === 'WORKBENCH_TASK'
  const canRenderStandardTask = !task.nodeId || (!!node && !isWorkbenchNode)

  return (
    <div>
      <Header
        title={task.title}
        subtitle={task.description ?? undefined}
        kindLabel="Task"
        kindColor="#22c55e"
        status={task.status}
        assignmentMode={task.assignmentMode ?? null}
      />

      {/* Claim button — visible while task is OPEN with queue items */}
      {isClaimable && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px',
          marginBottom: 14, borderRadius: 10,
          background: 'rgba(14,165,233,0.06)', border: '1px solid rgba(14,165,233,0.20)',
        }}>
          <p style={{ flex: 1, fontSize: 12, color: '#0c4a6e' }}>
            This task is in a queue. Claim it to start working on it.
          </p>
          <button
            onClick={() => claimMut.mutate()}
            disabled={claimMut.isPending}
            style={{
              padding: '7px 14px', borderRadius: 8, border: 'none',
              background: '#0ea5e9', color: '#fff', cursor: 'pointer',
              fontSize: 12, fontWeight: 700, opacity: claimMut.isPending ? 0.6 : 1,
            }}
          >
            {claimMut.isPending ? 'Claiming…' : 'Claim task'}
          </button>
        </div>
      )}

      {nodeLoading && (
        <p style={{ fontSize: 12, color: 'var(--color-outline)', marginBottom: 12 }}>Loading node configuration…</p>
      )}

      {node && node.nodeType === 'WORKBENCH_TASK' && (
        <WorkbenchTaskCard
          task={task}
          node={node}
          canComplete={canWork}
          onSubmitted={() => navigate('/runtime')}
        />
      )}

      {canRenderStandardTask && widgets && submitTarget && (
        <FormCard
          widgets={widgets}
          submitTarget={submitTarget}
          link={{ taskId: id, nodeId: task.nodeId ?? undefined, instanceId: task.instanceId ?? undefined }}
          initialData={(task.formData as Record<string, unknown>) ?? {}}
          initialAttachments={task.attachments ?? []}
          canComplete={canWork}
          onSubmitted={() => navigate('/runtime')}
        />
      )}

      {canRenderStandardTask && !widgets && canWork && (
        <SimpleCompleteButton onClick={() => api.post(`/tasks/${id}/complete`, { output: {} }).then(() => navigate('/runtime'))} />
      )}
    </div>
  )
}

// ── Approval ────────────────────────────────────────────────────────────────

function ApprovalDetail({ id }: { id: string }) {
  const navigate = useNavigate()

  const { data: approval, isLoading } = useQuery<ApprovalRow>({
    queryKey: ['runtime-approval', id],
    queryFn:  () => api.get(`/approvals/${id}`).then(r => r.data),
  })

  const decideMut = useMutation({
    mutationFn: (decision: 'APPROVED' | 'REJECTED') =>
      api.post(`/approvals/${id}/decision`, { decision }).then(r => r.data),
    onSuccess: () => navigate('/runtime'),
  })

  const { widgets, submitTarget } = useFormForNode(approval?.instanceId, approval?.nodeId, { kind: 'approval', id })

  if (isLoading) return <p style={{ fontSize: 13, color: 'var(--color-outline)' }}>Loading approval…</p>
  if (!approval) return <ErrorState message="Approval not found" onBack={() => navigate('/runtime')} />

  const isPending = approval.status === 'PENDING'

  return (
    <div>
      <Header
        title={`Approval · ${approval.subjectType}`}
        kindLabel="Approval"
        kindColor="#f59e0b"
        status={approval.status}
        assignmentMode={approval.assignmentMode ?? null}
      />

      {widgets && submitTarget && (
        <FormCard
          widgets={widgets}
          submitTarget={submitTarget}
          link={{ nodeId: approval.nodeId ?? undefined, instanceId: approval.instanceId ?? undefined }}
          initialData={(approval.formData as Record<string, unknown>) ?? {}}
          canComplete={isPending}
        />
      )}

      {/* Decide buttons */}
      {isPending && (
        <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
          <button
            onClick={() => decideMut.mutate('APPROVED')}
            disabled={decideMut.isPending}
            style={{
              flex: 1, padding: '10px 14px', borderRadius: 9, border: 'none',
              background: '#16a34a', color: '#fff', cursor: 'pointer',
              fontSize: 13, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              opacity: decideMut.isPending ? 0.6 : 1,
            }}
          >
            <CheckCircle2 size={14} /> Approve
          </button>
          <button
            onClick={() => decideMut.mutate('REJECTED')}
            disabled={decideMut.isPending}
            style={{
              flex: 1, padding: '10px 14px', borderRadius: 9, border: '1px solid #fecaca',
              background: '#fff', color: '#b91c1c', cursor: 'pointer',
              fontSize: 13, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              opacity: decideMut.isPending ? 0.6 : 1,
            }}
          >
            <XCircle size={14} /> Reject
          </button>
        </div>
      )}
    </div>
  )
}

// ── Consumable ──────────────────────────────────────────────────────────────

function ConsumableDetail({ id }: { id: string }) {
  const navigate = useNavigate()

  const { data: consumable, isLoading } = useQuery<ConsumableRow>({
    queryKey: ['runtime-consumable', id],
    queryFn:  () => api.get(`/consumables/${id}`).then(r => r.data),
  })

  const { widgets, submitTarget } = useFormForNode(consumable?.instanceId, consumable?.nodeId, { kind: 'consumable', id })

  if (isLoading)   return <p style={{ fontSize: 13, color: 'var(--color-outline)' }}>Loading deliverable…</p>
  if (!consumable) return <ErrorState message="Deliverable not found" onBack={() => navigate('/runtime')} />

  return (
    <div>
      <Header
        title={consumable.name}
        kindLabel="Deliverable"
        kindColor="#10b981"
        status={consumable.status}
        assignmentMode={consumable.assignmentMode ?? null}
      />

      {widgets && submitTarget && (
        <FormCard
          widgets={widgets}
          submitTarget={submitTarget}
          link={{ nodeId: consumable.nodeId ?? undefined, instanceId: consumable.instanceId ?? undefined }}
          initialData={(consumable.formData as Record<string, unknown>) ?? {}}
          canComplete={consumable.status === 'DRAFT' || consumable.status === 'UNDER_REVIEW'}
        />
      )}
    </div>
  )
}

// ── Shared sub-components ───────────────────────────────────────────────────

function Header({
  title, subtitle, kindLabel, kindColor, status, assignmentMode,
}: {
  title: string
  subtitle?: string
  kindLabel: string
  kindColor: string
  status: string
  assignmentMode: string | null
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 12,
      padding: '14px 16px', borderRadius: 12, marginBottom: 14,
      background: '#fff', border: '1px solid var(--color-outline-variant)',
    }}>
      <div style={{
        width: 36, height: 36, borderRadius: 10,
        background: `${kindColor}15`, border: `1px solid ${kindColor}30`,
        display: 'flex', alignItems: 'center', justifyContent: 'center', color: kindColor,
        flexShrink: 0,
      }}>
        <Workflow size={16} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <h2 style={{ fontSize: 16, fontWeight: 800, color: 'var(--color-on-surface)', letterSpacing: '-0.01em' }}>{title}</h2>
          <span style={{
            fontSize: 9, fontWeight: 700, color: kindColor,
            background: `${kindColor}10`, padding: '2px 6px', borderRadius: 4,
            letterSpacing: '0.08em', textTransform: 'uppercase',
          }}>
            {kindLabel}
          </span>
        </div>
        {subtitle && <p style={{ fontSize: 12, color: 'var(--color-outline)', marginTop: 2 }}>{subtitle}</p>}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6 }}>
          <span style={{ fontSize: 10, fontFamily: 'monospace', color: 'var(--color-outline)' }}>
            status · {status}
          </span>
          {assignmentMode && (
            <span style={{ fontSize: 10, color: 'var(--color-outline)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <Layers size={10} /> {assignmentMode}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

function FormCard({
  widgets, submitTarget, link, initialData, initialAttachments, canComplete, onSubmitted,
}: {
  widgets: FormWidget[]
  submitTarget: RuntimeFormSubmitTarget
  link?: { taskId?: string; nodeId?: string; instanceId?: string }
  initialData?: Record<string, unknown>
  initialAttachments?: UploadedDocument[]
  canComplete: boolean
  onSubmitted?: () => void
}) {
  return (
    <div style={{
      padding: 14, borderRadius: 12,
      background: '#fff', border: '1px solid var(--color-outline-variant)',
    }}>
      <RuntimeWidgetForm
        widgets={widgets}
        submitTo={submitTarget}
        link={link}
        initialData={initialData}
        initialAttachments={initialAttachments}
        canComplete={canComplete}
        onSubmitted={onSubmitted}
      />
    </div>
  )
}

function SimpleCompleteButton({ onClick }: { onClick: () => void }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
      <button
        onClick={onClick}
        style={{
          padding: '10px 18px', borderRadius: 9, border: 'none',
          background: 'var(--color-primary)', color: '#fff', cursor: 'pointer',
          fontSize: 13, fontWeight: 700,
        }}
      >
        Mark complete
      </button>
    </div>
  )
}

function WorkbenchTaskCard({
  task,
  node,
  canComplete,
  onSubmitted,
}: {
  task: TaskRow
  node: RuntimeNodeRow
  canComplete: boolean
  onSubmitted: () => void
}) {
  const [sessionId, setSessionId] = useState('')
  const [finalizedPack, setFinalizedPack] = useState<Record<string, unknown> | null>(null)
  const completedRef = useRef(false)
  const config = isPlainRecord(node.config) ? node.config : {}
  const workbenchConfig = isPlainRecord(config.workbench) ? config.workbench : {}
  const outputs = isPlainRecord(workbenchConfig.outputs) ? workbenchConfig.outputs : {}
  const finalPackKey = typeof outputs.finalPackKey === 'string' && outputs.finalPackKey.trim()
    ? outputs.finalPackKey.trim()
    : 'finalImplementationPack'
  const canBuildUrl = !!task.instanceId && !!task.nodeId
  const workbenchUrl = canBuildUrl ? buildWorkbenchUrl(task.instanceId!, task.nodeId!, workbenchConfig) : ''

  const completeMut = useMutation({
    mutationFn: (output: Record<string, unknown>) =>
      api.post(`/tasks/${task.id}/complete`, { output }).then(r => r.data),
    onSuccess: onSubmitted,
  })

  const completeWith = (nextSessionId: string, nextFinalPack: Record<string, unknown> | null, status: string, data?: unknown) => {
    if (!nextSessionId || !canComplete || completeMut.isPending) return
    const consumableFields = workbenchCompletionFields(data, nextFinalPack)
    completeMut.mutate({
      blueprintSessionId: nextSessionId,
      workbenchStatus: status,
      finalImplementationPack: nextFinalPack ?? undefined,
      [finalPackKey]: nextFinalPack ?? undefined,
      ...consumableFields,
      workbench: {
        profile: typeof workbenchConfig.profile === 'string' ? workbenchConfig.profile : 'blueprint',
        sessionId: nextSessionId,
        workbenchUrl,
        workflowInstanceId: task.instanceId,
        workflowNodeId: task.nodeId,
        completedAt: new Date().toISOString(),
        ...consumableFields,
      },
    })
  }

  useEffect(() => {
    if (!canBuildUrl) return
    const handler = (event: MessageEvent) => {
      if (event.origin !== 'http://localhost:5176') return
      const data = event.data
      if (!data || typeof data !== 'object' || data.type !== 'blueprintWorkbench.finalized') return
      if (data.workflowInstanceId && data.workflowInstanceId !== task.instanceId) return
      if (data.workflowNodeId && data.workflowNodeId !== task.nodeId) return

      const nextSessionId = typeof data.sessionId === 'string' ? data.sessionId : ''
      const nextFinalPack = data.finalPack && typeof data.finalPack === 'object'
        ? data.finalPack as Record<string, unknown>
        : null
      if (nextSessionId) setSessionId(nextSessionId)
      if (nextFinalPack) setFinalizedPack(nextFinalPack)
      if (nextSessionId && canComplete && !completedRef.current) {
        completedRef.current = true
        completeWith(nextSessionId, nextFinalPack, typeof data.status === 'string' ? data.status : 'FINALIZED', data)
      }
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [canBuildUrl, task.instanceId, task.nodeId, finalPackKey, workbenchUrl, canComplete, completeMut.isPending])

  if (!canBuildUrl) {
    return (
      <div style={{ padding: 14, borderRadius: 12, background: '#fff', border: '1px solid var(--color-outline-variant)' }}>
        <p style={{ fontSize: 13, fontWeight: 700, color: '#b91c1c', marginBottom: 4 }}>Workbench cannot open</p>
        <p style={{ fontSize: 12, color: '#64748b', margin: 0 }}>This task is missing its workflow instance or node reference.</p>
      </div>
    )
  }

  return (
    <div style={{
      padding: 14,
      borderRadius: 12,
      background: '#fff',
      border: '1px solid var(--color-outline-variant)',
      display: 'flex',
      flexDirection: 'column',
      gap: 12,
    }}>
      <div style={{
        border: '1px solid rgba(124,58,237,0.22)',
        borderRadius: 12,
        padding: 12,
        background: 'rgba(124,58,237,0.06)',
      }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
          <Route size={15} style={{ color: '#7c3aed' }} />
          <strong style={{ fontSize: 13, color: 'var(--color-on-surface)' }}>Workbench Task bridge</strong>
        </div>
        <p style={{ margin: 0, fontSize: 12, lineHeight: 1.45, color: 'var(--color-outline)' }}>
          The Blueprint Workbench runs inside this task. When the final implementation pack is approved, the workflow node completes and the next human approval stage receives the pack.
        </p>
      </div>

      {!canComplete && (
        <div style={{
          padding: '9px 11px',
          borderRadius: 10,
          border: '1px solid #fed7aa',
          background: '#fff7ed',
          color: '#9a3412',
          fontSize: 12,
          lineHeight: 1.45,
        }}>
          Claim or start this task before finalizing the Workbench output.
        </div>
      )}

      <iframe
        title="Blueprint Workbench"
        src={workbenchUrl}
        style={{
          width: '100%',
          height: 720,
          border: '1px solid var(--color-outline-variant)',
          borderRadius: 12,
          background: '#0b1326',
          opacity: canComplete ? 1 : 0.55,
          pointerEvents: canComplete ? 'auto' : 'none',
        }}
      />

      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, alignItems: 'end' }}>
        <label style={{ fontSize: 11, fontWeight: 700, color: '#334155' }}>
          Blueprint session / final pack reference
          <input
            value={sessionId}
            onChange={event => setSessionId(event.target.value)}
            placeholder="Paste finalized Blueprint session id or final pack id"
            style={{
              display: 'block',
              width: '100%',
              boxSizing: 'border-box',
              marginTop: 5,
              padding: '8px 11px',
              borderRadius: 8,
              border: '1px solid var(--color-outline-variant)',
              fontSize: 13,
              outline: 'none',
              fontFamily: 'inherit',
            }}
          />
        </label>
        <button
          disabled={!sessionId.trim() || !canComplete || completeMut.isPending}
          onClick={() => completeWith(sessionId.trim(), finalizedPack, finalizedPack ? 'FINALIZED' : 'MANUAL_REFERENCE')}
          style={{
            height: 37,
            padding: '0 14px',
            borderRadius: 9,
            border: 'none',
            background: '#7c3aed',
            color: '#fff',
            cursor: !sessionId.trim() || !canComplete || completeMut.isPending ? 'not-allowed' : 'pointer',
            fontSize: 12,
            fontWeight: 800,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            opacity: !sessionId.trim() || !canComplete || completeMut.isPending ? 0.55 : 1,
          }}
        >
          <CheckCircle2 size={14} /> Complete
        </button>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <a href={workbenchUrl} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: '#7c3aed', fontWeight: 800, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <ExternalLink size={12} /> Open full workbench
        </a>
        {completeMut.isError && (
          <span style={{ fontSize: 11, color: '#b91c1c' }}>Could not complete the workflow task. Try again.</span>
        )}
      </div>
    </div>
  )
}

function ErrorState({ message, onBack }: { message: string; onBack: () => void }) {
  return (
    <div style={{ padding: 32, textAlign: 'center' }}>
      <AlertCircle size={28} style={{ color: '#ef4444', marginBottom: 8 }} />
      <p style={{ fontSize: 14, fontWeight: 700, color: 'var(--color-on-surface)', marginBottom: 12 }}>{message}</p>
      <button
        onClick={onBack}
        style={{
          padding: '7px 14px', borderRadius: 8, border: '1px solid var(--color-outline-variant)',
          background: 'transparent', color: 'var(--color-outline)', cursor: 'pointer', fontSize: 12, fontWeight: 600,
        }}
      >
        Back to inbox
      </button>
    </div>
  )
}

// ── Hook: pull formWidgets from the workflow node ──────────────────────────

function useFormForNode(
  instanceId: string | null | undefined,
  nodeId: string | null | undefined,
  target: { kind: 'task' | 'approval' | 'consumable'; id: string },
): { node: RuntimeNodeRow | null; widgets: FormWidget[] | null; submitTarget: RuntimeFormSubmitTarget | null; isLoading: boolean } {
  const { data: node, isLoading } = useQuery<RuntimeNodeRow>({
    queryKey: ['runtime-node-config', instanceId, nodeId],
    enabled:  !!instanceId && !!nodeId,
    queryFn:  () => api.get(`/workflow-instances/${instanceId}/nodes/${nodeId}`).then(r => r.data),
  })

  return useMemo(() => {
    const widgets = (node?.config?.formWidgets && Array.isArray(node.config.formWidgets))
      ? node.config.formWidgets : null
    if (!widgets || widgets.length === 0) return { node: node ?? null, widgets: null, submitTarget: null, isLoading }
    return {
      node: node ?? null,
      widgets,
      submitTarget: { kind: target.kind, id: target.id } as RuntimeFormSubmitTarget,
      isLoading,
    }
  }, [isLoading, node, target.id, target.kind])
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function workbenchCompletionFields(data: unknown, finalPack: Record<string, unknown> | null) {
  const record = isPlainRecord(data) ? data : {}
  const stageConsumables = Array.isArray(record.stageConsumables)
    ? record.stageConsumables
    : Array.isArray(finalPack?.stageConsumables) ? finalPack.stageConsumables : []
  const consumableIds = Array.from(new Set([
    ...(Array.isArray(record.consumableIds) ? record.consumableIds : []),
    ...(Array.isArray(finalPack?.consumableIds) ? finalPack.consumableIds : []),
    typeof record.finalPackConsumableId === 'string' ? record.finalPackConsumableId : undefined,
    typeof finalPack?.finalPackConsumableId === 'string' ? finalPack.finalPackConsumableId : undefined,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0)))
  const finalPackConsumableId = typeof record.finalPackConsumableId === 'string'
    ? record.finalPackConsumableId
    : typeof finalPack?.finalPackConsumableId === 'string' ? finalPack.finalPackConsumableId : undefined
  const stageArtifactsByKind = isPlainRecord(record.stageArtifactsByKind)
    ? record.stageArtifactsByKind
    : groupConsumablesByKind(stageConsumables)
  return {
    finalPackConsumableId,
    stageConsumables,
    consumableIds,
    stageArtifactsByKind,
  }
}

function groupConsumablesByKind(refs: unknown[]) {
  return refs.reduce<Record<string, unknown[]>>((acc, ref) => {
    if (!isPlainRecord(ref)) return acc
    const key = typeof ref.artifactKind === 'string' && ref.artifactKind ? ref.artifactKind : 'artifact'
    acc[key] = [...(acc[key] ?? []), ref]
    return acc
  }, {})
}

function buildWorkbenchUrl(workflowInstanceId: string, workflowNodeId: string, config?: Record<string, unknown>) {
  const url = new URL('http://localhost:5176/')
  const bindings = isPlainRecord(config?.agentBindings) ? config.agentBindings : {}
  url.searchParams.set('workflowInstanceId', workflowInstanceId)
  url.searchParams.set('workflowNodeId', workflowNodeId)
  if (typeof config?.phaseId === 'string') url.searchParams.set('phaseId', config.phaseId)
  if (typeof config?.goal === 'string') url.searchParams.set('goal', config.goal)
  else if (typeof config?.task === 'string') url.searchParams.set('goal', config.task)
  if (config?.sourceType === 'github' || config?.sourceType === 'localdir') url.searchParams.set('sourceType', config.sourceType)
  if (typeof config?.sourceUri === 'string') url.searchParams.set('sourceUri', config.sourceUri)
  if (typeof config?.sourceRef === 'string') url.searchParams.set('sourceRef', config.sourceRef)
  if (typeof config?.capabilityId === 'string') url.searchParams.set('capabilityId', config.capabilityId)
  if (typeof bindings.architectAgentTemplateId === 'string') url.searchParams.set('architectAgentTemplateId', bindings.architectAgentTemplateId)
  if (typeof bindings.developerAgentTemplateId === 'string') url.searchParams.set('developerAgentTemplateId', bindings.developerAgentTemplateId)
  if (typeof bindings.qaAgentTemplateId === 'string') url.searchParams.set('qaAgentTemplateId', bindings.qaAgentTemplateId)
  if (config?.gateMode === 'auto' || config?.gateMode === 'manual') url.searchParams.set('gateMode', config.gateMode)
  if (config?.loopDefinition && typeof window !== 'undefined') {
    try {
      url.searchParams.set('loopDefinition', window.btoa(JSON.stringify(config.loopDefinition)))
    } catch {
      // Keep the runtime page usable if a malformed loop config is present.
    }
  }
  return url.toString()
}

// ── Row types (shape returned by /tasks/:id, /approvals/:id, /consumables/:id) ──

type TaskRow = {
  id: string
  title: string
  description?: string | null
  status: string
  assignmentMode?: string | null
  instanceId?: string | null
  nodeId?: string | null
  formData?: Record<string, unknown> | null
  attachments?: UploadedDocument[]
  assignments?: Array<{ id: string; assignedToId?: string | null }>
  queueItems?: Array<{ id: string; claimedById: string | null }>
}
type RuntimeNodeRow = {
  id: string
  nodeType: string
  label: string
  config?: Record<string, unknown> | null
}
type ApprovalRow = {
  id: string
  status: string
  subjectType: string
  assignmentMode?: string | null
  instanceId?: string | null
  nodeId?: string | null
  formData?: Record<string, unknown> | null
}
type ConsumableRow = {
  id: string
  name: string
  status: string
  assignmentMode?: string | null
  instanceId?: string | null
  nodeId?: string | null
  formData?: Record<string, unknown> | null
}
