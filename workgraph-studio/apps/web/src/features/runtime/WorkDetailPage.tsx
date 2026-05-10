import { useMemo } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery, useMutation } from '@tanstack/react-query'
import { ArrowLeft, AlertCircle, CheckCircle2, XCircle, Workflow, Layers } from 'lucide-react'
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

  const { widgets, submitTarget } = useFormForNode(task?.instanceId, task?.nodeId, { kind: 'task', id })

  if (isLoading) return <p style={{ fontSize: 13, color: 'var(--color-outline)' }}>Loading task…</p>
  if (!task)     return <ErrorState message="Task not found" onBack={() => navigate('/runtime')} />

  const isClaimable = task.status === 'OPEN' && (task.queueItems?.length ?? 0) > 0

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

      {widgets && submitTarget && (
        <FormCard
          widgets={widgets}
          submitTarget={submitTarget}
          link={{ taskId: id, nodeId: task.nodeId ?? undefined, instanceId: task.instanceId ?? undefined }}
          initialData={(task.formData as Record<string, unknown>) ?? {}}
          initialAttachments={task.attachments ?? []}
          canComplete={task.status === 'IN_PROGRESS'}
          onSubmitted={() => navigate('/runtime')}
        />
      )}

      {!widgets && task.status === 'IN_PROGRESS' && (
        <SimpleCompleteButton onClick={() => api.post(`/tasks/${id}/complete`).then(() => navigate('/runtime'))} />
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
): { widgets: FormWidget[] | null; submitTarget: RuntimeFormSubmitTarget | null } {
  const { data: node } = useQuery<{ id: string; config: { formWidgets?: FormWidget[] } }>({
    queryKey: ['runtime-node-config', instanceId, nodeId],
    enabled:  !!instanceId && !!nodeId,
    queryFn:  () => api.get(`/workflow-instances/${instanceId}/nodes/${nodeId}`).then(r => r.data),
  })

  return useMemo(() => {
    const widgets = (node?.config?.formWidgets && Array.isArray(node.config.formWidgets))
      ? node.config.formWidgets : null
    if (!widgets || widgets.length === 0) return { widgets: null, submitTarget: null }
    return {
      widgets,
      submitTarget: { kind: target.kind, id: target.id } as RuntimeFormSubmitTarget,
    }
  }, [node, target.id, target.kind])
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
  queueItems?: Array<{ id: string; claimedById: string | null }>
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
