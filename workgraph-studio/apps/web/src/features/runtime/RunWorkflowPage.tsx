/**
 * Start Workflow — end-user catalog page.
 *
 * Lists every workflow the user can see, with a single "Run" action per row.
 * Stripped-down read-only view of the Workflow Manager list (which lives
 * under Administration). Clicking Run pushes the user straight into the
 * browser-runtime player, skipping any design / archive / metadata UI.
 */

import { useMemo, useState, type CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Network, Play, Search, X, Workflow as WorkflowIcon } from 'lucide-react'
import { api } from '../../lib/api'

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
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  const [selectedWorkflow, setSelectedWorkflow] = useState<Workflow | null>(null)

  const { data: workflowsData, isLoading } = useQuery({
    queryKey: ['run-workflows'],
    queryFn:  () => api.get('/workflow-templates').then(r => r.data),
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
          background: 'rgba(0,132,61,0.10)', border: '1px solid rgba(0,132,61,0.25)',
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
  const [mode, setMode] = useState<'workitem' | 'story'>('workitem')
  const [selectedWorkItemTarget, setSelectedWorkItemTarget] = useState('')
  const [vars, setVars] = useState<Record<string, string>>(() => initialVars(workflow))

  const workItemsQuery = useQuery<WorkItemRow[]>({
    queryKey: ['start-workflow-workitems', workflow.capabilityId],
    enabled: Boolean(workflow.capabilityId),
    queryFn: () => api.get('/work-items', {
      params: { targetCapabilityId: workflow.capabilityId, limit: 100 },
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

  const storyMut = useMutation({
    mutationFn: async () => {
      const runName = `${workflow.name} · ${formatStamp(new Date())}`
      return api.post('/workflow-instances', {
        templateId: workflow.id,
        name: runName,
        vars: normalizeVars(vars),
      }).then(r => r.data as { id: string })
    },
    onSuccess: run => onStarted(run.id),
  })

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

  const inputVars = workflow.variables?.filter(v => !v.scope || v.scope === 'INPUT') ?? []
  const canStartStory = Object.values(vars).some(v => v.trim())
  const canStartWorkItem = Boolean(selectedWorkItemTarget)
  const error = storyMut.error || workItemMut.error

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
              Start from an existing unattached WorkItem, or provide a user story as fresh input.
            </p>
          </div>
          <button style={iconButtonStyle} onClick={onClose}><X size={18} /></button>
        </div>

        <div style={modeSwitchStyle}>
          <button style={modeButtonStyle(mode === 'workitem')} onClick={() => setMode('workitem')}><Network size={14} /> Existing WorkItem</button>
          <button style={modeButtonStyle(mode === 'story')} onClick={() => setMode('story')}><Play size={14} /> User story</button>
        </div>

        {mode === 'workitem' ? (
          <section style={sectionStyle}>
            <h3 style={sectionTitleStyle}>Unattached WorkItems for this capability</h3>
            {!workflow.capabilityId ? (
              <p style={mutedStyle}>This workflow is not tied to a capability, so WorkItem queue matching is unavailable.</p>
            ) : workItemsQuery.isLoading ? (
              <p style={mutedStyle}>Loading WorkItems...</p>
            ) : availableWorkItems.length === 0 ? (
              <p style={mutedStyle}>No unattached WorkItems are available for this workflow capability. Use User story mode or create a WorkItem first.</p>
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
            <p style={{ ...mutedStyle, marginTop: 8 }}>
              The child run will receive `_workItem`, `workItemId`, details, budget, urgency, and target capability in context.
            </p>
            <div style={footerStyle}>
              <button style={secondaryButtonStyle} onClick={onClose}>Cancel</button>
              <button style={primaryButtonStyle} disabled={!canStartWorkItem || workItemMut.isPending} onClick={() => workItemMut.mutate()}>
                {workItemMut.isPending ? 'Starting...' : 'Start from WorkItem'}
              </button>
            </div>
          </section>
        ) : (
          <section style={sectionStyle}>
            <h3 style={sectionTitleStyle}>User story input</h3>
            {(inputVars.length ? inputVars : [{ key: 'story', label: 'User story', type: 'textarea' }]).map(v => (
              <label key={v.key} style={labelStyle}>
                {v.label || v.key}
                {v.type === 'textarea' || v.key.toLowerCase().includes('story') ? (
                  <textarea
                    rows={5}
                    value={vars[v.key] ?? ''}
                    onChange={event => setVars(prev => ({ ...prev, [v.key]: event.target.value }))}
                    placeholder={v.description || `Enter ${v.label || v.key}`}
                    style={{ ...inputStyle, resize: 'vertical' }}
                  />
                ) : (
                  <input
                    value={vars[v.key] ?? ''}
                    onChange={event => setVars(prev => ({ ...prev, [v.key]: event.target.value }))}
                    placeholder={v.description || `Enter ${v.label || v.key}`}
                    style={inputStyle}
                  />
                )}
              </label>
            ))}
            <div style={footerStyle}>
              <button style={secondaryButtonStyle} onClick={onClose}>Cancel</button>
              <button style={primaryButtonStyle} disabled={!canStartStory || storyMut.isPending} onClick={() => storyMut.mutate()}>
                {storyMut.isPending ? 'Starting...' : 'Start from story'}
              </button>
            </div>
          </section>
        )}

        {error && <p style={{ margin: '10px 0 0', color: '#b91c1c', fontSize: 12 }}>{(error as Error).message}</p>}
      </div>
    </div>
  )
}

function WorkflowCard({ workflow, onRun }: { workflow: Workflow; onRun: () => void }) {
  return (
    <div style={{
      padding: '14px 16px', borderRadius: 12,
      background: '#fff', border: '1px solid var(--color-outline-variant)',
      display: 'flex', flexDirection: 'column', gap: 10,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{
          width: 32, height: 32, borderRadius: 8, flexShrink: 0,
          background: 'rgba(0,132,61,0.08)', border: '1px solid rgba(0,132,61,0.18)',
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
        <Play size={11} /> Run
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

function initialVars(workflow: Workflow): Record<string, string> {
  const vars: Record<string, string> = {}
  for (const variable of workflow.variables ?? []) {
    if (variable.scope && variable.scope !== 'INPUT') continue
    if (variable.defaultValue !== undefined && variable.defaultValue !== null) vars[variable.key] = String(variable.defaultValue)
    else vars[variable.key] = ''
  }
  if (Object.keys(vars).length === 0) vars.story = ''
  return vars
}

function normalizeVars(vars: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(vars)) {
    if (value.trim()) out[key] = value.trim()
  }
  return out
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

function formatStamp(d: Date) {
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
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

const modeSwitchStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: 8,
  padding: 4,
  borderRadius: 12,
  background: '#f1f5f9',
  marginBottom: 14,
}

const modeButtonStyle = (active: boolean): CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 7,
  padding: '10px 12px',
  borderRadius: 10,
  border: active ? '1px solid rgba(0,132,61,0.28)' : '1px solid transparent',
  background: active ? '#fff' : 'transparent',
  color: active ? '#006227' : '#475569',
  cursor: 'pointer',
  fontWeight: 900,
  fontSize: 12,
})

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

const labelStyle: CSSProperties = {
  display: 'grid',
  gap: 6,
  color: '#475569',
  fontSize: 11,
  fontWeight: 900,
  marginBottom: 10,
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
