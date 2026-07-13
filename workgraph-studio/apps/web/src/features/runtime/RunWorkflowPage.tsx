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
import { RuntimeInputsForm, type RuntimeInputValues } from '../workflow/RuntimeInputsForm'

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
  const [modelAlias, setModelAlias] = useState('')
  const [sourceMode, setSourceMode] = useState<'github' | 'local_dir'>('github')
  const [sourceRef, setSourceRef] = useState('')
  const [localPath, setLocalPath] = useState('')
  const [cloneDir, setCloneDir] = useState('')
  const [pushEachPhase, setPushEachPhase] = useState(false)
  const [runtimeValues, setRuntimeValues] = useState<RuntimeInputValues>({ vars: {}, globals: {}, params: {} })
  const [runtimeValuesReady, setRuntimeValuesReady] = useState(true)
  const isLocalSource = sourceMode === 'local_dir'

  // Catalog aliases (Copilot/OpenAI/Anthropic/…) to offer as a per-run model override.
  const connectionsQuery = useQuery<Array<{ alias?: string; label?: string; provider?: string; model?: string }>>({
    queryKey: ['llm-connections-for-launch'],
    queryFn: () => api.get('/llm-routing/connections').then(r => {
      const d = r.data as unknown
      return (Array.isArray(d) ? d : ((d as { items?: unknown[]; content?: unknown[] })?.items ?? (d as { content?: unknown[] })?.content ?? [])) as Array<{ alias?: string }>
    }),
    staleTime: 60_000,
  })
  const modelOptions = (connectionsQuery.data ?? []).filter(c => typeof c.alias === 'string' && c.alias)

  // Branch list for the "Branch to clone" picker. The server lists branches from the
  // connected laptop runtime (its own github token — no connector needed), falling
  // back to a configured GIT connector. We pass the workflow's capability so the
  // server can resolve the linked repo (the same repo the run will clone). Falls back
  // silently to free-text when neither path applies (endpoint returns { branches: [] }).
  const branchesQuery = useQuery<{
    branches?: string[]
    source?: string
    repo?: string
    connector?: { repo?: string }
    reason?: string
    runtimeReason?: string
  }>({
    queryKey: ['launch-source-branches', workflow.capabilityId ?? ''],
    queryFn: () => api.get('/connectors/git/branches', {
      params: workflow.capabilityId ? { capabilityId: workflow.capabilityId } : {},
    }).then(r => r.data),
    staleTime: 60_000,
  })
  const branchOptions = branchesQuery.data?.branches ?? []
  const branchSource = branchesQuery.data?.source
  const branchRepoLabel = (branchesQuery.data?.repo ?? branchesQuery.data?.connector?.repo)
    ?.replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '')

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
        vars: runtimeValues.vars,
        globals: runtimeValues.globals,
        params: runtimeValues.params,
        ...(modelAlias ? { modelAlias } : {}),
        // Local-directory run: point the runtime at an existing checkout (no clone,
        // no branch, no clone-dir). Otherwise the github defaults ride through.
        ...(isLocalSource
          ? (localPath.trim() ? { sourceType: 'local_dir', sourceUri: localPath.trim() } : {})
          : {
              ...(sourceRef.trim() ? { sourceRef: sourceRef.trim() } : {}),
              ...(cloneDir.trim() ? { cloneDir: cloneDir.trim() } : {}),
            }),
        ...(pushEachPhase ? { pushEachPhase: true } : {}),
      }).then(r => r.data as { childWorkflowInstanceId?: string })
    },
    onSuccess: result => {
      if (result.childWorkflowInstanceId) onStarted(result.childWorkflowInstanceId)
    },
  })

  const canStartWorkItem = Boolean(selectedWorkItemTarget) && runtimeValuesReady
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

          <RuntimeInputsForm
            workflowId={workflow.id}
            initialVars={selected?.item.input ?? {}}
            values={runtimeValues}
            onChange={setRuntimeValues}
            onReadyChange={setRuntimeValuesReady}
          />

          <div style={{ marginTop: 16 }}>
            <h3 style={{ ...sectionTitleStyle, margin: '0 0 8px' }}>Model (optional)</h3>
            <select value={modelAlias} onChange={event => setModelAlias(event.target.value)} style={inputStyle}>
              <option value="">Workflow default</option>
              {modelOptions.map(c => (
                <option key={c.alias} value={c.alias}>
                  {c.label ?? c.alias}{c.provider ? ` — ${c.provider}${c.model ? `/${c.model}` : ''}` : ''}
                </option>
              ))}
            </select>
            <p style={{ ...mutedStyle, marginTop: 6 }}>
              Overrides the model for every agent stage in this run only. Leave as “Workflow default” to use the designed routing (Copilot/OpenAI/Anthropic per the LLM routing canvas).
            </p>
          </div>

          <div style={{ marginTop: 16 }}>
            <h3 style={{ ...sectionTitleStyle, margin: '0 0 8px' }}>Source</h3>
            <div style={{ display: 'flex', gap: 8 }}>
              {([
                { key: 'github', label: 'GitHub repo' },
                { key: 'local_dir', label: 'Local directory' },
              ] as const).map(opt => {
                const active = sourceMode === opt.key
                return (
                  <button
                    key={opt.key}
                    type="button"
                    onClick={() => setSourceMode(opt.key)}
                    style={{
                      flex: 1,
                      padding: '8px 10px',
                      borderRadius: 10,
                      border: `1px solid ${active ? 'rgba(124,58,237,0.55)' : '#e2e8f0'}`,
                      background: active ? 'rgba(124,58,237,0.10)' : '#fff',
                      color: active ? '#6d28d9' : '#475569',
                      fontWeight: active ? 900 : 600,
                      fontSize: 13,
                      cursor: 'pointer',
                    }}
                  >
                    {opt.label}
                  </button>
                )
              })}
            </div>
            <p style={{ ...mutedStyle, marginTop: 6 }}>
              {isLocalSource
                ? 'Run against an existing checkout already on the runtime — no clone. The runtime only allows paths inside its configured MCP_ALLOWED_LOCAL_SOURCE_ROOTS.'
                : 'Clone the capability’s linked repo (or the work-item repo) and work on a branch.'}
            </p>
          </div>

          {isLocalSource ? (
            <div style={{ marginTop: 16 }}>
              <h3 style={{ ...sectionTitleStyle, margin: '0 0 8px' }}>Local directory path</h3>
              <input
                type="text"
                value={localPath}
                onChange={event => setLocalPath(event.target.value)}
                placeholder="e.g. /Users/me/code/my-project"
                style={inputStyle}
              />
              <p style={{ ...mutedStyle, marginTop: 6 }}>
                Absolute path on the runtime host. Must resolve inside an allowed root
                (<code>MCP_ALLOWED_LOCAL_SOURCE_ROOTS</code>), else the run is rejected. The run
                operates on this directory in place; push-after-phase needs it to be a git checkout with a remote.
              </p>
            </div>
          ) : (
            <>
              <div style={{ marginTop: 16 }}>
                <h3 style={{ ...sectionTitleStyle, margin: '0 0 8px' }}>Branch to clone (optional)</h3>
                <input
                  type="text"
                  list="launch-branch-options"
                  value={sourceRef}
                  onChange={event => setSourceRef(event.target.value)}
                  placeholder="e.g. main, develop, or a feature branch"
                  style={inputStyle}
                />
                {branchOptions.length > 0 && (
                  <datalist id="launch-branch-options">
                    {branchOptions.map(b => <option key={b} value={b} />)}
                  </datalist>
                )}
                <p style={{ ...mutedStyle, marginTop: 6 }}>
                  {branchOptions.length > 0
                    ? `${branchOptions.length} branch${branchOptions.length === 1 ? '' : 'es'} from ${branchRepoLabel ?? 'the linked repo'}${branchSource === 'runtime' ? ' (via the connected runtime)' : ''} — pick one or type any ref. `
                    : 'Type a branch/ref (branches auto-list when a runtime is connected or a GitHub connector is configured). '}
                  The run clones this and bases its <code>wi/&lt;code&gt;</code> work branch on it. Blank = the workflow’s configured branch (or repo default).
                </p>
              </div>

              <div style={{ marginTop: 16 }}>
                <h3 style={{ ...sectionTitleStyle, margin: '0 0 8px' }}>Clone into folder (optional)</h3>
                <input
                  type="text"
                  value={cloneDir}
                  onChange={event => setCloneDir(event.target.value)}
                  placeholder="e.g. my-checkout"
                  style={inputStyle}
                />
                <p style={{ ...mutedStyle, marginTop: 6 }}>
                  Folder name the repo is cloned into on the runtime. Resolved <strong>inside</strong> the runtime’s managed workspaces root (not an arbitrary path). Blank = the default per-work-item folder.
                </p>
              </div>
            </>
          )}

          <div style={{ marginTop: 16 }}>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={pushEachPhase}
                onChange={event => setPushEachPhase(event.target.checked)}
                style={{ marginTop: 2 }}
              />
              <span>
                <span style={{ ...sectionTitleStyle, display: 'block' }}>Push code after each phase</span>
                <span style={{ ...mutedStyle, display: 'block', marginTop: 4 }}>
                  Pushes the working-tree code to <code>wi/&lt;code&gt;</code> through the laptop runtime as each phase’s artifacts are approved. Requires the runtime bridge to be connected; document commits happen cloud-side regardless.
                </span>
              </span>
            </label>
          </div>

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
  input?: Record<string, unknown>
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
