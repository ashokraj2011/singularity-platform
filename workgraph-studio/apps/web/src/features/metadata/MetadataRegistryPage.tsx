import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  BellRing,
  Braces,
  Bug,
  CalendarClock,
  Database,
  GitBranch,
  Layers3,
  ListFilter,
  Network,
  Plus,
  RefreshCcw,
  Route,
  Save,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Workflow,
  X,
} from 'lucide-react'
import { api } from '../../lib/api'
import { CapabilityPicker } from '../../components/lookup/EntityPickers'

type MetadataKind = 'WORK_ITEM_TYPE' | 'WORKFLOW_TYPE' | 'NODE_TYPE' | 'EVENT_TYPE' | 'TRIGGER_PROFILE'
type MetadataStatus = 'DRAFT' | 'ACTIVE' | 'DEPRECATED' | 'ARCHIVED'
type MetadataScope = 'GLOBAL' | 'CAPABILITY' | 'WORKFLOW' | 'NODE'
type RoutingMode = 'MANUAL' | 'AUTO_ATTACH' | 'AUTO_START' | 'SCHEDULED_START'
type TriggerType = 'EVENT' | 'SCHEDULE' | 'WEBHOOK'

type JsonRecord = Record<string, unknown>

type MetadataDefinition = {
  id: string
  kind: MetadataKind
  key: string
  version: number
  status: MetadataStatus
  scopeType: MetadataScope
  scopeId: string
  label: string
  description?: string | null
  icon?: string | null
  color?: string | null
  category?: string | null
  schema?: JsonRecord
  defaults?: JsonRecord
  policy?: JsonRecord
  ui?: JsonRecord
  compatibility?: JsonRecord
  createdAt?: string
  updatedAt?: string
}

type WorkflowOption = {
  id: string
  name: string
  workflowTypeKey?: string | null
  capabilityId?: string | null
}

type RoutingPolicy = {
  id: string
  capabilityId: string
  workItemTypeKey: string
  workflowTypeKey: string
  workflowId?: string | null
  routingMode: RoutingMode
  priority: number
  selector?: JsonRecord
  isActive: boolean
  workflow?: WorkflowOption | null
  createdAt?: string
  updatedAt?: string
}

type WorkItemTrigger = {
  id: string
  triggerType: TriggerType
  eventTypeKey?: string | null
  capabilityId?: string | null
  workItemTypeKey: string
  routingMode: RoutingMode
  scheduleConfig?: JsonRecord
  payloadMapping?: JsonRecord
  dedupeKey?: string | null
  isActive: boolean
  lastFiredAt?: string | null
  createdAt?: string
  updatedAt?: string
}

type DefinitionDraft = {
  id?: string
  kind: MetadataKind
  key: string
  version: number
  status: MetadataStatus
  scopeType: MetadataScope
  scopeId: string
  label: string
  description: string
  icon: string
  color: string
  category: string
  schema: string
  defaults: string
  policy: string
  ui: string
  compatibility: string
}

type RoutingDraft = {
  id?: string
  capabilityId: string
  workItemTypeKey: string
  workflowTypeKey: string
  workflowId: string
  routingMode: RoutingMode
  priority: number
  selector: string
  isActive: boolean
}

type TriggerDraft = {
  id?: string
  triggerType: TriggerType
  eventTypeKey: string
  capabilityId: string
  workItemTypeKey: string
  routingMode: RoutingMode
  scheduleConfig: string
  payloadMapping: string
  dedupeKey: string
  isActive: boolean
}

const KINDS: Array<{ key: MetadataKind; label: string; icon: ReactNode; description: string }> = [
  { key: 'WORK_ITEM_TYPE', label: 'WorkItem types', icon: <Network size={16} />, description: 'Bug fix, feature, incident, research, compliance, and local business types.' },
  { key: 'WORKFLOW_TYPE', label: 'Workflow types', icon: <Workflow size={16} />, description: 'Workflow families, eligibility, default routing, and governance posture.' },
  { key: 'NODE_TYPE', label: 'Node types', icon: <Layers3 size={16} />, description: 'Node palette identity, config schema, runtime base, and validation rules.' },
  { key: 'EVENT_TYPE', label: 'Event types', icon: <BellRing size={16} />, description: 'Payload schemas and mappings that can create WorkItems.' },
  { key: 'TRIGGER_PROFILE', label: 'Trigger profiles', icon: <CalendarClock size={16} />, description: 'Reusable schedule, webhook, and server-time trigger profiles.' },
]

const STATUSES: MetadataStatus[] = ['ACTIVE', 'DRAFT', 'DEPRECATED', 'ARCHIVED']
const SCOPES: MetadataScope[] = ['GLOBAL', 'CAPABILITY', 'WORKFLOW', 'NODE']
const ROUTING_MODES: RoutingMode[] = ['MANUAL', 'AUTO_ATTACH', 'AUTO_START', 'SCHEDULED_START']
const TRIGGER_TYPES: TriggerType[] = ['EVENT', 'SCHEDULE', 'WEBHOOK']

const ICONS = ['Network', 'Workflow', 'Layers3', 'Bug', 'Sparkles', 'ShieldCheck', 'BellRing', 'CalendarClock', 'Route', 'Settings2']
const COLORS = ['#2563eb', '#368727', '#7c3aed', '#ef4444', '#f97316', '#0ea5e9', '#64748b', '#14b8a6', '#eab308', '#db2777']

function emptyDefinitionDraft(kind: MetadataKind): DefinitionDraft {
  return {
    kind,
    key: '',
    version: 1,
    status: 'ACTIVE',
    scopeType: 'GLOBAL',
    scopeId: '*',
    label: '',
    description: '',
    icon: ICONS[0],
    color: COLORS[0],
    category: '',
    schema: '{}',
    defaults: '{}',
    policy: '{}',
    ui: '{}',
    compatibility: '{}',
  }
}

function definitionToDraft(def: MetadataDefinition): DefinitionDraft {
  return {
    id: def.id,
    kind: def.kind,
    key: def.key,
    version: def.version,
    status: def.status,
    scopeType: def.scopeType,
    scopeId: def.scopeId,
    label: def.label,
    description: def.description ?? '',
    icon: def.icon ?? ICONS[0],
    color: def.color ?? COLORS[0],
    category: def.category ?? '',
    schema: pretty(def.schema),
    defaults: pretty(def.defaults),
    policy: pretty(def.policy),
    ui: pretty(def.ui),
    compatibility: pretty(def.compatibility),
  }
}

function emptyRoutingDraft(): RoutingDraft {
  return {
    capabilityId: '',
    workItemTypeKey: 'GENERAL',
    workflowTypeKey: 'GENERAL',
    workflowId: '',
    routingMode: 'MANUAL',
    priority: 100,
    selector: '{}',
    isActive: true,
  }
}

function routingToDraft(row: RoutingPolicy): RoutingDraft {
  return {
    id: row.id,
    capabilityId: row.capabilityId,
    workItemTypeKey: row.workItemTypeKey,
    workflowTypeKey: row.workflowTypeKey,
    workflowId: row.workflowId ?? '',
    routingMode: row.routingMode,
    priority: row.priority,
    selector: pretty(row.selector),
    isActive: row.isActive,
  }
}

function emptyTriggerDraft(): TriggerDraft {
  return {
    triggerType: 'EVENT',
    eventTypeKey: '',
    capabilityId: '',
    workItemTypeKey: 'GENERAL',
    routingMode: 'MANUAL',
    scheduleConfig: '{}',
    payloadMapping: '{}',
    dedupeKey: '',
    isActive: true,
  }
}

function triggerToDraft(row: WorkItemTrigger): TriggerDraft {
  return {
    id: row.id,
    triggerType: row.triggerType,
    eventTypeKey: row.eventTypeKey ?? '',
    capabilityId: row.capabilityId ?? '',
    workItemTypeKey: row.workItemTypeKey,
    routingMode: row.routingMode,
    scheduleConfig: pretty(row.scheduleConfig),
    payloadMapping: pretty(row.payloadMapping),
    dedupeKey: row.dedupeKey ?? '',
    isActive: row.isActive,
  }
}

export function MetadataRegistryPage() {
  const qc = useQueryClient()
  const [area, setArea] = useState<'definitions' | 'routing' | 'triggers'>('definitions')
  const [kind, setKind] = useState<MetadataKind>('WORK_ITEM_TYPE')
  const [status, setStatus] = useState<'ALL' | MetadataStatus>('ALL')
  const [query, setQuery] = useState('')
  const [definitionDraft, setDefinitionDraft] = useState<DefinitionDraft>(() => emptyDefinitionDraft('WORK_ITEM_TYPE'))
  const [routingDraft, setRoutingDraft] = useState<RoutingDraft>(() => emptyRoutingDraft())
  const [triggerDraft, setTriggerDraft] = useState<TriggerDraft>(() => emptyTriggerDraft())
  const [jsonError, setJsonError] = useState<string | null>(null)

  useEffect(() => {
    setDefinitionDraft(emptyDefinitionDraft(kind))
    setJsonError(null)
  }, [kind])

  const definitionsQuery = useQuery({
    queryKey: ['metadata-definitions', kind, status],
    queryFn: () => api.get('/metadata-definitions', {
      params: {
        kind,
        ...(status !== 'ALL' ? { status } : {}),
      },
    }).then(r => (r.data?.items ?? []) as MetadataDefinition[]),
  })

  const allDefinitionsQuery = useQuery({
    queryKey: ['metadata-definitions', 'all'],
    queryFn: () => api.get('/metadata-definitions').then(r => (r.data?.items ?? []) as MetadataDefinition[]),
  })

  const routingQuery = useQuery({
    queryKey: ['work-item-routing-policies'],
    queryFn: () => api.get('/work-item-routing-policies').then(r => (r.data?.items ?? []) as RoutingPolicy[]),
  })

  const triggersQuery = useQuery({
    queryKey: ['work-item-triggers'],
    queryFn: () => api.get('/work-item-triggers').then(r => (r.data?.items ?? []) as WorkItemTrigger[]),
  })

  const workflowsQuery = useQuery({
    queryKey: ['metadata-workflows'],
    queryFn: () => api.get('/workflows', { params: { size: 250 } }).then(r => unwrapItems<WorkflowOption>(r.data)),
  })

  const definitions = definitionsQuery.data ?? []
  const allDefinitions = allDefinitionsQuery.data ?? definitions
  const workItemTypes = useMemo(
    () => pickKeys(allDefinitions, 'WORK_ITEM_TYPE'),
    [allDefinitions],
  )
  const workflowTypes = useMemo(
    () => pickKeys(allDefinitions, 'WORKFLOW_TYPE'),
    [allDefinitions],
  )
  const eventTypes = useMemo(
    () => pickKeys(allDefinitions, 'EVENT_TYPE'),
    [allDefinitions],
  )

  const filteredDefinitions = definitions.filter(def => matchesQuery(query, [def.key, def.label, def.category, def.description]))
  const routingRows = (routingQuery.data ?? []).filter(row => matchesQuery(query, [row.capabilityId, row.workItemTypeKey, row.workflowTypeKey, row.workflow?.name]))
  const triggerRows = (triggersQuery.data ?? []).filter(row => matchesQuery(query, [row.triggerType, row.eventTypeKey, row.capabilityId, row.workItemTypeKey, row.dedupeKey]))

  const createOrUpdateDefinition = useMutation({
    mutationFn: async (draft: DefinitionDraft) => {
      const parsed = parseDefinitionPayload(draft)
      if (draft.id) {
        const { status, label, description, icon, color, category, schema, defaults, policy, ui, compatibility } = parsed
        return api.patch(`/metadata-definitions/${draft.id}`, { status, label, description, icon, color, category, schema, defaults, policy, ui, compatibility })
      }
      return api.post('/metadata-definitions', parsed)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['metadata-definitions'] })
      setJsonError(null)
    },
    onError: err => setJsonError(errorMessage(err)),
  })

  const createOrUpdateRouting = useMutation({
    mutationFn: async (draft: RoutingDraft) => {
      const payload = {
        capabilityId: draft.capabilityId,
        workItemTypeKey: draft.workItemTypeKey,
        workflowTypeKey: draft.workflowTypeKey,
        workflowId: draft.workflowId || null,
        routingMode: draft.routingMode,
        priority: Number(draft.priority) || 0,
        selector: parseJson(draft.selector, 'Selector'),
        isActive: draft.isActive,
      }
      return draft.id
        ? api.patch(`/work-item-routing-policies/${draft.id}`, payload)
        : api.post('/work-item-routing-policies', payload)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['work-item-routing-policies'] })
      setJsonError(null)
    },
    onError: err => setJsonError(errorMessage(err)),
  })

  const createOrUpdateTrigger = useMutation({
    mutationFn: async (draft: TriggerDraft) => {
      const payload = {
        triggerType: draft.triggerType,
        eventTypeKey: draft.eventTypeKey || undefined,
        capabilityId: draft.capabilityId || undefined,
        workItemTypeKey: draft.workItemTypeKey,
        routingMode: draft.routingMode,
        scheduleConfig: parseJson(draft.scheduleConfig, 'Schedule config'),
        payloadMapping: parseJson(draft.payloadMapping, 'Payload mapping'),
        dedupeKey: draft.dedupeKey || undefined,
        isActive: draft.isActive,
      }
      return draft.id
        ? api.patch(`/work-item-triggers/${draft.id}`, payload)
        : api.post('/work-item-triggers', payload)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['work-item-triggers'] })
      setJsonError(null)
    },
    onError: err => setJsonError(errorMessage(err)),
  })

  const selectedKind = KINDS.find(k => k.key === kind) ?? KINDS[0]
  const stats = buildStats(allDefinitions, routingQuery.data ?? [], triggersQuery.data ?? [])

  return (
    <main style={pageStyle}>
      <div style={heroStyle}>
        <div>
          <div style={eyebrowStyle}><Database size={13} /> Metadata registry</div>
          <h1 className="page-header" style={{ margin: '8px 0 6px' }}>Application Metadata</h1>
          <p style={mutedStyle}>
            Manage the versioned definitions that drive WorkItems, workflow routing, node palettes, server-time triggers, and event-created work.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            if (area === 'definitions') setDefinitionDraft(emptyDefinitionDraft(kind))
            if (area === 'routing') setRoutingDraft(emptyRoutingDraft())
            if (area === 'triggers') setTriggerDraft(emptyTriggerDraft())
            setJsonError(null)
          }}
          style={primaryButtonStyle}
        >
          <Plus size={16} /> New {area === 'definitions' ? 'definition' : area === 'routing' ? 'policy' : 'trigger'}
        </button>
      </div>

      <section style={statsGridStyle}>
        <StatCard label="Definitions" value={stats.definitions} tone="#2563eb" icon={<Braces size={17} />} />
        <StatCard label="Active routing policies" value={stats.activePolicies} tone="#368727" icon={<Route size={17} />} />
        <StatCard label="Event and schedule triggers" value={stats.triggers} tone="#f97316" icon={<CalendarClock size={17} />} />
        <StatCard label="Scoped overrides" value={stats.overrides} tone="#7c3aed" icon={<SlidersHorizontal size={17} />} />
      </section>

      <div style={areaSwitchStyle}>
        <AreaButton active={area === 'definitions'} icon={<Braces size={16} />} label="Type definitions" onClick={() => setArea('definitions')} />
        <AreaButton active={area === 'routing'} icon={<Route size={16} />} label="Routing policies" onClick={() => setArea('routing')} />
        <AreaButton active={area === 'triggers'} icon={<CalendarClock size={16} />} label="Triggers" onClick={() => setArea('triggers')} />
        <button
          type="button"
          onClick={() => {
            definitionsQuery.refetch()
            allDefinitionsQuery.refetch()
            routingQuery.refetch()
            triggersQuery.refetch()
            workflowsQuery.refetch()
          }}
          style={{ ...ghostButtonStyle, marginLeft: 'auto' }}
        >
          <RefreshCcw size={15} /> Refresh
        </button>
      </div>

      {jsonError && (
        <div style={errorStyle}>
          <X size={15} />
          <span>{jsonError}</span>
        </div>
      )}

      {area === 'definitions' && (
        <section style={workbenchStyle}>
          <aside style={leftRailStyle}>
            <div style={kindListStyle}>
              {KINDS.map(item => (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => setKind(item.key)}
                  style={{
                    ...kindButtonStyle,
                    ...(kind === item.key ? activeKindButtonStyle : {}),
                  }}
                >
                  <span style={kindIconStyle}>{item.icon}</span>
                  <span>
                    <strong>{item.label}</strong>
                    <small>{item.description}</small>
                  </span>
                </button>
              ))}
            </div>
          </aside>

          <div style={listPanelStyle}>
            <PanelHeader
              icon={selectedKind.icon}
              title={selectedKind.label}
              subtitle={selectedKind.description}
              right={<StatusFilter value={status} onChange={setStatus} />}
            />
            <SearchBox value={query} onChange={setQuery} placeholder="Search key, label, category..." />
            <div style={scrollListStyle}>
              {definitionsQuery.isLoading ? (
                <EmptyState title="Loading metadata..." description="Fetching definitions from Workgraph." />
              ) : filteredDefinitions.length === 0 ? (
                <EmptyState title="No definitions found" description="Create one or clear the current filters." />
              ) : filteredDefinitions.map(def => (
                <DefinitionCard
                  key={def.id}
                  definition={def}
                  selected={definitionDraft.id === def.id}
                  onClick={() => {
                    setDefinitionDraft(definitionToDraft(def))
                    setJsonError(null)
                  }}
                />
              ))}
            </div>
          </div>

          <DefinitionEditor
            draft={definitionDraft}
            onChange={setDefinitionDraft}
            onSubmit={() => createOrUpdateDefinition.mutate(definitionDraft)}
            saving={createOrUpdateDefinition.isPending}
          />
        </section>
      )}

      {area === 'routing' && (
        <section style={twoColumnStyle}>
          <div style={listPanelStyle}>
            <PanelHeader
              icon={<Route size={16} />}
              title="WorkItem routing policies"
              subtitle="Map WorkItem types to workflow types, workflow templates, and automatic start behavior."
            />
            <SearchBox value={query} onChange={setQuery} placeholder="Search capability, type, workflow..." />
            <div style={scrollListStyle}>
              {routingQuery.isLoading ? (
                <EmptyState title="Loading policies..." description="Fetching routing policies." />
              ) : routingRows.length === 0 ? (
                <EmptyState title="No routing policies" description="Create a policy to auto-attach or auto-start WorkItems." />
              ) : routingRows.map(row => (
                <RoutingCard
                  key={row.id}
                  row={row}
                  selected={routingDraft.id === row.id}
                  onClick={() => {
                    setRoutingDraft(routingToDraft(row))
                    setJsonError(null)
                  }}
                />
              ))}
            </div>
          </div>
          <RoutingEditor
            draft={routingDraft}
            onChange={setRoutingDraft}
            workItemTypes={workItemTypes}
            workflowTypes={workflowTypes}
            workflows={workflowsQuery.data ?? []}
            onSubmit={() => createOrUpdateRouting.mutate(routingDraft)}
            saving={createOrUpdateRouting.isPending}
          />
        </section>
      )}

      {area === 'triggers' && (
        <section style={twoColumnStyle}>
          <div style={listPanelStyle}>
            <PanelHeader
              icon={<CalendarClock size={16} />}
              title="Event and schedule triggers"
              subtitle="Create WorkItems from event types, webhooks, or server-time schedules before routing them into workflows."
            />
            <SearchBox value={query} onChange={setQuery} placeholder="Search trigger type, event, capability..." />
            <div style={scrollListStyle}>
              {triggersQuery.isLoading ? (
                <EmptyState title="Loading triggers..." description="Fetching trigger definitions." />
              ) : triggerRows.length === 0 ? (
                <EmptyState title="No triggers yet" description="Create an event, schedule, or webhook trigger." />
              ) : triggerRows.map(row => (
                <TriggerCard
                  key={row.id}
                  row={row}
                  selected={triggerDraft.id === row.id}
                  onClick={() => {
                    setTriggerDraft(triggerToDraft(row))
                    setJsonError(null)
                  }}
                />
              ))}
            </div>
          </div>
          <TriggerEditor
            draft={triggerDraft}
            onChange={setTriggerDraft}
            workItemTypes={workItemTypes}
            eventTypes={eventTypes}
            onSubmit={() => createOrUpdateTrigger.mutate(triggerDraft)}
            saving={createOrUpdateTrigger.isPending}
          />
        </section>
      )}
    </main>
  )
}

function DefinitionEditor({
  draft,
  onChange,
  onSubmit,
  saving,
}: {
  draft: DefinitionDraft
  onChange: (next: DefinitionDraft) => void
  onSubmit: () => void
  saving: boolean
}) {
  const immutable = Boolean(draft.id)
  return (
    <aside style={editorStyle}>
      <EditorTitle
        title={draft.id ? 'Edit definition' : 'New definition'}
        subtitle="Instances keep snapshots, so change definitions deliberately."
        icon={<Settings2 size={17} />}
      />
      <div style={formGridStyle}>
        <Field label="Kind">
          <Select value={draft.kind} disabled={immutable} onChange={kind => onChange({ ...draft, kind: kind as MetadataKind })} options={KINDS.map(k => [k.key, k.label])} />
        </Field>
        <Field label="Status">
          <Select value={draft.status} onChange={status => onChange({ ...draft, status: status as MetadataStatus })} options={STATUSES.map(s => [s, humanize(s)])} />
        </Field>
        <Field label="Key">
          <Input value={draft.key} disabled={immutable} onChange={key => onChange({ ...draft, key: key.toUpperCase().replace(/\s+/g, '_') })} placeholder="BUG_FIX" />
        </Field>
        <Field label="Version">
          <Input type="number" disabled={immutable} value={String(draft.version)} onChange={version => onChange({ ...draft, version: Number(version) || 1 })} />
        </Field>
        <Field label="Label">
          <Input value={draft.label} onChange={label => onChange({ ...draft, label })} placeholder="Bug Fix" />
        </Field>
        <Field label="Category">
          <Input value={draft.category} onChange={category => onChange({ ...draft, category })} placeholder="Engineering" />
        </Field>
        <Field label="Scope">
          <Select value={draft.scopeType} disabled={immutable} onChange={scopeType => onChange({ ...draft, scopeType: scopeType as MetadataScope, scopeId: scopeType === 'GLOBAL' ? '*' : draft.scopeId })} options={SCOPES.map(s => [s, humanize(s)])} />
        </Field>
        <Field label="Scope id">
          <Input value={draft.scopeId} disabled={immutable || draft.scopeType === 'GLOBAL'} onChange={scopeId => onChange({ ...draft, scopeId })} placeholder="*" />
        </Field>
        <Field label="Icon">
          <Select value={draft.icon} onChange={icon => onChange({ ...draft, icon })} options={ICONS.map(i => [i, i])} />
        </Field>
        <Field label="Color">
          <ColorPicker value={draft.color} onChange={color => onChange({ ...draft, color })} />
        </Field>
      </div>
      <Field label="Description">
        <Textarea value={draft.description} onChange={description => onChange({ ...draft, description })} rows={3} placeholder="Explain when this definition should be used." />
      </Field>
      <JsonFields
        values={draft}
        onChange={(key, value) => onChange({ ...draft, [key]: value })}
        fields={['schema', 'defaults', 'policy', 'ui', 'compatibility']}
      />
      <button type="button" onClick={onSubmit} disabled={saving || !draft.key || !draft.label} style={primaryButtonStyle}>
        <Save size={16} /> {saving ? 'Saving...' : draft.id ? 'Save definition' : 'Create definition'}
      </button>
    </aside>
  )
}

function RoutingEditor({
  draft,
  onChange,
  workItemTypes,
  workflowTypes,
  workflows,
  onSubmit,
  saving,
}: {
  draft: RoutingDraft
  onChange: (next: RoutingDraft) => void
  workItemTypes: string[]
  workflowTypes: string[]
  workflows: WorkflowOption[]
  onSubmit: () => void
  saving: boolean
}) {
  return (
    <aside style={editorStyle}>
      <EditorTitle
        title={draft.id ? 'Edit routing policy' : 'New routing policy'}
        subtitle="Policies choose the workflow path for new WorkItems."
        icon={<Route size={17} />}
      />
      <Field label="Capability">
        <CapabilityPicker
          value={draft.capabilityId}
          onChange={capabilityId => onChange({ ...draft, capabilityId })}
          placeholder="Select capability..."
          filterToMemberships={false}
          autoDefault={false}
        />
      </Field>
      <div style={formGridStyle}>
        <Field label="WorkItem type">
          <Select value={draft.workItemTypeKey} onChange={workItemTypeKey => onChange({ ...draft, workItemTypeKey })} options={ensureOption(workItemTypes, draft.workItemTypeKey)} />
        </Field>
        <Field label="Workflow type">
          <Select value={draft.workflowTypeKey} onChange={workflowTypeKey => onChange({ ...draft, workflowTypeKey })} options={ensureOption(workflowTypes, draft.workflowTypeKey)} />
        </Field>
        <Field label="Routing mode">
          <Select value={draft.routingMode} onChange={routingMode => onChange({ ...draft, routingMode: routingMode as RoutingMode })} options={ROUTING_MODES.map(m => [m, humanize(m)])} />
        </Field>
        <Field label="Priority">
          <Input type="number" value={String(draft.priority)} onChange={priority => onChange({ ...draft, priority: Number(priority) || 0 })} />
        </Field>
      </div>
      <Field label="Default workflow template">
        <Select
          value={draft.workflowId}
          onChange={workflowId => onChange({ ...draft, workflowId })}
          options={[['', 'Choose by workflow type'], ...workflows.map(w => [w.id, `${w.name}${w.workflowTypeKey ? ` · ${w.workflowTypeKey}` : ''}`] as [string, string])]}
        />
      </Field>
      <Field label="Selector JSON">
        <Textarea value={draft.selector} onChange={selector => onChange({ ...draft, selector })} rows={8} />
      </Field>
      <Toggle checked={draft.isActive} label="Policy active" onChange={isActive => onChange({ ...draft, isActive })} />
      <button type="button" onClick={onSubmit} disabled={saving || !draft.capabilityId} style={primaryButtonStyle}>
        <Save size={16} /> {saving ? 'Saving...' : draft.id ? 'Save policy' : 'Create policy'}
      </button>
    </aside>
  )
}

function TriggerEditor({
  draft,
  onChange,
  workItemTypes,
  eventTypes,
  onSubmit,
  saving,
}: {
  draft: TriggerDraft
  onChange: (next: TriggerDraft) => void
  workItemTypes: string[]
  eventTypes: string[]
  onSubmit: () => void
  saving: boolean
}) {
  return (
    <aside style={editorStyle}>
      <EditorTitle
        title={draft.id ? 'Edit trigger' : 'New trigger'}
        subtitle="Triggers create WorkItems from events, schedules, or webhooks."
        icon={<CalendarClock size={17} />}
      />
      <div style={formGridStyle}>
        <Field label="Trigger type">
          <Select value={draft.triggerType} onChange={triggerType => onChange({ ...draft, triggerType: triggerType as TriggerType })} options={TRIGGER_TYPES.map(t => [t, humanize(t)])} />
        </Field>
        <Field label="WorkItem type">
          <Select value={draft.workItemTypeKey} onChange={workItemTypeKey => onChange({ ...draft, workItemTypeKey })} options={ensureOption(workItemTypes, draft.workItemTypeKey)} />
        </Field>
        <Field label="Routing mode">
          <Select value={draft.routingMode} onChange={routingMode => onChange({ ...draft, routingMode: routingMode as RoutingMode })} options={ROUTING_MODES.map(m => [m, humanize(m)])} />
        </Field>
        <Field label="Event type">
          <Select value={draft.eventTypeKey} onChange={eventTypeKey => onChange({ ...draft, eventTypeKey })} options={[['', 'None'], ...ensureOption(eventTypes, draft.eventTypeKey)]} />
        </Field>
      </div>
      <Field label="Capability scope">
        <CapabilityPicker
          value={draft.capabilityId}
          onChange={capabilityId => onChange({ ...draft, capabilityId })}
          placeholder="Any capability"
          filterToMemberships={false}
          autoDefault={false}
        />
      </Field>
      <Field label="Dedupe key">
        <Input value={draft.dedupeKey} onChange={dedupeKey => onChange({ ...draft, dedupeKey })} placeholder="payload.issueId" />
      </Field>
      <JsonFields
        values={draft}
        onChange={(key, value) => onChange({ ...draft, [key]: value })}
        fields={['scheduleConfig', 'payloadMapping']}
      />
      <Toggle checked={draft.isActive} label="Trigger active" onChange={isActive => onChange({ ...draft, isActive })} />
      <button type="button" onClick={onSubmit} disabled={saving} style={primaryButtonStyle}>
        <Save size={16} /> {saving ? 'Saving...' : draft.id ? 'Save trigger' : 'Create trigger'}
      </button>
    </aside>
  )
}

function DefinitionCard({ definition, selected, onClick }: { definition: MetadataDefinition; selected: boolean; onClick: () => void }) {
  const Icon = iconFor(definition.icon, definition.kind)
  const color = definition.color || colorFor(definition.kind)
  return (
    <button type="button" onClick={onClick} style={{ ...cardButtonStyle, ...(selected ? selectedCardStyle : {}) }}>
      <span style={{ ...definitionIconStyle, background: `${color}18`, borderColor: `${color}33`, color }}>
        <Icon size={17} />
      </span>
      <span style={{ minWidth: 0 }}>
        <strong style={cardTitleStyle}>{definition.label}</strong>
        <span style={cardSubStyle}>{definition.key} · v{definition.version} · {definition.scopeType === 'GLOBAL' ? 'Global' : `${humanize(definition.scopeType)} override`}</span>
        {definition.description && <span style={cardDescriptionStyle}>{definition.description}</span>}
      </span>
      <Badge value={humanize(definition.status)} tone={statusColor(definition.status)} />
    </button>
  )
}

function RoutingCard({ row, selected, onClick }: { row: RoutingPolicy; selected: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} style={{ ...cardButtonStyle, ...(selected ? selectedCardStyle : {}) }}>
      <span style={{ ...definitionIconStyle, background: 'rgba(54,135,39,0.10)', borderColor: 'rgba(54,135,39,0.22)', color: '#368727' }}>
        <Route size={17} />
      </span>
      <span style={{ minWidth: 0 }}>
        <strong style={cardTitleStyle}>{row.workItemTypeKey} → {row.workflowTypeKey}</strong>
        <span style={cardSubStyle}>{humanize(row.routingMode)} · priority {row.priority}</span>
        <span style={cardDescriptionStyle}>{row.workflow?.name ?? 'Workflow selected by type'} · {shortId(row.capabilityId)}</span>
      </span>
      <Badge value={row.isActive ? 'Active' : 'Paused'} tone={row.isActive ? '#368727' : '#64748b'} />
    </button>
  )
}

function TriggerCard({ row, selected, onClick }: { row: WorkItemTrigger; selected: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} style={{ ...cardButtonStyle, ...(selected ? selectedCardStyle : {}) }}>
      <span style={{ ...definitionIconStyle, background: 'rgba(249,115,22,0.10)', borderColor: 'rgba(249,115,22,0.22)', color: '#f97316' }}>
        {row.triggerType === 'SCHEDULE' ? <CalendarClock size={17} /> : row.triggerType === 'WEBHOOK' ? <GitBranch size={17} /> : <BellRing size={17} />}
      </span>
      <span style={{ minWidth: 0 }}>
        <strong style={cardTitleStyle}>{humanize(row.triggerType)} trigger</strong>
        <span style={cardSubStyle}>{row.eventTypeKey || 'No event type'} · creates {row.workItemTypeKey}</span>
        <span style={cardDescriptionStyle}>{row.capabilityId ? shortId(row.capabilityId) : 'Any capability'} · {humanize(row.routingMode)}</span>
      </span>
      <Badge value={row.isActive ? 'Active' : 'Paused'} tone={row.isActive ? '#368727' : '#64748b'} />
    </button>
  )
}

function PanelHeader({ icon, title, subtitle, right }: { icon: ReactNode; title: string; subtitle: string; right?: ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', justifyContent: 'space-between' }}>
      <div style={{ display: 'flex', gap: 10, minWidth: 0 }}>
        <span style={panelHeaderIconStyle}>{icon}</span>
        <div>
          <h2 style={sectionTitleStyle}>{title}</h2>
          <p style={mutedStyle}>{subtitle}</p>
        </div>
      </div>
      {right}
    </div>
  )
}

function EditorTitle({ title, subtitle, icon }: { title: string; subtitle: string; icon: ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
      <span style={panelHeaderIconStyle}>{icon}</span>
      <div>
        <h2 style={sectionTitleStyle}>{title}</h2>
        <p style={mutedStyle}>{subtitle}</p>
      </div>
    </div>
  )
}

function StatCard({ label, value, tone, icon }: { label: string; value: number; tone: string; icon: ReactNode }) {
  return (
    <div style={statCardStyle}>
      <span style={{ ...statIconStyle, color: tone, background: `${tone}12`, borderColor: `${tone}28` }}>{icon}</span>
      <span>
        <strong style={statValueStyle}>{value}</strong>
        <small style={statLabelStyle}>{label}</small>
      </span>
    </div>
  )
}

function AreaButton({ active, icon, label, onClick }: { active: boolean; icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} style={{ ...areaButtonStyle, ...(active ? activeAreaButtonStyle : {}) }}>
      {icon}
      {label}
    </button>
  )
}

function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <label style={searchStyle}>
      <Search size={15} />
      <input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} style={searchInputStyle} />
    </label>
  )
}

function StatusFilter({ value, onChange }: { value: 'ALL' | MetadataStatus; onChange: (v: 'ALL' | MetadataStatus) => void }) {
  return (
    <select value={value} onChange={e => onChange(e.target.value as 'ALL' | MetadataStatus)} style={selectStyle}>
      <option value="ALL">All statuses</option>
      {STATUSES.map(s => <option key={s} value={s}>{humanize(s)}</option>)}
    </select>
  )
}

function JsonFields<T extends Record<string, unknown>>({
  values,
  fields,
  onChange,
}: {
  values: T
  fields: string[]
  onChange: (field: string, value: string) => void
}) {
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {fields.map(field => (
        <Field key={field} label={`${humanize(field)} JSON`}>
          <Textarea value={String(values[field] ?? '{}')} onChange={value => onChange(field, value)} rows={field === 'schema' ? 8 : 6} />
        </Field>
      ))}
    </div>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={{ display: 'grid', gap: 6 }}>
      <span style={labelStyle}>{label}</span>
      {children}
    </label>
  )
}

function Input({
  value,
  onChange,
  placeholder,
  type = 'text',
  disabled,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  type?: string
  disabled?: boolean
}) {
  return <input type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} disabled={disabled} style={{ ...inputStyle, opacity: disabled ? 0.65 : 1 }} />
}

function Textarea({ value, onChange, rows = 4, placeholder }: { value: string; onChange: (v: string) => void; rows?: number; placeholder?: string }) {
  return <textarea value={value} onChange={e => onChange(e.target.value)} rows={rows} placeholder={placeholder} style={textareaStyle} />
}

function Select({
  value,
  onChange,
  options,
  disabled,
}: {
  value: string
  onChange: (v: string) => void
  options: Array<[string, string]>
  disabled?: boolean
}) {
  return (
    <select value={value} onChange={e => onChange(e.target.value)} disabled={disabled} style={{ ...selectStyle, opacity: disabled ? 0.65 : 1 }}>
      {options.map(([v, label]) => <option key={`${v}-${label}`} value={v}>{label}</option>)}
    </select>
  )
}

function ColorPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {COLORS.map(color => (
        <button
          key={color}
          type="button"
          onClick={() => onChange(color)}
          title={color}
          style={{
            width: 26,
            height: 26,
            borderRadius: 8,
            border: value === color ? '2px solid #0f172a' : '1px solid #d8e0ea',
            background: color,
            cursor: 'pointer',
          }}
        />
      ))}
    </div>
  )
}

function Toggle({ checked, label, onChange }: { checked: boolean; label: string; onChange: (v: boolean) => void }) {
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#172033', cursor: 'pointer' }}>
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} style={{ accentColor: '#368727' }} />
      {label}
    </label>
  )
}

function Badge({ value, tone }: { value: string; tone: string }) {
  return (
    <span style={{
      alignSelf: 'flex-start',
      whiteSpace: 'nowrap',
      borderRadius: 999,
      padding: '4px 8px',
      background: `${tone}12`,
      border: `1px solid ${tone}28`,
      color: tone,
      fontSize: 10,
      fontWeight: 800,
      letterSpacing: '0.05em',
      textTransform: 'uppercase',
    }}>{value}</span>
  )
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div style={emptyStateStyle}>
      <ListFilter size={22} />
      <strong>{title}</strong>
      <p>{description}</p>
    </div>
  )
}

function parseDefinitionPayload(draft: DefinitionDraft) {
  return {
    kind: draft.kind,
    key: draft.key,
    version: Number(draft.version) || 1,
    status: draft.status,
    scopeType: draft.scopeType,
    scopeId: draft.scopeType === 'GLOBAL' ? '*' : draft.scopeId,
    label: draft.label,
    description: draft.description || undefined,
    icon: draft.icon || undefined,
    color: draft.color || undefined,
    category: draft.category || undefined,
    schema: parseJson(draft.schema, 'Schema'),
    defaults: parseJson(draft.defaults, 'Defaults'),
    policy: parseJson(draft.policy, 'Policy'),
    ui: parseJson(draft.ui, 'UI'),
    compatibility: parseJson(draft.compatibility, 'Compatibility'),
  }
}

function parseJson(value: string, label: string): JsonRecord {
  try {
    const parsed = JSON.parse(value || '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${label} must be a JSON object`)
    }
    return parsed as JsonRecord
  } catch (err) {
    throw new Error(`${label} JSON is invalid: ${(err as Error).message}`)
  }
}

function pretty(value: unknown): string {
  if (!value || typeof value !== 'object') return '{}'
  return JSON.stringify(value, null, 2)
}

function humanize(value: string): string {
  return value
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, c => c.toUpperCase())
}

function matchesQuery(query: string, values: Array<string | null | undefined>): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return values.some(v => String(v ?? '').toLowerCase().includes(q))
}

function buildStats(defs: MetadataDefinition[], policies: RoutingPolicy[], triggers: WorkItemTrigger[]) {
  return {
    definitions: defs.length,
    activePolicies: policies.filter(p => p.isActive).length,
    triggers: triggers.length,
    overrides: defs.filter(d => d.scopeType !== 'GLOBAL').length,
  }
}

function pickKeys(currentDefinitions: MetadataDefinition[], desired: MetadataKind): string[] {
  return currentDefinitions
    .filter(d => d.kind === desired && d.status === 'ACTIVE')
    .map(d => d.key)
    .filter(Boolean)
    .sort()
}

function ensureOption(values: string[], selected: string): Array<[string, string]> {
  const unique = Array.from(new Set([selected, ...values, 'GENERAL'].filter(Boolean))).sort()
  return unique.map(v => [v, humanize(v)])
}

function unwrapItems<T>(payload: unknown): T[] {
  if (Array.isArray(payload)) return payload as T[]
  if (payload && typeof payload === 'object' && Array.isArray((payload as { items?: unknown[] }).items)) {
    return (payload as { items: T[] }).items
  }
  return []
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (err && typeof err === 'object') {
    const anyErr = err as { response?: { data?: { message?: string; error?: string } } }
    return anyErr.response?.data?.message ?? anyErr.response?.data?.error ?? 'Save failed'
  }
  return 'Save failed'
}

function statusColor(status: MetadataStatus): string {
  if (status === 'ACTIVE') return '#368727'
  if (status === 'DRAFT') return '#2563eb'
  if (status === 'DEPRECATED') return '#f97316'
  return '#64748b'
}

function colorFor(kind: MetadataKind): string {
  if (kind === 'WORK_ITEM_TYPE') return '#2563eb'
  if (kind === 'WORKFLOW_TYPE') return '#368727'
  if (kind === 'NODE_TYPE') return '#7c3aed'
  if (kind === 'EVENT_TYPE') return '#f97316'
  return '#64748b'
}

function iconFor(icon: string | null | undefined, kind: MetadataKind) {
  const map = {
    Network,
    Workflow,
    Layers3,
    Bug,
    Sparkles,
    ShieldCheck,
    BellRing,
    CalendarClock,
    Route,
    Settings2,
  }
  return map[(icon ?? '') as keyof typeof map] ?? (
    kind === 'WORKFLOW_TYPE' ? Workflow :
    kind === 'NODE_TYPE' ? Layers3 :
    kind === 'EVENT_TYPE' ? BellRing :
    kind === 'TRIGGER_PROFILE' ? CalendarClock :
    Network
  )
}

function shortId(id: string): string {
  if (id.length <= 12) return id
  return `${id.slice(0, 8)}...${id.slice(-4)}`
}

const pageStyle: CSSProperties = {
  minHeight: '100%',
  padding: '28px',
  background: '#f7f8fb',
  color: '#172033',
}

const heroStyle: CSSProperties = {
  maxWidth: 1500,
  margin: '0 auto',
  display: 'flex',
  justifyContent: 'space-between',
  gap: 18,
  alignItems: 'flex-start',
}

const eyebrowStyle: CSSProperties = {
  display: 'inline-flex',
  gap: 7,
  alignItems: 'center',
  border: '1px solid #d9e3ee',
  background: '#fff',
  borderRadius: 999,
  padding: '5px 10px',
  fontSize: 11,
  fontWeight: 800,
  color: '#368727',
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
}

const mutedStyle: CSSProperties = {
  color: '#64748b',
  fontSize: 13,
  lineHeight: 1.5,
  margin: 0,
}

const statsGridStyle: CSSProperties = {
  maxWidth: 1500,
  margin: '22px auto 16px',
  display: 'grid',
  gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
  gap: 12,
}

const statCardStyle: CSSProperties = {
  background: '#fff',
  border: '1px solid #dbe4ec',
  borderRadius: 14,
  padding: '14px 16px',
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  boxShadow: '0 1px 3px rgba(15,23,42,0.04)',
}

const statIconStyle: CSSProperties = {
  width: 38,
  height: 38,
  borderRadius: 12,
  border: '1px solid',
  display: 'grid',
  placeItems: 'center',
}

const statValueStyle: CSSProperties = {
  display: 'block',
  fontSize: 22,
  color: '#0f172a',
  lineHeight: 1,
}

const statLabelStyle: CSSProperties = {
  display: 'block',
  color: '#64748b',
  fontSize: 11,
  marginTop: 4,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
}

const areaSwitchStyle: CSSProperties = {
  maxWidth: 1500,
  margin: '0 auto 16px',
  background: '#fff',
  border: '1px solid #dbe4ec',
  borderRadius: 14,
  padding: 6,
  display: 'flex',
  alignItems: 'center',
  gap: 6,
}

const areaButtonStyle: CSSProperties = {
  border: 'none',
  background: 'transparent',
  color: '#64748b',
  borderRadius: 10,
  padding: '9px 12px',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 7,
  fontSize: 13,
  fontWeight: 800,
  cursor: 'pointer',
}

const activeAreaButtonStyle: CSSProperties = {
  background: '#eef6f1',
  color: '#006b31',
}

const workbenchStyle: CSSProperties = {
  maxWidth: 1500,
  margin: '0 auto',
  display: 'grid',
  gridTemplateColumns: '300px minmax(360px, 1fr) minmax(420px, 0.95fr)',
  gap: 16,
  alignItems: 'start',
}

const twoColumnStyle: CSSProperties = {
  maxWidth: 1500,
  margin: '0 auto',
  display: 'grid',
  gridTemplateColumns: 'minmax(420px, 1fr) minmax(430px, 0.8fr)',
  gap: 16,
  alignItems: 'start',
}

const leftRailStyle: CSSProperties = {
  background: '#fff',
  border: '1px solid #dbe4ec',
  borderRadius: 16,
  padding: 10,
  boxShadow: '0 1px 3px rgba(15,23,42,0.04)',
}

const kindListStyle: CSSProperties = {
  display: 'grid',
  gap: 8,
}

const kindButtonStyle: CSSProperties = {
  width: '100%',
  border: '1px solid transparent',
  background: 'transparent',
  borderRadius: 12,
  padding: 12,
  textAlign: 'left',
  display: 'grid',
  gridTemplateColumns: '34px 1fr',
  gap: 10,
  cursor: 'pointer',
  color: '#172033',
}

const activeKindButtonStyle: CSSProperties = {
  borderColor: '#b9d8c4',
  background: '#eef7f2',
}

const kindIconStyle: CSSProperties = {
  width: 34,
  height: 34,
  borderRadius: 10,
  background: '#fff',
  border: '1px solid #dbe4ec',
  display: 'grid',
  placeItems: 'center',
  color: '#368727',
}

const listPanelStyle: CSSProperties = {
  background: '#fff',
  border: '1px solid #dbe4ec',
  borderRadius: 16,
  padding: 16,
  boxShadow: '0 1px 3px rgba(15,23,42,0.04)',
  minHeight: 640,
}

const editorStyle: CSSProperties = {
  background: '#fff',
  border: '1px solid #dbe4ec',
  borderRadius: 16,
  padding: 16,
  boxShadow: '0 1px 3px rgba(15,23,42,0.04)',
  display: 'grid',
  gap: 14,
}

const panelHeaderIconStyle: CSSProperties = {
  width: 34,
  height: 34,
  borderRadius: 11,
  background: '#eef7f2',
  border: '1px solid #cbe5d3',
  color: '#368727',
  display: 'grid',
  placeItems: 'center',
  flexShrink: 0,
}

const sectionTitleStyle: CSSProperties = {
  margin: 0,
  color: '#0f172a',
  fontSize: 17,
  lineHeight: 1.2,
}

const searchStyle: CSSProperties = {
  margin: '14px 0',
  height: 40,
  borderRadius: 12,
  border: '1px solid #dbe4ec',
  background: '#f8fafc',
  display: 'flex',
  alignItems: 'center',
  gap: 9,
  padding: '0 12px',
  color: '#64748b',
}

const searchInputStyle: CSSProperties = {
  flex: 1,
  border: 'none',
  outline: 'none',
  background: 'transparent',
  fontSize: 13,
  color: '#0f172a',
}

const scrollListStyle: CSSProperties = {
  display: 'grid',
  gap: 9,
  maxHeight: 560,
  overflow: 'auto',
  paddingRight: 4,
}

const cardButtonStyle: CSSProperties = {
  width: '100%',
  border: '1px solid #e2e8f0',
  background: '#fff',
  borderRadius: 13,
  padding: 12,
  display: 'grid',
  gridTemplateColumns: '42px 1fr auto',
  gap: 11,
  textAlign: 'left',
  cursor: 'pointer',
  color: '#172033',
  boxShadow: '0 1px 2px rgba(15,23,42,0.03)',
}

const selectedCardStyle: CSSProperties = {
  borderColor: '#94c9a9',
  boxShadow: '0 0 0 3px rgba(54,135,39,0.08)',
}

const definitionIconStyle: CSSProperties = {
  width: 42,
  height: 42,
  borderRadius: 13,
  border: '1px solid',
  display: 'grid',
  placeItems: 'center',
}

const cardTitleStyle: CSSProperties = {
  display: 'block',
  fontSize: 13,
  color: '#0f172a',
  marginBottom: 3,
}

const cardSubStyle: CSSProperties = {
  display: 'block',
  color: '#64748b',
  fontSize: 11,
  fontWeight: 700,
}

const cardDescriptionStyle: CSSProperties = {
  display: 'block',
  color: '#64748b',
  fontSize: 11,
  lineHeight: 1.45,
  marginTop: 5,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const formGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: 12,
}

const labelStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 800,
  color: '#64748b',
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
}

const inputStyle: CSSProperties = {
  width: '100%',
  minHeight: 38,
  borderRadius: 10,
  border: '1px solid #dbe4ec',
  background: '#fff',
  padding: '8px 10px',
  color: '#0f172a',
  fontSize: 13,
  boxSizing: 'border-box',
}

const textareaStyle: CSSProperties = {
  ...inputStyle,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  lineHeight: 1.45,
  resize: 'vertical',
}

const selectStyle: CSSProperties = {
  ...inputStyle,
  appearance: 'auto',
}

const primaryButtonStyle: CSSProperties = {
  minHeight: 40,
  border: 'none',
  borderRadius: 12,
  background: '#368727',
  color: '#fff',
  padding: '0 14px',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  fontSize: 13,
  fontWeight: 800,
  cursor: 'pointer',
  boxShadow: '0 8px 20px rgba(54,135,39,0.20)',
}

const ghostButtonStyle: CSSProperties = {
  minHeight: 38,
  border: '1px solid #dbe4ec',
  borderRadius: 11,
  background: '#fff',
  color: '#475569',
  padding: '0 12px',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 7,
  fontSize: 13,
  fontWeight: 800,
  cursor: 'pointer',
}

const errorStyle: CSSProperties = {
  maxWidth: 1500,
  margin: '0 auto 14px',
  border: '1px solid #fecaca',
  background: '#fff1f2',
  color: '#b91c1c',
  borderRadius: 12,
  padding: '10px 12px',
  display: 'flex',
  gap: 8,
  alignItems: 'center',
  fontSize: 13,
  fontWeight: 700,
}

const emptyStateStyle: CSSProperties = {
  border: '1px dashed #cbd5e1',
  borderRadius: 14,
  padding: 32,
  display: 'grid',
  placeItems: 'center',
  textAlign: 'center',
  color: '#64748b',
  gap: 8,
}
