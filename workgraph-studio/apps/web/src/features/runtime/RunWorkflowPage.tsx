/**
 * Start Workflow — end-user catalog page.
 *
 * Lists every workflow the user can see, with a single "Run" action per row.
 * Stripped-down read-only view of the Workflow Manager list (which lives
 * under Administration). Clicking Run pushes the user straight into the
 * browser-runtime player, skipping any design / archive / metadata UI.
 */

import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { usePlatformNavigate } from '../../lib/usePlatformNavigate'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Network, Play, Search, X, Workflow as WorkflowIcon } from 'lucide-react'
import { api } from '../../lib/api'
import { useActiveContextStore } from '../../store/activeContext.store'
import { CapabilityPicker } from '../../components/lookup/EntityPickers'
import { useCapabilityLabels } from './useCapabilityLabels'

type Workflow = {
  id:             string
  name:           string
  description?:   string
  status?:        string
  capabilityId?:  string | null
  archivedAt?:    string | null
  variables?:     Array<{ key: string; label?: string; type?: string; defaultValue?: unknown; scope?: string; description?: string }>
}

export function RunWorkflowPage() {
  const navigate = usePlatformNavigate()
  const [search, setSearch] = useState('')
  const [selectedWorkflow, setSelectedWorkflow] = useState<Workflow | null>(null)
  const activeContext = useActiveContextStore(s => s.active)
  const [capabilityFilter, setCapabilityFilter] = useState(activeContext?.capabilityId ?? '')

  useEffect(() => {
    setCapabilityFilter(activeContext?.capabilityId ?? '')
  }, [activeContext?.capabilityId])

  const { data: workflowsData, isLoading } = useQuery({
    queryKey: ['run-workflows', capabilityFilter],
    queryFn:  () => api.get('/workflow-templates', {
      params: {
        size: 100,
        ...(capabilityFilter ? { capabilityId: capabilityFilter } : {}),
      },
    }).then(r => r.data),
    staleTime: 30_000,
  })
  const workflows: Workflow[] = useMemo(() => {
    const raw = Array.isArray(workflowsData)
      ? workflowsData
      : Array.isArray(workflowsData?.content) ? workflowsData.content : []
    return raw.filter((w: Workflow) => !w.archivedAt && w.status !== 'ARCHIVED')
  }, [workflowsData])

  const filtered = useMemo(() => {
    if (!search.trim()) return workflows
    const q = search.toLowerCase()
    return workflows.filter(w =>
      w.name.toLowerCase().includes(q) ||
      (w.description ?? '').toLowerCase().includes(q),
    )
  }, [workflows, search])

  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
        <div style={{
          width: 38, height: 38, borderRadius: 10,
          background: 'rgba(54,135,39,0.10)', border: '1px solid rgba(54,135,39,0.25)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-primary)',
        }}>
          <Play size={18} />
        </div>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 800, color: 'var(--color-on-surface)', margin: 0, letterSpacing: '-0.01em' }}>
            Start Workflow
          </h1>
          <p style={{ fontSize: 12, color: 'var(--color-outline)', margin: 0 }}>
            Pick a workflow and start a run. Designs and edits live under Administration.
          </p>
        </div>
      </div>

      <div style={{ position: 'relative', margin: '18px 0' }}>
        <Search size={13} style={{ position: 'absolute', top: '50%', left: 12, transform: 'translateY(-50%)', color: 'var(--color-outline)' }} />
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search workflows by name or description…"
          style={{
            width: '100%', boxSizing: 'border-box',
            padding: '10px 12px 10px 34px', borderRadius: 10,
            border: '1px solid var(--color-outline-variant)', background: '#fff',
            fontSize: 13, outline: 'none',
          }}
        />
      </div>

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(260px, 1fr) auto auto',
        gap: 10,
        alignItems: 'end',
        padding: 12,
        borderRadius: 14,
        border: '1px solid var(--color-outline-variant)',
        background: '#fff',
        marginBottom: 18,
      }}>
        <div>
          <p style={{ margin: '0 0 6px', fontSize: 10, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.12em', color: '#516179' }}>
            Capability focus
          </p>
          <CapabilityPicker
            value={capabilityFilter}
            onChange={setCapabilityFilter}
            placeholder="All capabilities"
            filterToMemberships={false}
            autoDefault={false}
            hint={activeContext
              ? `Active capability: ${activeContext.capabilityName}. Start Workflow defaults to this focus.`
              : 'Choose a capability to show matching workflow templates.'}
          />
        </div>
        {activeContext && capabilityFilter !== activeContext.capabilityId && (
          <button
            onClick={() => setCapabilityFilter(activeContext.capabilityId)}
            style={{
              padding: '9px 12px',
              borderRadius: 9,
              border: '1px solid rgba(54,135,39,0.25)',
              background: 'rgba(54,135,39,0.08)',
              color: 'var(--color-primary)',
              cursor: 'pointer',
              fontSize: 12,
              fontWeight: 800,
            }}
          >
            Use active
          </button>
        )}
        {capabilityFilter && (
          <button
            onClick={() => setCapabilityFilter('')}
            style={{
              padding: '9px 12px',
              borderRadius: 9,
              border: '1px solid var(--color-outline-variant)',
              background: '#fff',
              color: '#475569',
              cursor: 'pointer',
              fontSize: 12,
              fontWeight: 800,
            }}
          >
            Show all
          </button>
        )}
      </div>

      {isLoading ? (
        <p style={{ fontSize: 13, color: 'var(--color-outline)' }}>Loading workflows…</p>
      ) : filtered.length === 0 ? (
        <EmptyState />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10 }}>
          {filtered.map(w => (
            <WorkflowCard
              key={w.id}
              workflow={w}
              onRun={() => setSelectedWorkflow(w)}
            />
          ))}
        </div>
      )}
      {selectedWorkflow && (
        <StartWorkflowDialog
          workflow={selectedWorkflow}
          onClose={() => setSelectedWorkflow(null)}
          onStarted={(runId) => navigate(`/runs/${runId}`)}
        />
      )}
    </div>
  )
}

function StartWorkflowDialog({
  workflow,
  onClose,
  onStarted,
}: {
  workflow: Workflow
  onClose: () => void
  onStarted: (runId: string) => void
}) {
  const [selectedWorkItemTarget, setSelectedWorkItemTarget] = useState('')

  const workItemsQuery = useQuery<WorkItemRow[]>({
    queryKey: ['start-workflow-workitems', workflow.capabilityId],
    enabled: Boolean(workflow.capabilityId),
    queryFn: () => api.get('/work-items', {
      params: { targetCapabilityId: workflow.capabilityId, available: true, limit: 100 },
    }).then(r => unwrapItems<WorkItemRow>(r.data)),
  })
  const availableWorkItems = useMemo(() => {
    const rows = workItemsQuery.data ?? []
    return rows.flatMap(item => item.targets
      .filter(target =>
        target.targetCapabilityId === workflow.capabilityId &&
        !target.childWorkflowInstanceId &&
        ['QUEUED', 'CLAIMED', 'REWORK_REQUESTED'].includes(target.status))
      .map(target => ({ item, target })))
  }, [workItemsQuery.data, workflow.capabilityId])

  const workItemMut = useMutation({
    mutationFn: async () => {
      const selected = availableWorkItems.find(row => `${row.item.id}:${row.target.id}` === selectedWorkItemTarget)
      if (!selected) throw new Error('Select a WorkItem before starting')
      if (['QUEUED', 'REWORK_REQUESTED'].includes(selected.target.status)) {
        await api.post(`/work-items/${selected.item.id}/targets/${selected.target.id}/claim`)
      }
      return api.post(`/work-items/${selected.item.id}/targets/${selected.target.id}/start`, {
        childWorkflowTemplateId: workflow.id,
      }).then(r => r.data as { childWorkflowInstanceId?: string })
    },
    onSuccess: result => {
      if (result.childWorkflowInstanceId) onStarted(result.childWorkflowInstanceId)
    },
  })

  const canStartWorkItem = Boolean(selectedWorkItemTarget)
  const selected = availableWorkItems.find(row => `${row.item.id}:${row.target.id}` === selectedWorkItemTarget)

  return (
    <div style={modalBackdropStyle}>
      <div style={modalStyle}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, justifyContent: 'space-between', marginBottom: 14 }}>
          <div>
            <p style={{ margin: 0, fontSize: 10, color: '#64748b', fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.12em' }}>
              Start workflow
            </p>
            <h2 style={{ margin: '4px 0 0', color: '#0f172a', fontSize: 22 }}>{workflow.name}</h2>
            <p style={{ margin: '4px 0 0', color: '#64748b', fontSize: 13 }}>
              Select an unattached WorkItem. The WorkItem packet becomes the workflow input.
            </p>
          </div>
          <button style={iconButtonStyle} onClick={onClose}><X size={18} /></button>
        </div>

        <section style={sectionStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <Network size={15} style={{ color: '#7c3aed' }} />
            <h3 style={{ ...sectionTitleStyle, margin: 0 }}>WorkItem input</h3>
          </div>
          {!workflow.capabilityId ? (
            <p style={mutedStyle}>
              This workflow has no capability owner. Attach a capability before it can be started from a WorkItem.
            </p>
          ) : workItemsQuery.isLoading ? (
            <p style={mutedStyle}>Loading WorkItems...</p>
          ) : availableWorkItems.length === 0 ? (
            <p style={mutedStyle}>
              No unattached WorkItems are available for this capability. Create or receive a WorkItem first, then attach this workflow.
            </p>
          ) : (
            <select value={selectedWorkItemTarget} onChange={event => setSelectedWorkItemTarget(event.target.value)} style={inputStyle}>
              <option value="">Select an unattached WorkItem</option>
              {availableWorkItems.map(({ item, target }) => (
                <option key={`${item.id}:${target.id}`} value={`${item.id}:${target.id}`}>
                  {item.workCode ?? item.id.slice(0, 8)} · {item.title} · {target.status}
                </option>
              ))}
            </select>
          )}
          {selected && (
            <div style={{
              marginTop: 12,
              padding: 12,
              borderRadius: 12,
              border: '1px solid rgba(124,58,237,0.22)',
              background: 'rgba(124,58,237,0.06)',
            }}>
              <p style={{ margin: 0, color: '#0f172a', fontWeight: 900, fontSize: 13 }}>
                {selected.item.workCode ?? selected.item.id.slice(0, 8)} · {selected.item.title}
              </p>
              {selected.item.description && (
                <p style={{ margin: '5px 0 0', color: '#475569', fontSize: 12, lineHeight: 1.45 }}>
                  {selected.item.description}
                </p>
              )}
              <p style={{ ...mutedStyle, marginTop: 8 }}>
                Status: {selected.target.status} · urgency: {selected.item.urgency ?? 'NORMAL'}
              </p>
            </div>
          )}
          <p style={{ ...mutedStyle, marginTop: 8 }}>
            The run receives `_workItem`, `workItemId`, details, budget, urgency, required date, and target capability in context.
          </p>
          <div style={footerStyle}>
            <button style={secondaryButtonStyle} onClick={onClose}>Cancel</button>
            <button style={primaryButtonStyle} disabled={!canStartWorkItem || workItemMut.isPending} onClick={() => workItemMut.mutate()}>
              {workItemMut.isPending ? 'Starting...' : 'Start from WorkItem'}
            </button>
          </div>
        </section>

        {workItemMut.error && (
          <p style={{ margin: '10px 0 0', color: '#b91c1c', fontSize: 12 }}>
            {(workItemMut.error as Error).message}
          </p>
        )}
      </div>
    </div>
  )
}

function WorkflowCard({ workflow, onRun }: { workflow: Workflow; onRun: () => void }) {
  const { labelForCapability } = useCapabilityLabels()
  return (
    <div style={{
      padding: '14px 16px', borderRadius: 12,
      background: '#fff', border: '1px solid var(--color-outline-variant)',
      display: 'flex', flexDirection: 'column', gap: 10,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{
          width: 32, height: 32, borderRadius: 8, flexShrink: 0,
          background: 'rgba(54,135,39,0.08)', border: '1px solid rgba(54,135,39,0.18)',
          color: 'var(--color-primary)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <WorkflowIcon size={14} />
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <h3 style={{
            fontSize: 14, fontWeight: 700, color: 'var(--color-on-surface)',
            margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {workflow.name}
          </h3>
          {workflow.description && (
            <p style={{
              fontSize: 11, color: 'var(--color-outline)', margin: '4px 0 0',
              overflow: 'hidden', textOverflow: 'ellipsis',
              display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
            }}>
              {workflow.description}
            </p>
          )}
          {workflow.capabilityId && (
            <p style={{ fontSize: 10, color: 'var(--color-primary)', margin: '5px 0 0', fontWeight: 800 }}>
              {labelForCapability(workflow.capabilityId)}
            </p>
          )}
        </div>
      </div>

      <button
        onClick={onRun}
        style={{
          alignSelf: 'flex-start',
          padding: '7px 14px', borderRadius: 8, border: 'none', cursor: 'pointer',
          background: 'var(--color-primary)', color: '#fff',
          fontSize: 12, fontWeight: 700,
          display: 'inline-flex', alignItems: 'center', gap: 6,
        }}
      >
        <Play size={11} /> Start from WorkItem
      </button>
    </div>
  )
}

function EmptyState() {
  return (
    <div style={{
      padding: '40px 16px', textAlign: 'center',
      borderRadius: 12, border: '1px dashed var(--color-outline-variant)',
      background: 'rgba(0,0,0,0.02)',
    }}>
      <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-on-surface)', margin: 0 }}>
        No workflows are available to run.
      </p>
      <p style={{ fontSize: 11, color: 'var(--color-outline)', margin: '6px 0 0' }}>
        Ask an administrator to publish a workflow you can run.
      </p>
    </div>
  )
}

function unwrapItems<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[]
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>
    if (Array.isArray(obj.items)) return obj.items as T[]
    if (Array.isArray(obj.content)) return obj.content as T[]
    if (Array.isArray(obj.data)) return obj.data as T[]
  }
  return []
}

type WorkItemTarget = {
  id: string
  targetCapabilityId: string
  status: string
  childWorkflowInstanceId?: string | null
}

type WorkItemRow = {
  id: string
  workCode?: string | null
  title: string
  description?: string | null
  urgency?: string | null
  targets: WorkItemTarget[]
}

const modalBackdropStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 50,
  background: 'rgba(15,23,42,0.42)',
  display: 'grid',
  placeItems: 'center',
  padding: 18,
}

const modalStyle: CSSProperties = {
  width: 'min(760px, 100%)',
  maxHeight: '88vh',
  overflow: 'auto',
  borderRadius: 18,
  background: '#fff',
  border: '1px solid var(--color-outline-variant)',
  boxShadow: '0 24px 80px rgba(15,23,42,0.26)',
  padding: 18,
}

const iconButtonStyle: CSSProperties = {
  width: 34,
  height: 34,
  borderRadius: 10,
  border: '1px solid var(--color-outline-variant)',
  background: '#fff',
  color: '#64748b',
  cursor: 'pointer',
  display: 'grid',
  placeItems: 'center',
}

const sectionStyle: CSSProperties = {
  padding: 14,
  borderRadius: 14,
  border: '1px solid var(--color-outline-variant)',
  background: '#fff',
}

const sectionTitleStyle: CSSProperties = {
  margin: '0 0 10px',
  color: '#0f172a',
  fontSize: 15,
  fontWeight: 900,
}

const inputStyle: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '10px 12px',
  borderRadius: 10,
  border: '1px solid var(--color-outline-variant)',
  background: '#fff',
  color: '#0f172a',
  fontSize: 13,
  outline: 'none',
}

const mutedStyle: CSSProperties = {
  margin: 0,
  color: '#64748b',
  fontSize: 12,
  lineHeight: 1.5,
}

const footerStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: 8,
  marginTop: 12,
}

const primaryButtonStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 7,
  padding: '9px 14px',
  borderRadius: 10,
  border: 'none',
  background: 'var(--color-primary)',
  color: '#fff',
  fontSize: 12,
  fontWeight: 900,
  cursor: 'pointer',
}

const secondaryButtonStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 7,
  padding: '9px 14px',
  borderRadius: 10,
  border: '1px solid var(--color-outline-variant)',
  background: '#fff',
  color: '#0f172a',
  fontSize: 12,
  fontWeight: 900,
  cursor: 'pointer',
}
