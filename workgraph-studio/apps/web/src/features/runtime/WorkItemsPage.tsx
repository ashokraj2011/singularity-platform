import { useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery } from '@tanstack/react-query'
import {
  AlertCircle,
  ArrowRight,
  Archive,
  CalendarClock,
  CheckCircle2,
  ExternalLink,
  GitBranch,
  ListChecks,
  Network,
  Play,
  Plus,
  RefreshCw,
  Route,
  Search,
  Unlink,
  Workflow,
} from 'lucide-react'
import { api } from '../../lib/api'
import { CapabilityPicker } from '../../components/lookup/EntityPickers'
import { useActiveContextStore } from '../../store/activeContext.store'
import { useCapabilityLabels } from './useCapabilityLabels'

const TARGET_STATUSES = ['ALL', 'QUEUED', 'CLAIMED', 'IN_PROGRESS', 'SUBMITTED', 'APPROVED', 'REWORK_REQUESTED', 'ARCHIVED'] as const

export function WorkItemsPage() {
  const navigate = useNavigate()
  const active = useActiveContextStore(s => s.active)
  const [capabilityId, setCapabilityId] = useState(active?.capabilityId ?? '')
  const [status, setStatus] = useState<(typeof TARGET_STATUSES)[number]>('ALL')
  const [mine, setMine] = useState(false)
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<string>('')
  const [selectedWorkflowByTarget, setSelectedWorkflowByTarget] = useState<Record<string, string>>({})
  const [createOpen, setCreateOpen] = useState(false)

  const workItemsQuery = useQuery<WorkItemsResponse>({
    queryKey: ['workitems-board', capabilityId, status, mine],
    queryFn: () => api.get('/work-items', {
      params: {
        targetCapabilityId: capabilityId || undefined,
        status: status === 'ALL' ? undefined : status,
        mine: mine ? 'true' : undefined,
        limit: 100,
      },
    }).then(r => r.data as WorkItemsResponse),
    refetchInterval: 15_000,
  })

  const workItems = workItemsQuery.data?.items ?? []
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return workItems
    return workItems.filter(item =>
      item.title.toLowerCase().includes(q) ||
      item.workCode?.toLowerCase().includes(q) ||
      item.description?.toLowerCase().includes(q) ||
      JSON.stringify(item.details ?? {}).toLowerCase().includes(q),
    )
  }, [search, workItems])
  const selected = filtered.find(item => item.id === selectedId) ?? filtered[0] ?? null
  const selectedTarget = selected?.targets[0] ?? null
  const selectedWorkflow = selectedTarget ? selectedWorkflowByTarget[selectedTarget.id] ?? '' : ''
  const effectiveWorkflow = selectedTarget?.childWorkflowTemplateId || selectedWorkflow
  const { labelForCapability } = useCapabilityLabels()
  const selectedTargetCapability = labelForCapability(selectedTarget?.targetCapabilityId)

  const workflowsQuery = useQuery<WorkflowOption[]>({
    queryKey: ['workitems-board-workflows', selectedTarget?.targetCapabilityId],
    enabled: Boolean(selectedTarget?.targetCapabilityId && !selectedTarget?.childWorkflowInstanceId),
    queryFn: () => api.get('/workflows', { params: { capabilityId: selectedTarget?.targetCapabilityId, size: 100 } })
      .then(r => unwrapItems<WorkflowOption>(r.data)),
  })
  const allWorkflowsQuery = useQuery<WorkflowOption[]>({
    queryKey: ['workitems-board-workflows-all'],
    enabled: Boolean(
      selectedTarget?.targetCapabilityId &&
      !selectedTarget?.childWorkflowInstanceId &&
      ((workflowsQuery.isSuccess && (workflowsQuery.data ?? []).length === 0) || workflowsQuery.isError),
    ),
    queryFn: () => api.get('/workflows', { params: { size: 100 } }).then(r => unwrapItems<WorkflowOption>(r.data)),
  })
  const workflowOptions = workflowsQuery.data?.length
    ? workflowsQuery.data
    : allWorkflowsQuery.data ?? []
  const missingCapabilityWorkflows = workflowsQuery.isError || (workflowsQuery.isSuccess && (workflowsQuery.data ?? []).length === 0)
  const usingFallbackWorkflows = Boolean(selectedTarget?.targetCapabilityId && missingCapabilityWorkflows && workflowOptions.length > 0)
  const hubStats = useMemo(() => buildHubStats(filtered), [filtered])
  const selectedNextAction = selected
    ? describeNextAction(selected, selectedTarget, effectiveWorkflow, workflowOptions.length, selectedTargetCapability)
    : null
  const selectedFlow = selected
    ? buildWorkItemFlow(selected, selectedTarget, selectedTargetCapability)
    : []

  const claimMut = useMutation({
    mutationFn: ({ workItemId, targetId }: { workItemId: string; targetId: string }) =>
      api.post(`/work-items/${workItemId}/targets/${targetId}/claim`).then(r => r.data),
    onSuccess: () => workItemsQuery.refetch(),
  })

  const startMut = useMutation({
    mutationFn: ({ workItemId, targetId, workflowId }: { workItemId: string; targetId: string; workflowId?: string }) =>
      api.post(`/work-items/${workItemId}/targets/${targetId}/start`, workflowId ? { childWorkflowTemplateId: workflowId } : {}).then(r => r.data as { childWorkflowInstanceId?: string }),
    onSuccess: (data) => {
      workItemsQuery.refetch()
      if (data.childWorkflowInstanceId) navigate(`/runs/${data.childWorkflowInstanceId}`)
    },
  })

  const claimAndStartMut = useMutation({
    mutationFn: async ({ workItemId, targetId, workflowId }: { workItemId: string; targetId: string; workflowId: string }) => {
      await api.post(`/work-items/${workItemId}/targets/${targetId}/claim`)
      return api.post(`/work-items/${workItemId}/targets/${targetId}/start`, { childWorkflowTemplateId: workflowId }).then(r => r.data as { childWorkflowInstanceId?: string })
    },
    onSuccess: (data) => {
      workItemsQuery.refetch()
      if (data.childWorkflowInstanceId) navigate(`/runs/${data.childWorkflowInstanceId}`)
    },
  })

  const archiveMut = useMutation({
    mutationFn: (workItemId: string) => api.post(`/work-items/${workItemId}/archive`).then(r => r.data as WorkItemRow),
    onSuccess: () => {
      setSelectedId('')
      workItemsQuery.refetch()
    },
  })

  const detachMut = useMutation({
    mutationFn: (workItemId: string) => api.post(`/work-items/${workItemId}/detach`, {
      reason: 'Detached from workflow from WorkItems board',
    }).then(r => r.data as WorkItemRow),
    onSuccess: (item) => {
      setSelectedId(item.id)
      workItemsQuery.refetch()
    },
  })
  const detachTargetMut = useMutation({
    mutationFn: ({ workItemId, targetId }: { workItemId: string; targetId: string }) =>
      api.post(`/work-items/${workItemId}/targets/${targetId}/detach`, {
        reason: 'Detached child workflow run from WorkItems board',
      }).then(r => r.data as WorkItemRow),
    onSuccess: (item) => {
      setSelectedId(item.id)
      workItemsQuery.refetch()
    },
  })

  const canClaim = selectedTarget && ['QUEUED', 'REWORK_REQUESTED'].includes(selectedTarget.status) && !selectedTarget.claimedById
  const canStart = selected && selectedTarget && selectedTarget.status === 'CLAIMED' && !!effectiveWorkflow && !selectedTarget.childWorkflowInstanceId
  const canClaimAndStart = selected && selectedTarget && canClaim && !!effectiveWorkflow
  const canDetach = Boolean(
    selected &&
    !['COMPLETED', 'ARCHIVED'].includes(selected.status) &&
    (selected.originType === 'PARENT_DELEGATED' || selected.sourceWorkflowInstanceId || selected.sourceWorkflowNodeId),
  )
  const canDetachTarget = Boolean(
    selected &&
    selectedTarget?.childWorkflowInstanceId &&
    !['SUBMITTED', 'APPROVED'].includes(selectedTarget.status) &&
    !['COMPLETED', 'ARCHIVED'].includes(selected.status),
  )

  return (
    <div style={{ padding: 24, maxWidth: 1440, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <div style={pageIconStyle}><Network size={18} /></div>
        <div>
          <p style={eyebrowStyle}>Work Hub</p>
          <h1 style={pageTitleStyle}>WorkItems</h1>
          <p style={pageSubStyle}>Route business work into the right workflow, monitor the current run, and keep the request packet and evidence together.</p>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button style={primaryButtonStyle} onClick={() => setCreateOpen(true)}>
            <Plus size={13} /> New WorkItem
          </button>
          <button style={secondaryButtonStyle} onClick={() => workItemsQuery.refetch()}>
            <RefreshCw size={13} /> Refresh
          </button>
        </div>
      </div>

      <section style={hubStatsStyle}>
        <HubStat icon={<ListChecks size={15} />} label="In this queue" value={String(hubStats.total)} tone="neutral" />
        <HubStat icon={<Route size={15} />} label="Need routing" value={String(hubStats.needsRoute)} tone={hubStats.needsRoute ? 'warning' : 'neutral'} />
        <HubStat icon={<Workflow size={15} />} label="Running" value={String(hubStats.running)} tone="primary" />
        <HubStat icon={<CalendarClock size={15} />} label="Scheduled" value={String(hubStats.scheduled)} tone="neutral" />
        <HubStat icon={<AlertCircle size={15} />} label="Blocked" value={String(hubStats.blocked)} tone={hubStats.blocked ? 'danger' : 'neutral'} />
      </section>

      <section style={filterBarStyle}>
        <div style={{ minWidth: 260, flex: '1 1 320px' }}>
          <label style={labelStyle}>Capability queue</label>
          <CapabilityPicker
            value={capabilityId}
            onChange={value => {
              setCapabilityId(value)
              setSelectedId('')
            }}
            placeholder="All capability queues"
            filterToMemberships={false}
            autoDefault={false}
          />
        </div>
        <div style={{ minWidth: 180 }}>
          <label style={labelStyle}>Status</label>
          <select value={status} onChange={event => setStatus(event.target.value as typeof status)} style={inputStyle}>
            {TARGET_STATUSES.map(value => <option key={value} value={value}>{value === 'ALL' ? 'All statuses' : value.replaceAll('_', ' ')}</option>)}
          </select>
        </div>
        <label style={{ ...labelStyle, minWidth: 130, alignSelf: 'end', paddingBottom: 10, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" checked={mine} onChange={event => setMine(event.target.checked)} />
          Mine only
        </label>
        <div style={{ minWidth: 260, flex: '1 1 300px' }}>
          <label style={labelStyle}>Search</label>
          <div style={{ position: 'relative' }}>
            <Search size={13} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#64748b' }} />
            <input value={search} onChange={event => setSearch(event.target.value)} placeholder="WRK id, title, detail..." style={{ ...inputStyle, paddingLeft: 30 }} />
          </div>
        </div>
      </section>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(340px, 460px) minmax(0, 1fr)', gap: 16, alignItems: 'start' }}>
        <section style={listPanelStyle}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <h2 style={panelTitleStyle}>Existing WorkItems</h2>
            <span style={countChipStyle}>{filtered.length}</span>
          </div>
          {workItemsQuery.isLoading ? (
            <p style={mutedStyle}>Loading WorkItems...</p>
          ) : filtered.length === 0 ? (
            <div style={emptyStyle}>
              <Network size={28} style={{ opacity: 0.35 }} />
              <strong>No WorkItems found</strong>
              <span>Try another capability queue, status, or clear the search.</span>
            </div>
          ) : (
            <div style={{ display: 'grid', gap: 8 }}>
              {filtered.map(item => {
                const target = item.targets[0]
                const isActive = item.id === selected?.id
                return (
                  <button key={item.id} onClick={() => setSelectedId(item.id)} style={{ ...itemCardStyle, borderColor: isActive ? '#8b5cf6' : 'var(--color-outline-variant)', background: isActive ? 'rgba(139,92,246,0.06)' : '#fff' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <strong style={{ color: '#111827', fontSize: 13 }}>{item.workCode ?? item.id.slice(0, 8)}</strong>
                      <StatusPill status={target?.status ?? item.status} />
                    </div>
                    <p style={{ margin: '5px 0 3px', color: '#111827', fontSize: 13, fontWeight: 800 }}>{item.title}</p>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 11, color: '#475569' }}>
                      {target?.targetCapabilityId && (
                        <>
                          <span>{labelForCapability(target.targetCapabilityId)}</span>
                          <span>·</span>
                        </>
                      )}
                      <span>{item.originType === 'PARENT_DELEGATED' ? 'Parent delegated' : 'Local work'}</span>
                      <span>·</span>
                      <span>{formatEnum(item.workItemTypeKey ?? 'GENERAL')}</span>
                      <span>·</span>
                      <span>{formatEnum(item.urgency ?? 'NORMAL')}</span>
                      {item.routingState && <><span>·</span><span>{formatEnum(item.routingState)}</span></>}
                      {item.requiredBy && <><span>·</span><CalendarClock size={10} /><span>{new Date(item.requiredBy).toLocaleDateString()}</span></>}
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </section>

        <section style={detailPanelStyle}>
          {!selected ? (
            <div style={emptyDetailStyle}>
              <Workflow size={34} style={{ opacity: 0.35 }} />
              <h2>Select a WorkItem</h2>
              <p>Choose an existing WorkItem from the left. You can then attach a workflow and start the child run.</p>
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, justifyContent: 'space-between', marginBottom: 14 }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={workCodeStyle}>{selected.workCode ?? selected.id.slice(0, 8)}</span>
                    <StatusPill status={selected.status} />
                    <StatusPill status={selected.originType === 'PARENT_DELEGATED' ? 'FROM_PARENT' : 'LOCAL'} />
                  </div>
                  <h2 style={{ margin: '8px 0 4px', fontSize: 22, color: '#0f172a' }}>{selected.title}</h2>
                  {selected.description && <p style={{ margin: 0, color: '#475569', fontSize: 13, lineHeight: 1.55 }}>{selected.description}</p>}
                </div>
                <button style={secondaryButtonStyle} onClick={() => navigate(`/runtime/work/workitem/${selected.id}${selectedTarget ? `?targetId=${selectedTarget.id}` : ''}`)}>
                  <ExternalLink size={13} /> Open detail
                </button>
                {canDetach && (
                  <button
                    style={{ ...secondaryButtonStyle, borderColor: 'rgba(245,158,11,0.32)', color: '#92400e' }}
                    disabled={detachMut.isPending}
                    onClick={() => {
                      if (window.confirm(`Detach ${selected.workCode ?? selected.title} from its source workflow and return it to the available queue?`)) {
                        detachMut.mutate(selected.id)
                      }
                    }}
                  >
                    <Unlink size={13} /> {detachMut.isPending ? 'Detaching...' : 'Detach'}
                  </button>
                )}
                {selected.originType === 'CAPABILITY_LOCAL' && selected.status !== 'ARCHIVED' && (
                  <button
                    style={{ ...secondaryButtonStyle, borderColor: 'rgba(220,38,38,0.28)', color: '#b91c1c' }}
                    disabled={archiveMut.isPending}
                    onClick={() => {
                      if (window.confirm(`Archive ${selected.workCode ?? selected.title}? It will be hidden from normal WorkItem queues.`)) {
                        archiveMut.mutate(selected.id)
                      }
                    }}
                  >
                    <Archive size={13} /> {archiveMut.isPending ? 'Archiving...' : 'Archive'}
                  </button>
                )}
              </div>

              <WorkItemFlow stages={selectedFlow} />

              {selectedNextAction && (
                <section style={nextActionStyle(selectedNextAction.tone)}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    {selectedNextAction.icon}
                    <div>
                      <p style={{ margin: 0, fontSize: 10, color: selectedNextAction.color, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Next action</p>
                      <h3 style={{ margin: '2px 0 0', color: '#0f172a', fontSize: 16 }}>{selectedNextAction.title}</h3>
                    </div>
                  </div>
                  <p style={{ margin: '8px 0 0', color: '#475569', fontSize: 13, lineHeight: 1.5 }}>{selectedNextAction.detail}</p>
                </section>
              )}

              <div style={metricGridStyle}>
                <Metric label="Target capability" value={selectedTargetCapability} />
                <Metric label="WorkItem type" value={formatEnum(selected.workItemTypeKey ?? 'GENERAL')} />
                <Metric label="Routing" value={`${formatEnum(selected.routingMode ?? 'MANUAL')} · ${displayRoutingState(selected, selectedTarget)}`} />
                <Metric label="Urgency" value={formatEnum(selected.urgency ?? 'NORMAL')} />
                <Metric label="Required by" value={selected.requiredBy ? new Date(selected.requiredBy).toLocaleString() : 'Not set'} />
                <Metric label="Details" value={selected.detailsLocked ? 'Locked packet' : 'Editable'} />
              </div>

              {selectedTarget && (
                <div style={actionBoxStyle}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 10 }}>
                    <div>
                      <h3 style={{ margin: 0, fontSize: 15, color: '#0f172a' }}>
                        {selectedTarget.childWorkflowInstanceId ? 'Current workflow run' : 'Attach workflow and run'}
                      </h3>
                      <p style={{ margin: '2px 0 0', color: '#64748b', fontSize: 12 }}>
                        {selectedTarget.childWorkflowInstanceId
                          ? 'This WorkItem already has an attached run. Open it for stage progress, evidence, and approvals.'
                          : 'Workflow starts with `_workItem`, `workItemId`, details, budget, and target capability in run context.'}
                      </p>
                    </div>
                    <StatusPill status={selectedTarget.status} />
                  </div>

                  {!selectedTarget.childWorkflowInstanceId && (
                    <select
                      value={selectedTarget.childWorkflowTemplateId ?? selectedWorkflow}
                      disabled={Boolean(selectedTarget.childWorkflowTemplateId)}
                      onChange={event => setSelectedWorkflowByTarget(prev => ({ ...prev, [selectedTarget.id]: event.target.value }))}
                      style={inputStyle}
                    >
                      <option value="">
                          {workflowsQuery.isLoading ? 'Loading workflow templates...'
                          : workflowOptions.length === 0 ? `No workflow templates found for ${selectedTargetCapability}`
                          : usingFallbackWorkflows ? 'Select workflow template (showing all; none matched capability)'
                            : 'Select workflow template for this capability'}
                      </option>
                      {workflowOptions.map(workflow => (
                        <option key={workflow.id} value={workflow.id}>
                          {workflow.name}{workflow.capabilityId && workflow.capabilityId !== selectedTarget.targetCapabilityId ? ` · ${labelForCapability(workflow.capabilityId)}` : ''}
                        </option>
                      ))}
                    </select>
                  )}
                  {usingFallbackWorkflows && (
                    <p style={{ margin: '8px 0 0', color: '#92400e', fontSize: 12 }}>
                      No workflow template is currently linked to {selectedTargetCapability}. Showing all templates so you can still attach one.
                    </p>
                  )}
                  {!selectedTarget.childWorkflowInstanceId && !workflowsQuery.isLoading && !allWorkflowsQuery.isLoading && workflowOptions.length === 0 && (
                    <p style={{ margin: '8px 0 0', color: '#b91c1c', fontSize: 12 }}>
                      Create or publish a workflow for this capability in Workflow Manager, then refresh this page.
                    </p>
                  )}

                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
                    {canClaim && (
                      <button style={secondaryButtonStyle} disabled={claimMut.isPending} onClick={() => claimMut.mutate({ workItemId: selected.id, targetId: selectedTarget.id })}>
                        <CheckCircle2 size={13} /> {claimMut.isPending ? 'Claiming...' : 'Claim'}
                      </button>
                    )}
                    {canClaimAndStart && (
                      <button style={primaryButtonStyle} disabled={claimAndStartMut.isPending} onClick={() => claimAndStartMut.mutate({ workItemId: selected.id, targetId: selectedTarget.id, workflowId: effectiveWorkflow })}>
                        <Play size={13} /> {claimAndStartMut.isPending ? 'Starting...' : 'Claim and start'}
                      </button>
                    )}
                    {canStart && (
                      <button style={primaryButtonStyle} disabled={startMut.isPending} onClick={() => startMut.mutate({ workItemId: selected.id, targetId: selectedTarget.id, workflowId: selectedWorkflow || undefined })}>
                        <Play size={13} /> {startMut.isPending ? 'Starting...' : 'Start workflow'}
                      </button>
                    )}
                    {selectedTarget.childWorkflowInstanceId && (
                      <button style={primaryButtonStyle} onClick={() => navigate(`/runs/${selectedTarget.childWorkflowInstanceId}`)}>
                        <ExternalLink size={13} /> Open workflow run
                      </button>
                    )}
                    {canDetachTarget && (
                      <button
                        style={{ ...secondaryButtonStyle, borderColor: 'rgba(245,158,11,0.32)', color: '#92400e' }}
                        disabled={detachTargetMut.isPending}
                        onClick={() => {
                          if (window.confirm(`Detach ${selected.workCode ?? selected.title} from this child workflow run and return it to the available queue?`)) {
                            detachTargetMut.mutate({ workItemId: selected.id, targetId: selectedTarget.id })
                          }
                        }}
                      >
                        <Unlink size={13} /> {detachTargetMut.isPending ? 'Detaching...' : 'Detach run'}
                      </button>
                    )}
                  </div>
                  {(claimMut.error || startMut.error || claimAndStartMut.error || detachTargetMut.error) && (
                    <p style={{ margin: '8px 0 0', color: '#b91c1c', fontSize: 12 }}>
                      {((claimMut.error || startMut.error || claimAndStartMut.error || detachTargetMut.error) as Error).message}
                    </p>
                  )}
                  {archiveMut.error && (
                    <p style={{ margin: '8px 0 0', color: '#b91c1c', fontSize: 12 }}>
                      {(archiveMut.error as Error).message}
                    </p>
                  )}
                  {detachMut.error && (
                    <p style={{ margin: '8px 0 0', color: '#b91c1c', fontSize: 12 }}>
                      {(detachMut.error as Error).message}
                    </p>
                  )}
                </div>
              )}

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 14 }}>
                <InfoBlock title="Immutable WorkItem packet" value={selected.details} />
                <InfoBlock title="Budget and constraints" value={selected.budget} empty="No budget captured" />
              </div>

              {selected.targets.length > 1 && (
                <div style={{ marginTop: 14 }}>
                  <h3 style={panelTitleStyle}>Targets</h3>
                  <div style={{ display: 'grid', gap: 8 }}>
                    {selected.targets.map(target => (
                      <button key={target.id} style={targetRowStyle} onClick={() => setSelectedId(selected.id)}>
                        <span>{labelForCapability(target.targetCapabilityId)}</span>
                        <StatusPill status={target.status} />
                        <ArrowRight size={13} />
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </section>
      </div>
      {createOpen && (
        <CreateWorkItemDialog
          defaultCapabilityId={capabilityId || active?.capabilityId || ''}
          onClose={() => setCreateOpen(false)}
          onCreated={(item) => {
            setCreateOpen(false)
            const targetCapabilityId = item.targets[0]?.targetCapabilityId
            if (targetCapabilityId) setCapabilityId(targetCapabilityId)
            setSelectedId(item.id)
            workItemsQuery.refetch()
          }}
        />
      )}
    </div>
  )
}

function CreateWorkItemDialog({
  defaultCapabilityId,
  onClose,
  onCreated,
}: {
  defaultCapabilityId: string
  onClose: () => void
  onCreated: (item: WorkItemRow) => void
}) {
  const [targetCapabilityId, setTargetCapabilityId] = useState(defaultCapabilityId)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [workItemTypeKey, setWorkItemTypeKey] = useState('GENERAL')
  const [routingMode, setRoutingMode] = useState('MANUAL')
  const [scheduledAt, setScheduledAt] = useState('')
  const [urgency, setUrgency] = useState('NORMAL')
  const [requiredBy, setRequiredBy] = useState('')
  const [budgetNote, setBudgetNote] = useState('')

  const createMut = useMutation({
    mutationFn: () => {
      const trimmedTitle = title.trim()
      const trimmedDescription = description.trim()
      if (!targetCapabilityId) throw new Error('Select the child/target capability for this WorkItem')
      if (!trimmedTitle) throw new Error('Enter a WorkItem title')
      return api.post('/work-items', {
        title: trimmedTitle,
        description: trimmedDescription || undefined,
        workItemTypeKey,
        routingMode,
        scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : undefined,
        originType: 'CAPABILITY_LOCAL',
        parentCapabilityId: targetCapabilityId,
        input: {
          source: 'workitems-board',
          story: trimmedDescription || trimmedTitle,
        },
        details: {
          title: trimmedTitle,
          source: 'runtime-worklist',
          description: trimmedDescription || trimmedTitle,
          workItemTypeKey,
          workflowTypeKey: workItemTypeKey,
          routingMode,
        },
        budget: budgetNote.trim() ? { note: budgetNote.trim() } : undefined,
        urgency,
        requiredBy: requiredBy ? new Date(requiredBy).toISOString() : undefined,
        targets: [{ targetCapabilityId }],
      }).then(r => r.data as WorkItemRow)
    },
    onSuccess: onCreated,
  })

  return (
    <div style={modalBackdropStyle}>
      <div style={modalStyle}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <p style={{ margin: 0, fontSize: 10, color: '#7c3aed', fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.12em' }}>
              Capability WorkItem
            </p>
            <h2 style={{ margin: '4px 0 0', color: '#0f172a', fontSize: 22 }}>Create child/local WorkItem</h2>
            <p style={{ margin: '4px 0 0', color: '#475569', fontSize: 13 }}>
              This creates the business object first. Routing can attach or start the right workflow automatically from the WorkItem type.
            </p>
          </div>
          <button style={iconButtonStyle} onClick={onClose}>×</button>
        </div>

        <div style={{ display: 'grid', gap: 12, marginTop: 16 }}>
          <label style={labelStyle}>
            Child / target capability
            <CapabilityPicker
              value={targetCapabilityId}
              onChange={setTargetCapabilityId}
              placeholder="Select child capability"
              filterToMemberships={false}
              autoDefault={false}
            />
          </label>
          <label style={labelStyle}>
            WorkItem title
            <input value={title} onChange={event => setTitle(event.target.value)} placeholder="e.g. Implement Contains operator" style={inputStyle} />
          </label>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12 }}>
            <label style={labelStyle}>
              WorkItem type
              <select value={workItemTypeKey} onChange={event => setWorkItemTypeKey(event.target.value)} style={inputStyle}>
                <option value="GENERAL">General</option>
                <option value="BUG_FIX">Bug fix</option>
                <option value="FEATURE">Feature</option>
                <option value="INCIDENT">Incident</option>
                <option value="RESEARCH">Research</option>
                <option value="COMPLIANCE_REVIEW">Compliance review</option>
              </select>
            </label>
            <label style={labelStyle}>
              Routing
              <select value={routingMode} onChange={event => setRoutingMode(event.target.value)} style={inputStyle}>
                <option value="MANUAL">Manual</option>
                <option value="AUTO_ATTACH">Auto attach</option>
                <option value="AUTO_START">Auto start</option>
                <option value="SCHEDULED_START">Scheduled start</option>
              </select>
            </label>
            <label style={labelStyle}>
              Server start time
              <input type="datetime-local" value={scheduledAt} onChange={event => setScheduledAt(event.target.value)} style={inputStyle} />
            </label>
          </div>
          <label style={labelStyle}>
            Initial details / user story
            <textarea
              rows={5}
              value={description}
              onChange={event => setDescription(event.target.value)}
              placeholder="Capture the immutable request packet, acceptance criteria, constraints, or parent clarification."
              style={{ ...inputStyle, resize: 'vertical' }}
            />
          </label>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 12 }}>
            <label style={labelStyle}>
              Urgency
              <select value={urgency} onChange={event => setUrgency(event.target.value)} style={inputStyle}>
                <option value="LOW">Low</option>
                <option value="NORMAL">Normal</option>
                <option value="HIGH">High</option>
                <option value="CRITICAL">Critical</option>
              </select>
            </label>
            <label style={labelStyle}>
              Required by
              <input type="datetime-local" value={requiredBy} onChange={event => setRequiredBy(event.target.value)} style={inputStyle} />
            </label>
          </div>
          <label style={labelStyle}>
            Budget / constraints
            <textarea
              rows={3}
              value={budgetNote}
              onChange={event => setBudgetNote(event.target.value)}
              placeholder="Optional budget, token, schedule, or implementation constraints."
              style={{ ...inputStyle, resize: 'vertical' }}
            />
          </label>
        </div>

        {createMut.error && (
          <p style={{ margin: '12px 0 0', color: '#b91c1c', fontSize: 12 }}>{(createMut.error as Error).message}</p>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button style={secondaryButtonStyle} onClick={onClose}>Cancel</button>
          <button style={primaryButtonStyle} disabled={createMut.isPending} onClick={() => createMut.mutate()}>
            {createMut.isPending ? 'Creating...' : 'Create WorkItem'}
          </button>
        </div>
      </div>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div style={metricStyle}>
      <span style={labelMiniStyle}>{label}</span>
      <strong style={{ fontSize: 12, color: '#0f172a', overflowWrap: 'anywhere' }}>{value}</strong>
    </div>
  )
}

function InfoBlock({ title, value, empty = 'None' }: { title: string; value?: Record<string, unknown> | null; empty?: string }) {
  const hasValue = value && Object.keys(value).length > 0
  return (
    <div style={infoBlockStyle}>
      <h3 style={{ margin: '0 0 8px', fontSize: 14, color: '#0f172a' }}>{title}</h3>
      {hasValue ? <pre style={preStyle}>{JSON.stringify(value, null, 2)}</pre> : <p style={mutedStyle}>{empty}</p>}
    </div>
  )
}

function StatusPill({ status }: { status: string }) {
  const color = ['APPROVED', 'COMPLETED'].includes(status) ? '#16a34a'
    : ['SUBMITTED', 'IN_PROGRESS'].includes(status) ? '#0ea5e9'
    : ['REWORK_REQUESTED', 'FROM_PARENT'].includes(status) ? '#f59e0b'
    : ['CANCELLED', 'REJECTED'].includes(status) ? '#dc2626'
    : status === 'ARCHIVED' ? '#6b7280'
    : '#64748b'
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      whiteSpace: 'nowrap',
      padding: '3px 7px',
      borderRadius: 999,
      border: `1px solid ${color}30`,
      background: `${color}12`,
      color,
      fontSize: 10,
      fontWeight: 900,
      letterSpacing: '0.06em',
      textTransform: 'uppercase',
    }}>
      {formatEnum(status)}
    </span>
  )
}

function HubStat({ icon, label, value, tone }: { icon: ReactNode; label: string; value: string; tone: 'neutral' | 'primary' | 'warning' | 'danger' }) {
  const palette = tone === 'primary'
    ? { border: 'rgba(37,99,235,0.18)', bg: 'rgba(37,99,235,0.06)', fg: '#2563eb' }
    : tone === 'warning'
      ? { border: 'rgba(245,158,11,0.24)', bg: 'rgba(255,251,235,0.88)', fg: '#b45309' }
      : tone === 'danger'
        ? { border: 'rgba(220,38,38,0.22)', bg: 'rgba(254,242,242,0.85)', fg: '#b91c1c' }
        : { border: 'var(--color-outline-variant)', bg: '#fff', fg: '#475569' }
  return (
    <div style={{ ...hubStatCardStyle, borderColor: palette.border, background: palette.bg }}>
      <span style={{ ...hubStatIconStyle, color: palette.fg }}>{icon}</span>
      <div>
        <p style={{ margin: 0, color: '#64748b', fontSize: 10, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{label}</p>
        <strong style={{ display: 'block', marginTop: 2, color: '#0f172a', fontSize: 21, lineHeight: 1 }}>{value}</strong>
      </div>
    </div>
  )
}

function WorkItemFlow({ stages }: { stages: WorkItemFlowStage[] }) {
  return (
    <section style={flowStripStyle}>
      {stages.map((stage, index) => (
        <div key={stage.label} style={flowStageStyle}>
          <div style={flowNodeStyle(stage.state)}>{stage.icon}</div>
          <div style={{ minWidth: 0 }}>
            <p style={{ margin: 0, color: '#0f172a', fontSize: 12, fontWeight: 900 }}>{stage.label}</p>
            <p style={{ margin: '2px 0 0', color: '#64748b', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{stage.meta}</p>
          </div>
          {index < stages.length - 1 && <ArrowRight size={14} style={{ color: '#cbd5e1', flex: '0 0 auto' }} />}
        </div>
      ))}
    </section>
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

type WorkItemsResponse = { items: WorkItemRow[]; nextCursor?: string | null }

type WorkItemTarget = {
  id: string
  targetCapabilityId: string
  childWorkflowTemplateId?: string | null
  childWorkflowInstanceId?: string | null
  roleKey?: string | null
  status: string
  claimedById?: string | null
}

type WorkItemRow = {
  id: string
  workCode?: string | null
  title: string
  description?: string | null
  originType: string
  workItemTypeKey?: string | null
  routingMode?: string | null
  routingState?: string | null
  scheduledAt?: string | null
  sourceEventTypeKey?: string | null
  status: string
  sourceWorkflowInstanceId?: string | null
  sourceWorkflowNodeId?: string | null
  details?: Record<string, unknown> | null
  budget?: Record<string, unknown> | null
  urgency?: string | null
  requiredBy?: string | null
  dueAt?: string | null
  detailsLocked: boolean
  targets: WorkItemTarget[]
}

type WorkflowOption = {
  id: string
  name: string
  capabilityId?: string | null
}

type WorkItemFlowStage = {
  label: string
  meta: string
  icon: ReactNode
  state: 'done' | 'current' | 'waiting' | 'blocked'
}

type NextAction = {
  title: string
  detail: string
  icon: ReactNode
  tone: 'neutral' | 'primary' | 'warning' | 'danger'
  color: string
}

function buildHubStats(items: WorkItemRow[]) {
  return items.reduce((acc, item) => {
    const target = item.targets[0]
    acc.total += 1
    if (
      !target?.childWorkflowInstanceId &&
      ['UNROUTED', 'ROUTE_FAILED'].includes(item.routingState ?? 'UNROUTED')
    ) acc.needsRoute += 1
    if (item.routingMode === 'SCHEDULED_START' || item.scheduledAt) acc.scheduled += 1
    if (target?.childWorkflowInstanceId && !['COMPLETED', 'APPROVED', 'ARCHIVED'].includes(item.status)) acc.running += 1
    if (item.routingState === 'ROUTE_FAILED' || item.status === 'REWORK_REQUESTED' || target?.status === 'REWORK_REQUESTED') acc.blocked += 1
    return acc
  }, { total: 0, needsRoute: 0, running: 0, scheduled: 0, blocked: 0 })
}

function describeNextAction(
  item: WorkItemRow,
  target: WorkItemTarget | null,
  effectiveWorkflow: string,
  workflowOptionCount: number,
  targetCapabilityLabel: string,
): NextAction {
  if (item.status === 'ARCHIVED') {
    return {
      title: 'Archived',
      detail: 'This WorkItem is hidden from normal queues. Restore or duplicate it before continuing delivery.',
      icon: <Archive size={16} />,
      tone: 'neutral',
      color: '#64748b',
    }
  }
  if (['APPROVED', 'COMPLETED'].includes(item.status)) {
    return {
      title: 'Review evidence',
      detail: 'Delivery is complete. Open the run or evidence pack when you need audit details.',
      icon: <CheckCircle2 size={16} />,
      tone: 'primary',
      color: '#2563eb',
    }
  }
  if (item.scheduledAt && new Date(item.scheduledAt).getTime() > Date.now()) {
    return {
      title: 'Waiting for server schedule',
      detail: `Server time will activate this WorkItem at ${new Date(item.scheduledAt).toLocaleString()}.`,
      icon: <CalendarClock size={16} />,
      tone: 'neutral',
      color: '#64748b',
    }
  }
  if (!target) {
    return {
      title: 'Add a target capability',
      detail: 'This WorkItem needs a capability target before it can be routed into a workflow.',
      icon: <Network size={16} />,
      tone: 'warning',
      color: '#b45309',
    }
  }
  if (item.routingState === 'ROUTE_FAILED') {
    return {
      title: 'Fix routing policy',
      detail: 'Routing failed. Check workflow type compatibility, default workflow flags, and active routing policies.',
      icon: <AlertCircle size={16} />,
      tone: 'danger',
      color: '#b91c1c',
    }
  }
  if (target.childWorkflowInstanceId) {
    return {
      title: 'Open current run',
      detail: 'A workflow run is attached. Continue in the run view or inspect evidence from this WorkItem.',
      icon: <GitBranch size={16} />,
      tone: 'primary',
      color: '#2563eb',
    }
  }
  if (!target.childWorkflowTemplateId && ['UNROUTED', undefined, null].includes(item.routingState ?? undefined)) {
    return {
      title: 'Route to a workflow',
      detail: `${formatEnum(item.workItemTypeKey ?? 'GENERAL')} work in ${targetCapabilityLabel} needs a compatible workflow template.`,
      icon: <Route size={16} />,
      tone: 'warning',
      color: '#b45309',
    }
  }
  if (target.status === 'QUEUED' && !target.claimedById) {
    return {
      title: 'Claim or auto-start',
      detail: 'The WorkItem is in the capability queue. Claim it, or use routing policy to attach/start automatically.',
      icon: <CheckCircle2 size={16} />,
      tone: 'warning',
      color: '#b45309',
    }
  }
  if (target.status === 'CLAIMED' && !effectiveWorkflow) {
    return {
      title: 'Select workflow template',
      detail: workflowOptionCount > 0
        ? 'Choose a workflow template, then start the attached run.'
        : 'No workflow templates are available for this capability yet.',
      icon: <Workflow size={16} />,
      tone: workflowOptionCount > 0 ? 'warning' : 'danger',
      color: workflowOptionCount > 0 ? '#b45309' : '#b91c1c',
    }
  }
  if (target.status === 'CLAIMED' && effectiveWorkflow) {
    return {
      title: 'Start workflow',
      detail: 'The request packet and workflow template are ready. Start the run to move execution forward.',
      icon: <Play size={16} />,
      tone: 'primary',
      color: '#2563eb',
    }
  }
  return {
    title: 'Review WorkItem packet',
    detail: 'Confirm the request, target, routing state, and budget before moving the item forward.',
    icon: <ListChecks size={16} />,
    tone: 'neutral',
    color: '#64748b',
  }
}

function buildWorkItemFlow(item: WorkItemRow, target: WorkItemTarget | null, targetCapabilityLabel: string): WorkItemFlowStage[] {
  const sourceLabel = item.sourceEventTypeKey
    ? `Event: ${formatEnum(item.sourceEventTypeKey)}`
    : item.scheduledAt
      ? 'Server schedule'
      : item.originType === 'PARENT_DELEGATED'
        ? 'Parent workflow'
        : 'Manual intake'
  const routingState = target?.childWorkflowInstanceId || target?.childWorkflowTemplateId
    ? 'done'
    : item.routingState === 'ROUTE_FAILED'
    ? 'blocked'
    : ['ROUTED', 'ATTACHED', 'STARTED'].includes(item.routingState ?? '')
      ? 'done'
      : 'current'
  const workflowState = target?.childWorkflowInstanceId
    ? 'current'
    : target?.childWorkflowTemplateId
      ? 'done'
      : 'waiting'
  const evidenceState = ['APPROVED', 'COMPLETED'].includes(item.status)
    ? 'done'
    : target?.childWorkflowInstanceId
      ? 'current'
      : 'waiting'
  return [
    {
      label: 'Source',
      meta: sourceLabel,
      icon: <Plus size={14} />,
      state: 'done',
    },
    {
      label: 'WorkItem',
      meta: `${item.workCode ?? item.id.slice(0, 8)} · ${formatEnum(item.workItemTypeKey ?? 'GENERAL')}`,
      icon: <Network size={14} />,
      state: 'done',
    },
    {
      label: 'Route',
      meta: displayRoutingState(item, target),
      icon: <Route size={14} />,
      state: routingState,
    },
    {
      label: 'Workflow',
      meta: target?.childWorkflowInstanceId ? 'Run attached' : target?.childWorkflowTemplateId ? 'Template attached' : targetCapabilityLabel,
      icon: <Workflow size={14} />,
      state: workflowState,
    },
    {
      label: 'Evidence',
      meta: evidenceState === 'done' ? 'Ready' : 'Receipts pending',
      icon: <CheckCircle2 size={14} />,
      state: evidenceState,
    },
  ]
}

function displayRoutingState(item: WorkItemRow, target: WorkItemTarget | null) {
  if (target?.childWorkflowInstanceId) return 'Run attached'
  if (target?.childWorkflowTemplateId) return 'Template attached'
  return formatEnum(item.routingState ?? 'UNROUTED')
}

function formatEnum(value?: string | null) {
  if (!value) return 'Not set'
  return value
    .toLowerCase()
    .split('_')
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

const pageIconStyle: CSSProperties = {
  width: 38,
  height: 38,
  borderRadius: 10,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'rgba(139,92,246,0.10)',
  border: '1px solid rgba(139,92,246,0.24)',
  color: '#7c3aed',
}

const pageTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: 24,
  fontWeight: 900,
  color: '#0f172a',
  letterSpacing: '-0.02em',
}

const eyebrowStyle: CSSProperties = {
  margin: '0 0 2px',
  color: '#7c3aed',
  fontSize: 10,
  fontWeight: 950,
  textTransform: 'uppercase',
  letterSpacing: '0.14em',
}

const pageSubStyle: CSSProperties = {
  margin: '2px 0 0',
  fontSize: 13,
  color: '#475569',
}

const hubStatsStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(5, minmax(140px, 1fr))',
  gap: 10,
  marginBottom: 14,
}

const hubStatCardStyle: CSSProperties = {
  minHeight: 72,
  padding: 12,
  borderRadius: 14,
  border: '1px solid var(--color-outline-variant)',
  display: 'flex',
  alignItems: 'center',
  gap: 10,
}

const hubStatIconStyle: CSSProperties = {
  width: 34,
  height: 34,
  borderRadius: 10,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'rgba(255,255,255,0.72)',
  border: '1px solid rgba(15,23,42,0.06)',
  flex: '0 0 auto',
}

const filterBarStyle: CSSProperties = {
  display: 'flex',
  gap: 12,
  flexWrap: 'wrap',
  alignItems: 'end',
  padding: 14,
  borderRadius: 14,
  background: '#fff',
  border: '1px solid var(--color-outline-variant)',
  marginBottom: 16,
}

const labelStyle: CSSProperties = {
  display: 'grid',
  gap: 5,
  color: '#475569',
  fontSize: 10,
  fontWeight: 900,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
}

const inputStyle: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '9px 11px',
  borderRadius: 9,
  border: '1px solid var(--color-outline-variant)',
  background: '#fff',
  color: '#0f172a',
  fontSize: 13,
  fontWeight: 650,
  outline: 'none',
}

const listPanelStyle: CSSProperties = {
  padding: 14,
  borderRadius: 14,
  background: '#f8fafc',
  border: '1px solid var(--color-outline-variant)',
  minHeight: 520,
}

const detailPanelStyle: CSSProperties = {
  padding: 16,
  borderRadius: 14,
  background: '#fff',
  border: '1px solid var(--color-outline-variant)',
  minHeight: 520,
}

const panelTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: 15,
  color: '#0f172a',
  fontWeight: 900,
}

const countChipStyle: CSSProperties = {
  padding: '2px 8px',
  borderRadius: 999,
  color: '#7c3aed',
  background: 'rgba(139,92,246,0.10)',
  fontSize: 11,
  fontWeight: 900,
}

const itemCardStyle: CSSProperties = {
  width: '100%',
  padding: 12,
  borderRadius: 12,
  border: '1px solid var(--color-outline-variant)',
  textAlign: 'left',
  cursor: 'pointer',
}

const emptyStyle: CSSProperties = {
  minHeight: 260,
  display: 'grid',
  alignContent: 'center',
  justifyItems: 'center',
  gap: 6,
  color: '#64748b',
  textAlign: 'center',
}

const emptyDetailStyle: CSSProperties = {
  minHeight: 480,
  display: 'grid',
  alignContent: 'center',
  justifyItems: 'center',
  gap: 8,
  color: '#64748b',
  textAlign: 'center',
}

const workCodeStyle: CSSProperties = {
  fontFamily: 'monospace',
  color: '#5b21b6',
  background: 'rgba(139,92,246,0.10)',
  border: '1px solid rgba(139,92,246,0.22)',
  borderRadius: 8,
  padding: '4px 8px',
  fontSize: 12,
  fontWeight: 900,
}

const metricGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
  gap: 8,
  marginBottom: 14,
}

const flowStripStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(5, minmax(0, 1fr))',
  gap: 8,
  padding: 10,
  borderRadius: 14,
  border: '1px solid rgba(15,23,42,0.08)',
  background: '#f8fafc',
  marginBottom: 12,
}

const flowStageStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  minWidth: 0,
}

const flowNodeStyle = (state: WorkItemFlowStage['state']): CSSProperties => {
  const palette = state === 'done'
    ? { bg: 'rgba(22,163,74,0.10)', border: 'rgba(22,163,74,0.24)', fg: '#16a34a' }
    : state === 'current'
      ? { bg: 'rgba(37,99,235,0.10)', border: 'rgba(37,99,235,0.24)', fg: '#2563eb' }
      : state === 'blocked'
        ? { bg: 'rgba(220,38,38,0.10)', border: 'rgba(220,38,38,0.24)', fg: '#b91c1c' }
        : { bg: '#fff', border: 'var(--color-outline-variant)', fg: '#94a3b8' }
  return {
    width: 30,
    height: 30,
    borderRadius: 10,
    border: `1px solid ${palette.border}`,
    background: palette.bg,
    color: palette.fg,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flex: '0 0 auto',
  }
}

const nextActionStyle = (tone: NextAction['tone']): CSSProperties => {
  const border = tone === 'primary'
    ? 'rgba(37,99,235,0.22)'
    : tone === 'warning'
      ? 'rgba(245,158,11,0.26)'
      : tone === 'danger'
        ? 'rgba(220,38,38,0.24)'
        : 'var(--color-outline-variant)'
  const bg = tone === 'primary'
    ? 'rgba(37,99,235,0.05)'
    : tone === 'warning'
      ? 'rgba(255,251,235,0.80)'
      : tone === 'danger'
        ? 'rgba(254,242,242,0.78)'
        : '#fff'
  return {
    padding: 14,
    borderRadius: 14,
    border: `1px solid ${border}`,
    background: bg,
    marginBottom: 12,
  }
}

const metricStyle: CSSProperties = {
  padding: 10,
  borderRadius: 10,
  border: '1px solid var(--color-outline-variant)',
  background: '#f8fafc',
  display: 'grid',
  gap: 4,
}

const labelMiniStyle: CSSProperties = {
  color: '#64748b',
  fontSize: 9,
  fontWeight: 900,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
}

const actionBoxStyle: CSSProperties = {
  padding: 14,
  borderRadius: 12,
  border: '1px solid rgba(139,92,246,0.24)',
  background: 'rgba(139,92,246,0.05)',
}

const primaryButtonStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 7,
  padding: '9px 13px',
  borderRadius: 9,
  border: 'none',
  background: '#7c3aed',
  color: '#fff',
  cursor: 'pointer',
  fontSize: 12,
  fontWeight: 900,
}

const secondaryButtonStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 7,
  padding: '9px 13px',
  borderRadius: 9,
  border: '1px solid var(--color-outline-variant)',
  background: '#fff',
  color: '#0f172a',
  cursor: 'pointer',
  fontSize: 12,
  fontWeight: 800,
}

const infoBlockStyle: CSSProperties = {
  padding: 12,
  borderRadius: 12,
  border: '1px solid var(--color-outline-variant)',
  background: '#fff',
}

const preStyle: CSSProperties = {
  margin: 0,
  maxHeight: 280,
  overflow: 'auto',
  padding: 12,
  borderRadius: 10,
  background: '#0f172a',
  color: '#cbd5e1',
  fontSize: 11,
  lineHeight: 1.45,
}

const mutedStyle: CSSProperties = {
  margin: 0,
  color: '#64748b',
  fontSize: 12,
  lineHeight: 1.5,
}

const targetRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  padding: 10,
  borderRadius: 10,
  border: '1px solid var(--color-outline-variant)',
  background: '#fff',
  color: '#0f172a',
  cursor: 'pointer',
  fontSize: 12,
  fontWeight: 800,
}

const modalBackdropStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 80,
  display: 'grid',
  placeItems: 'center',
  padding: 20,
  background: 'rgba(15,23,42,0.44)',
}

const modalStyle: CSSProperties = {
  width: 'min(760px, 100%)',
  maxHeight: 'calc(100vh - 48px)',
  overflow: 'auto',
  borderRadius: 18,
  border: '1px solid var(--color-outline-variant)',
  background: '#fff',
  boxShadow: '0 24px 80px rgba(15,23,42,0.28)',
  padding: 20,
}

const iconButtonStyle: CSSProperties = {
  width: 36,
  height: 36,
  borderRadius: 10,
  border: '1px solid var(--color-outline-variant)',
  background: '#fff',
  color: '#475569',
  cursor: 'pointer',
  fontSize: 24,
  lineHeight: 1,
}
