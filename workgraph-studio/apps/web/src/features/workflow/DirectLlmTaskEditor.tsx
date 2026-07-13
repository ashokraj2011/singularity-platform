import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, Check, ChevronDown, ChevronRight, Plus, Save, Trash2, Wand2, X } from 'lucide-react'
import { api } from '../../lib/api'
import { fetchAgents, fetchCapabilities, fetchStudioAgents, type RegistryAgent } from '../../lib/registry'
import { RolePicker, SkillPicker, TeamPicker, UserPicker } from '../../components/lookup/EntityPickers'
import type { NodeConfig, DirectLlmConfig, DirectLlmFieldSpec, UpstreamOutput } from './NodeInspector'

type Binding = { name: string; path: string; required: boolean; description?: string }
type Field = DirectLlmFieldSpec & { name: string }
type Connection = { alias: string; label?: string; provider?: string; model?: string; credentialEnv?: string | null; credentialStatus?: string; costTier?: string; baseUrl?: string | null }
type PromptProfile = { id: string; name: string }
type LoopStrategy = { id: string; name: string; kind: string; status: string; currentVersion: number; latestVersion?: { version: number; definition?: Record<string, unknown>; contentHash?: string; publishedAt?: string | null } | null; latestPublishedVersion?: { version: number } | null }
type DirectTool = { name: string; description: string; inputSchema: Record<string, unknown>; readOnly: boolean }

type Props = {
  config: NodeConfig
  onChange: (config: NodeConfig) => void
  templateVariables?: Array<{ key: string; label?: string; type?: string; description?: string }>
  teamGlobals?: Array<{ key: string; label?: string; type?: string; description?: string }>
  upstreamOutputs?: UpstreamOutput[]
}

const inputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', background: '#fff', color: '#0f172a',
  border: '1px solid rgba(148,163,184,0.3)', borderRadius: 8, padding: '8px 10px', fontSize: 12,
}
const selectStyle: React.CSSProperties = { ...inputStyle, cursor: 'pointer' }
const labelStyle: React.CSSProperties = { fontSize: 10, fontWeight: 800, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 5 }
const sectionStyle: React.CSSProperties = { border: '1px solid rgba(148,163,184,0.22)', borderRadius: 10, padding: 11, background: '#fff' }

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string' || !value.trim()) return value
  try { return JSON.parse(value) } catch { return undefined }
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function boolValue(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return ['true', '1', 'yes', 'on'].includes(value.toLowerCase())
  return fallback
}

function schemaFromFields(fields: Record<string, DirectLlmFieldSpec>): Record<string, unknown> | undefined {
  if (Object.keys(fields).length === 0) return undefined
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [name, field] of Object.entries(fields)) {
    const property: Record<string, unknown> = { type: field.type }
    if (field.description) property.description = field.description
    if (Array.isArray(field.enum) && field.enum.length > 0) property.enum = field.enum
    if (field.type === 'array') property.items = field.items && typeof field.items === 'object' ? field.items : { type: 'string' }
    properties[name] = property
    if (field.required !== false) required.push(name)
  }
  return { type: 'object', additionalProperties: false, properties, required }
}

function enumText(values: unknown[] | undefined): string {
  return Array.isArray(values) ? values.map(value => String(value)).join(', ') : ''
}

function parseEnum(value: string, type: DirectLlmFieldSpec['type']): unknown[] {
  return value.split(',').map(item => item.trim()).filter(Boolean).map(item => {
    if (type === 'number' || type === 'integer') return Number(item)
    if (type === 'boolean') return ['true', '1', 'yes', 'on'].includes(item.toLowerCase())
    return item
  })
}

function directFromConfig(config: NodeConfig): DirectLlmConfig {
  const standard = config.standard ?? {}
  const raw = record(config.directLlm)
  const contract = record(raw.outputContract)
  const review = record(raw.review)
  const inputBindings = Array.isArray(raw.inputBindings)
    ? raw.inputBindings as Binding[]
    : (() => {
        const parsed = parseJson(standard.inputVariables)
        if (Array.isArray(parsed)) return parsed as Binding[]
        if (parsed && typeof parsed === 'object') return Object.entries(parsed as Record<string, unknown>).map(([name, value]) => ({ name, path: typeof value === 'string' ? value : stringValue(record(value).path), required: boolValue(record(value).required, true), description: stringValue(record(value).description) || undefined }))
        return []
      })()
  const rawFields = contract.fields ?? parseJson(standard.outputFields) ?? {}
  const fields: Record<string, DirectLlmFieldSpec> = Array.isArray(rawFields)
    ? Object.fromEntries((rawFields as Array<Record<string, unknown>>).map(item => [stringValue(item.name), item]).filter(([name]) => Boolean(name))) as Record<string, DirectLlmFieldSpec>
    : record(rawFields) as Record<string, DirectLlmFieldSpec>
  const source = stringValue(raw.promptSource ?? standard.promptSource).toUpperCase()
  const promptSource = source === 'AGENT_PROFILE' || source === 'URL' || source === 'INLINE'
    ? source
    : raw.agentTemplateId || standard.agentTemplateId ? 'AGENT_PROFILE' : raw.promptUrl || standard.promptUrl ? 'URL' : 'INLINE'
  return {
    connectionAlias: stringValue(raw.connectionAlias ?? standard.connectionAlias ?? standard.modelAlias),
    provider: stringValue(raw.provider ?? standard.provider),
    model: stringValue(raw.model ?? standard.model),
    baseUrl: stringValue(raw.baseUrl ?? standard.baseUrl),
    credentialEnv: stringValue(raw.credentialEnv ?? standard.credentialEnv),
    agentTemplateId: stringValue(raw.agentTemplateId ?? standard.agentTemplateId),
    capabilityId: stringValue(raw.capabilityId ?? standard.capabilityId),
    promptProfileKey: stringValue(raw.promptProfileKey ?? standard.promptProfileKey),
    promptSource,
    promptUrl: stringValue(raw.promptUrl ?? standard.promptUrl),
    task: stringValue(raw.task ?? standard.task),
    systemPrompt: stringValue(raw.systemPrompt ?? standard.systemPrompt),
    inputBindings,
    inputDocumentsPath: stringValue(raw.inputDocumentsPath ?? standard.inputDocumentsPath),
    outputContract: {
      fields,
      jsonSchema: (() => {
        const candidate = contract.jsonSchema ?? parseJson(standard.outputJsonSchema)
        return candidate && typeof candidate === 'object' && !Array.isArray(candidate) && Object.keys(candidate as Record<string, unknown>).length > 0
          ? candidate as Record<string, unknown>
          : undefined
      })(),
      validationMode: (stringValue(contract.validationMode ?? standard.validationMode).toLowerCase() as 'hard' | 'soft' | 'off') || 'hard',
    },
    review: {
      required: boolValue(review.required ?? raw.reviewRequired ?? standard.reviewRequired),
      coWork: boolValue(review.coWork ?? raw.coWork ?? standard.coWork),
      assignmentMode: stringValue(review.assignmentMode ?? raw.assignmentMode ?? standard.assignmentMode) || undefined,
      assignedToId: stringValue(review.assignedToId ?? raw.assignedToId ?? standard.assignedToId) || undefined,
      teamId: stringValue(review.teamId ?? raw.teamId ?? standard.teamId) || undefined,
      roleKey: stringValue(review.roleKey ?? raw.roleKey ?? standard.roleKey) || undefined,
      skillKey: stringValue(review.skillKey ?? raw.skillKey ?? standard.skillKey) || undefined,
    },
    loopStrategy: record(raw.loopStrategy).strategyId
      ? { strategyId: String(record(raw.loopStrategy).strategyId), version: Number(record(raw.loopStrategy).version ?? 1) }
      : undefined,
    maxTokens: Number(raw.maxTokens ?? standard.maxTokens) || undefined,
    temperature: Number(raw.temperature ?? standard.temperature) || undefined,
    timeoutMs: Number(raw.timeoutMs ?? standard.timeoutMs) || undefined,
    composeWithPromptComposer: boolValue(raw.composeWithPromptComposer ?? standard.composeWithPromptComposer, Boolean(raw.agentTemplateId ?? standard.agentTemplateId)),
  }
}

function toNodeConfig(config: NodeConfig, direct: DirectLlmConfig): NodeConfig {
  const standard = { ...config.standard }
  const write = (key: string, value: unknown) => {
    if (value === undefined || value === '') delete standard[key]
    else standard[key] = typeof value === 'string' ? value : JSON.stringify(value)
  }
  write('connectionAlias', direct.connectionAlias)
  write('modelAlias', direct.connectionAlias)
  write('provider', direct.provider)
  write('model', direct.model)
  write('baseUrl', direct.baseUrl)
  write('credentialEnv', direct.credentialEnv)
  write('agentTemplateId', direct.agentTemplateId)
  write('capabilityId', direct.capabilityId)
  write('promptProfileKey', direct.promptProfileKey)
  write('promptSource', direct.promptSource)
  write('promptUrl', direct.promptUrl)
  write('task', direct.task)
  write('systemPrompt', direct.systemPrompt)
  write('inputVariables', direct.inputBindings ?? [])
  write('inputDocumentsPath', direct.inputDocumentsPath)
  write('outputFields', direct.outputContract?.fields ?? {})
  write('outputJsonSchema', direct.outputContract?.jsonSchema ?? schemaFromFields(direct.outputContract?.fields ?? {}))
  write('validationMode', direct.outputContract?.validationMode ?? 'hard')
  write('reviewRequired', direct.review?.required ?? false)
  write('coWork', direct.review?.coWork ?? false)
  write('assignmentMode', direct.review?.assignmentMode)
  write('assignedToId', direct.review?.assignedToId)
  write('teamId', direct.review?.teamId)
  write('roleKey', direct.review?.roleKey)
  write('skillKey', direct.review?.skillKey)
  write('maxTokens', direct.maxTokens)
  write('temperature', direct.temperature)
  write('timeoutMs', direct.timeoutMs)
  write('composeWithPromptComposer', direct.composeWithPromptComposer)
  write('loopStrategyId', direct.loopStrategy?.strategyId)
  write('loopStrategyVersion', direct.loopStrategy?.version)
  return { ...config, standard, directLlm: direct }
}

export function directLlmConfigErrors(config: NodeConfig): string[] {
  const direct = directFromConfig(config)
  const errors: string[] = []
  if (!['hard', 'soft', 'off'].includes(direct.outputContract?.validationMode ?? 'hard')) errors.push('Validation behavior must be Hard, Soft, or Off.')
  if (direct.promptSource === 'AGENT_PROFILE' && !direct.agentTemplateId) errors.push('Select an agent profile for Agent profile mode.')
  if (direct.promptSource === 'URL' && !/^https?:\/\/[^\s]+$/i.test(direct.promptUrl ?? '')) errors.push('Prompt URL must be a valid http or https URL.')
  if (direct.promptSource === 'INLINE' && !direct.task?.trim()) errors.push('Enter an inline task prompt.')
  for (const [index, binding] of (direct.inputBindings ?? []).entries()) {
    if (!binding.name?.trim()) errors.push(`Input ${index + 1} needs a name.`)
    if (!binding.path?.trim()) errors.push(`Input ${index + 1} needs a source path.`)
  }
  const names = new Set<string>()
  for (const name of Object.keys(direct.outputContract?.fields ?? {})) {
    if (names.has(name)) errors.push(`Output field '${name}' is duplicated.`)
    names.add(name)
    const field = direct.outputContract?.fields[name]
    if (!field?.type) errors.push(`Output field '${name}' needs a type.`)
    if (field?.enum && !Array.isArray(field.enum)) errors.push(`Output field '${name}' enum must be an array.`)
  }
  return errors
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <div style={labelStyle}>{children}</div>
}

function Section({ title, children, open = true }: { title: string; children: React.ReactNode; open?: boolean }) {
  const [expanded, setExpanded] = useState(open)
  return <div style={sectionStyle}>
    <button type="button" onClick={() => setExpanded(value => !value)} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 7, border: 0, background: 'transparent', padding: 0, cursor: 'pointer', color: '#334155', fontSize: 11, fontWeight: 800, textAlign: 'left' }}>
      {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}{title}
    </button>
    {expanded && <div style={{ display: 'grid', gap: 10, marginTop: 11 }}>{children}</div>}
  </div>
}

function PathPicker({ value, onChange, suggestions, placeholder }: { value: string; onChange: (value: string) => void; suggestions: string[]; placeholder: string }) {
  const [custom, setCustom] = useState(() => Boolean(value && !suggestions.includes(value)))
  const current = value && !suggestions.includes(value) ? [value, ...suggestions] : suggestions
  const selectedValue = custom ? '__custom__' : value
  return <div style={{ display: 'grid', gap: 5 }}>
    <select value={selectedValue} onChange={event => {
      if (event.target.value === '__custom__') {
        setCustom(true)
        onChange(value && !suggestions.includes(value) ? value : '')
      } else {
        setCustom(false)
        onChange(event.target.value)
      }
    }} style={selectStyle}>
      <option value="">Choose a source path…</option>
      {current.map(path => <option key={path} value={path}>{path}</option>)}
      <option value="__custom__">Custom path…</option>
    </select>
    {custom ? <input value={value} onChange={event => onChange(event.target.value)} placeholder={placeholder} style={inputStyle} /> : null}
  </div>
}

function LoopStrategyWizard({ onClose, onCreated }: { onClose: () => void; onCreated: (strategy: { id: string; version: number }) => void }) {
  const [name, setName] = useState('Verifier review loop')
  const [kind, setKind] = useState<'SINGLE' | 'PHASE' | 'TOOL'>('PHASE')
  const [phases, setPhases] = useState<string[]>(['PLAN', 'VERIFY', 'SELF_REVIEW'])
  const [maxTurns, setMaxTurns] = useState(5)
  const [earlyStop, setEarlyStop] = useState(true)
  const [validationFailure, setValidationFailure] = useState('REPAIR')
  const [maxRepairAttempts, setMaxRepairAttempts] = useState(2)
  const [loopAgentRole, setLoopAgentRole] = useState('QA')
  const [promptProfileKey, setPromptProfileKey] = useState('')
  const [tools, setTools] = useState<string[]>(['read_context', 'validate_output'])
  const [error, setError] = useState<string | null>(null)
  const toolQuery = useQuery<DirectTool[]>({ queryKey: ['direct-llm-tools'], queryFn: () => api.get('/direct-llm/tools').then(response => (response.data?.items ?? []) as DirectTool[]), staleTime: 60_000 })
  const promptProfiles = useQuery<PromptProfile[]>({ queryKey: ['direct-llm-loop-prompt-profiles'], queryFn: () => api.get('/lookup/prompt-profiles').then(response => (response.data?.items ?? response.data?.content ?? response.data ?? []) as PromptProfile[]), staleTime: 60_000 })
  const phaseOptions = ['PLAN', 'EXPLORE', 'ACT', 'VERIFY', 'SELF_REVIEW', 'REPAIR', 'FINALIZE']
  const definition = { kind, phaseOrder: kind === 'PHASE' ? phases : [], loopAgentRole: loopAgentRole || undefined, promptProfileKey: promptProfileKey || undefined, maxTurns: kind === 'SINGLE' ? 1 : maxTurns, earlyStop: kind === 'SINGLE' ? false : earlyStop, validationFailure, maxRepairAttempts: kind === 'PHASE' ? maxRepairAttempts : 0, tools: kind === 'TOOL' ? tools : [] }
  const estimatedCalls = kind === 'SINGLE' ? 1 : kind === 'TOOL' ? maxTurns : Math.min(maxTurns, phases.length + (validationFailure === 'REPAIR' ? maxRepairAttempts : 0))
  async function publish() {
    setError(null)
    try {
      const validation = await api.post('/loop-strategies/validate', { definition })
      if (!validation.data?.ok) throw new Error((validation.data?.failures ?? []).map((item: { field: string; message: string }) => `${item.field}: ${item.message}`).join('; '))
      const response = await api.post('/loop-strategies', { name, kind, definition, publish: true })
      const strategy = response.data?.strategy
      const version = strategy?.versions?.[0]?.version ?? strategy?.currentVersion ?? 1
      onCreated({ id: strategy.id, version })
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not publish loop strategy.') }
  }
  return <div style={{ position: 'fixed', inset: 0, zIndex: 30, background: 'rgba(15,23,42,0.35)', display: 'flex', justifyContent: 'flex-end' }}>
    <div style={{ width: 'min(560px, 100vw)', height: '100%', background: '#f8fafc', boxShadow: '-12px 0 30px rgba(15,23,42,0.18)', overflowY: 'auto', padding: 18, display: 'grid', alignContent: 'start', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Wand2 size={17} color="#7c3aed" /><strong style={{ flex: 1, color: '#0f172a' }}>Design loop strategy</strong><button type="button" onClick={onClose} style={{ border: 0, background: 'transparent', cursor: 'pointer' }}><X size={16} /></button></div>
      <p style={{ margin: 0, color: '#64748b', fontSize: 12 }}>Create a bounded strategy once, publish it, and attach its pinned version to Direct LLM nodes.</p>
      <Section title="1. Choose loop mode"><FieldLabel>Name</FieldLabel><input value={name} onChange={event => setName(event.target.value)} style={inputStyle} /><FieldLabel>Mode</FieldLabel><select value={kind} onChange={event => setKind(event.target.value as typeof kind)} style={selectStyle}><option value="SINGLE">Single call</option><option value="PHASE">Phase loop</option><option value="TOOL">Read-only tool loop</option></select></Section>
      {kind === 'PHASE' && <Section title="2. Design phases"><div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>{phases.map((phase, index) => <span key={`${phase}-${index}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 8px', borderRadius: 999, background: '#ede9fe', color: '#6d28d9', fontSize: 11, fontWeight: 700 }}>{index + 1}. {phase}<button type="button" onClick={() => setPhases(current => current.filter((_, itemIndex) => itemIndex !== index))} style={{ border: 0, background: 'transparent', padding: 0, cursor: 'pointer', color: '#7c3aed' }}><X size={11} /></button></span>)}</div><select value="" onChange={event => { if (event.target.value && !phases.includes(event.target.value)) setPhases(current => [...current, event.target.value]); event.target.value = '' }} style={selectStyle}><option value="">Add a phase…</option>{phaseOptions.map(phase => <option key={phase} value={phase} disabled={phases.includes(phase)}>{phase}</option>)}</select></Section>}
      {kind === 'TOOL' && <Section title="2. Configure read-only tools"><div style={{ display: 'grid', gap: 6 }}>{(toolQuery.data ?? []).map(tool => <label key={tool.name} style={{ display: 'flex', alignItems: 'flex-start', gap: 7, padding: 7, border: '1px solid rgba(148,163,184,0.2)', borderRadius: 7, background: tools.includes(tool.name) ? '#ecfdf5' : '#fff' }}><input type="checkbox" checked={tools.includes(tool.name)} onChange={event => setTools(current => event.target.checked ? [...current, tool.name] : current.filter(name => name !== tool.name))} /><span><strong style={{ fontSize: 11, color: '#0f172a' }}>{tool.name}</strong><span style={{ display: 'block', color: '#64748b', fontSize: 10 }}>{tool.description}</span></span></label>)}</div></Section>}
      <Section title={kind === 'SINGLE' ? '2. Review behavior' : '3. Define convergence'}><div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 9 }}><div><FieldLabel>Max provider calls</FieldLabel><input type="number" min={1} max={12} value={kind === 'SINGLE' ? 1 : maxTurns} onChange={event => setMaxTurns(Number(event.target.value))} disabled={kind === 'SINGLE'} style={inputStyle} /></div><div><FieldLabel>Validation failure</FieldLabel><select value={validationFailure} onChange={event => setValidationFailure(event.target.value)} style={selectStyle}><option value="REPAIR">Repair then retry</option><option value="REVIEW">Pause for review</option><option value="BLOCK">Block the node</option></select></div></div><div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 9 }}><div><FieldLabel>Agent role</FieldLabel><select value={loopAgentRole} onChange={event => setLoopAgentRole(event.target.value)} style={selectStyle}><option value="">Use attached agent default</option>{['PRODUCT', 'ARCHITECT', 'ENGINEER', 'QA', 'SECURITY', 'RELEASE'].map(role => <option key={role} value={role}>{role}</option>)}</select></div><div><FieldLabel>Prompt profile</FieldLabel><select value={promptProfileKey} onChange={event => setPromptProfileKey(event.target.value)} style={selectStyle}><option value="">Use attached agent default</option>{(promptProfiles.data ?? []).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div></div><label style={{ display: 'flex', gap: 7, fontSize: 11, color: '#334155' }}><input type="checkbox" checked={earlyStop} onChange={event => setEarlyStop(event.target.checked)} disabled={kind === 'SINGLE'} /> Stop once the output contract is valid</label><div><FieldLabel>Maximum repair attempts</FieldLabel><input type="number" min={0} max={3} value={maxRepairAttempts} onChange={event => setMaxRepairAttempts(Number(event.target.value))} disabled={kind !== 'PHASE' || validationFailure !== 'REPAIR'} style={inputStyle} /></div></Section>
      <div style={{ padding: 11, borderRadius: 9, background: '#eef2ff', color: '#4338ca', fontSize: 11 }}>Expected maximum provider calls: <strong>{estimatedCalls}</strong>. The attached node supplies the output contract.</div>
      {error && <div style={{ padding: 10, borderRadius: 8, background: '#fef2f2', color: '#b91c1c', fontSize: 11 }}><AlertTriangle size={13} style={{ verticalAlign: 'middle', marginRight: 5 }} />{error}</div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}><button type="button" onClick={onClose} style={{ ...selectStyle, width: 'auto', background: '#fff' }}>Cancel</button><button type="button" onClick={publish} disabled={!name.trim()} style={{ ...selectStyle, width: 'auto', background: '#7c3aed', borderColor: '#7c3aed', color: '#fff', fontWeight: 800 }}><Save size={13} /> Publish strategy</button></div>
    </div>
  </div>
}

export function DirectLlmTaskEditor({ config, onChange, templateVariables = [], teamGlobals = [], upstreamOutputs = [] }: Props) {
  const [direct, setDirect] = useState<DirectLlmConfig>(() => directFromConfig(config))
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [showWizard, setShowWizard] = useState(false)
  const [rawSchema, setRawSchema] = useState(() => JSON.stringify(directFromConfig(config).outputContract?.jsonSchema ?? {}, null, 2))
  const connections = useQuery({ queryKey: ['llm-routing-connections'], queryFn: () => api.get('/llm-routing/connections').then(response => (response.data?.items ?? []) as Connection[]), staleTime: 30_000 })
  const capabilities = useQuery({ queryKey: ['direct-llm-capabilities'], queryFn: () => fetchCapabilities(), staleTime: 30_000 })
  const agents = useQuery({
    queryKey: ['direct-llm-agents', direct.capabilityId ?? 'all'],
    queryFn: async () => direct.capabilityId
      ? fetchStudioAgents(direct.capabilityId)
      : { common: await fetchAgents(), capability: [] },
    staleTime: 30_000,
  })
  const profiles = useQuery({ queryKey: ['direct-llm-prompt-profiles'], queryFn: () => api.get('/lookup/prompt-profiles').then(response => ((response.data?.items ?? response.data?.content ?? response.data ?? []) as PromptProfile[])), staleTime: 60_000 })
  const strategies = useQuery({ queryKey: ['loop-strategies', 'DIRECT_LLM_TASK'], queryFn: () => api.get('/loop-strategies?kind=DIRECT_LLM_TASK').then(response => (response.data?.items ?? []) as LoopStrategy[]), staleTime: 30_000 })
  const suggestions = useMemo(() => Array.from(new Set([
    ...templateVariables.map(item => `vars.${item.key}`),
    ...teamGlobals.map(item => `globals.${item.key}`),
    ...upstreamOutputs.map(item => item.artifact.bindingPath).filter(Boolean) as string[],
    'context._workItem.input.description',
    'context._workItem.input.documents',
    'context._webhookPayload.documents',
  ])), [templateVariables, teamGlobals, upstreamOutputs])
  const selectedConnection = (connections.data ?? []).find(item => item.alias === direct.connectionAlias)
  const agentOptions: RegistryAgent[] = [...(agents.data?.capability ?? []), ...(agents.data?.common ?? [])]
  const fields = Object.entries(direct.outputContract?.fields ?? {}).map(([name, spec]) => ({ name, ...spec }))

  function update(next: DirectLlmConfig) {
    setDirect(next)
    onChange(toNodeConfig(config, next))
  }
  function addInput() { update({ ...direct, inputBindings: [...(direct.inputBindings ?? []), { name: '', path: '', required: true }] }) }
  function updateInput(index: number, row: Binding) { update({ ...direct, inputBindings: (direct.inputBindings ?? []).map((item, itemIndex) => itemIndex === index ? row : item) }) }
  function removeInput(index: number) { update({ ...direct, inputBindings: (direct.inputBindings ?? []).filter((_, itemIndex) => itemIndex !== index) }) }
  function addField() { const name = `field${fields.length + 1}`; update({ ...direct, outputContract: { ...direct.outputContract!, fields: { ...direct.outputContract?.fields, [name]: { type: 'string', required: true } }, jsonSchema: undefined } }) }
  function updateField(oldName: string, next: Field) { const nextFields = { ...direct.outputContract?.fields }; const nextName = next.name.trim() || oldName; if (nextName !== oldName && nextFields[nextName]) return; delete nextFields[oldName]; nextFields[nextName] = { type: next.type, required: next.required, description: next.description, enum: next.enum, items: next.type === 'array' ? (next.items ?? { type: 'string' }) : undefined }; update({ ...direct, outputContract: { ...direct.outputContract!, fields: nextFields, jsonSchema: undefined } }) }
  function removeField(name: string) { const nextFields = { ...direct.outputContract?.fields }; delete nextFields[name]; update({ ...direct, outputContract: { ...direct.outputContract!, fields: nextFields, jsonSchema: undefined } }) }
  function attachStrategy(ref: { id: string; version: number }) { update({ ...direct, loopStrategy: { strategyId: ref.id, version: ref.version } }); setShowWizard(false) }
  function applyRawSchema() {
    try {
      const parsed = JSON.parse(rawSchema)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Schema root must be an object.')
      update({ ...direct, outputContract: { ...direct.outputContract!, jsonSchema: parsed } })
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Invalid JSON Schema')
    }
  }

  return <div style={{ display: 'grid', gap: 10 }}>
    <Section title="Connection and prompt">
      <div><FieldLabel>LLM connection</FieldLabel><select value={direct.connectionAlias ?? ''} onChange={event => update({ ...direct, connectionAlias: event.target.value })} style={selectStyle}><option value="">Use configured default / mock</option>{(connections.data ?? []).map(item => <option key={item.alias} value={item.alias}>{item.label ?? item.alias} · {item.provider}/{item.model}</option>)}</select>{selectedConnection && <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 5 }}><span style={{ fontSize: 10, color: selectedConnection.credentialStatus === 'configured' || selectedConnection.provider === 'mock' ? '#047857' : '#b45309' }}>{selectedConnection.credentialStatus === 'configured' || selectedConnection.provider === 'mock' ? 'Ready' : selectedConnection.credentialStatus ?? 'Check credential'}</span><span style={{ fontSize: 10, color: '#64748b' }}>{selectedConnection.provider}/{selectedConnection.model}</span>{selectedConnection.costTier && <span style={{ fontSize: 10, color: '#64748b' }}>{selectedConnection.costTier} cost</span>}</div>}</div>
      <div><FieldLabel>Prompt source</FieldLabel><select value={direct.promptSource ?? 'INLINE'} onChange={event => update({ ...direct, promptSource: event.target.value as DirectLlmConfig['promptSource'] })} style={selectStyle}><option value="AGENT_PROFILE">Agent profile and skills</option><option value="URL">Prompt URL</option><option value="INLINE">Inline prompt</option></select></div>
      {direct.promptSource === 'AGENT_PROFILE' && <><div><FieldLabel>Capability</FieldLabel><select value={direct.capabilityId ?? ''} onChange={event => update({ ...direct, capabilityId: event.target.value, agentTemplateId: '' })} style={selectStyle}><option value="">Choose capability…</option>{(capabilities.data ?? []).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div><div><FieldLabel>Agent profile</FieldLabel><select value={direct.agentTemplateId ?? ''} onChange={event => update({ ...direct, agentTemplateId: event.target.value })} style={selectStyle}><option value="">Choose an agent profile…</option>{agentOptions.map(item => <option key={item.id} value={item.id}>{item.name}{item.scope === 'common' ? ' · Common' : ' · Capability'}</option>)}</select></div><div><FieldLabel>Prompt profile</FieldLabel><select value={direct.promptProfileKey ?? ''} onChange={event => update({ ...direct, promptProfileKey: event.target.value })} style={selectStyle}><option value="">Use agent profile default</option>{(profiles.data ?? []).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div></>}
      {direct.promptSource === 'URL' && <div><FieldLabel>Prompt URL</FieldLabel><input value={direct.promptUrl ?? ''} onChange={event => update({ ...direct, promptUrl: event.target.value })} placeholder="https://example.com/verifier.md" style={inputStyle} /><div style={{ marginTop: 5, color: '#64748b', fontSize: 10 }}>The server validates protocol, credentials, size, redirects, and unsafe hosts before fetching.</div></div>}
      {direct.promptSource === 'INLINE' && <div><FieldLabel>Task prompt</FieldLabel><textarea value={direct.task ?? ''} onChange={event => update({ ...direct, task: event.target.value })} rows={4} placeholder="Validate the event documents and return the requested fields." style={{ ...inputStyle, resize: 'vertical' }} /></div>}
      <div><FieldLabel>System prompt</FieldLabel><textarea value={direct.systemPrompt ?? ''} onChange={event => update({ ...direct, systemPrompt: event.target.value })} rows={2} placeholder="Optional system instruction" style={{ ...inputStyle, resize: 'vertical' }} /></div>
    </Section>

    <Section title="Input bindings and documents">
      <div style={{ display: 'grid', gap: 7 }}>{(direct.inputBindings ?? []).map((binding, index) => <div key={`${index}-${binding.name}`} style={{ border: '1px solid rgba(148,163,184,0.2)', borderRadius: 8, padding: 8, display: 'grid', gap: 6 }}><div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 6 }}><input value={binding.name} onChange={event => updateInput(index, { ...binding, name: event.target.value })} placeholder="variable name" style={inputStyle} /><button type="button" onClick={() => removeInput(index)} style={{ border: 0, background: 'transparent', color: '#b91c1c', cursor: 'pointer' }}><Trash2 size={13} /></button></div><PathPicker value={binding.path} onChange={path => updateInput(index, { ...binding, path: path === '__custom__' ? '' : path })} suggestions={suggestions} placeholder="vars.document" /><div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><label style={{ fontSize: 10, color: '#475569' }}><input type="checkbox" checked={binding.required !== false} onChange={event => updateInput(index, { ...binding, required: event.target.checked })} /> Required</label><input value={binding.description ?? ''} onChange={event => updateInput(index, { ...binding, description: event.target.value })} placeholder="What this value means" style={{ ...inputStyle, flex: 1 }} /></div></div>)}</div><button type="button" onClick={addInput} style={{ ...selectStyle, display: 'inline-flex', width: 'auto', alignItems: 'center', gap: 5 }}><Plus size={12} /> Add input</button><div><FieldLabel>Input documents path</FieldLabel><PathPicker value={direct.inputDocumentsPath ?? ''} onChange={path => update({ ...direct, inputDocumentsPath: path === '__custom__' ? '' : path })} suggestions={suggestions} placeholder="context._workItem.input.documents" /></div></Section>

    <Section title="Output contract">
      <div style={{ display: 'grid', gap: 7 }}>
        {fields.map(field => <div key={field.name} style={{ border: '1px solid rgba(148,163,184,0.2)', borderRadius: 8, padding: 8, display: 'grid', gap: 6 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 110px auto', gap: 6 }}>
            <input value={field.name} onChange={event => updateField(field.name, { ...field, name: event.target.value })} placeholder="field name" style={inputStyle} />
            <select value={field.type} onChange={event => updateField(field.name, { ...field, type: event.target.value as Field['type'] })} style={selectStyle}>{['string', 'number', 'integer', 'boolean', 'object', 'array'].map(type => <option key={type} value={type}>{type}</option>)}</select>
            <button type="button" onClick={() => removeField(field.name)} style={{ border: 0, background: 'transparent', color: '#b91c1c', cursor: 'pointer' }}><Trash2 size={13} /></button>
          </div>
          <input value={field.description ?? ''} onChange={event => updateField(field.name, { ...field, description: event.target.value })} placeholder="Description" style={inputStyle} />
          {field.type === 'array' && <div><FieldLabel>Array item type</FieldLabel><select value={String((field.items as Record<string, unknown> | undefined)?.type ?? 'string')} onChange={event => updateField(field.name, { ...field, items: { type: event.target.value } })} style={selectStyle}>{['string', 'number', 'integer', 'boolean', 'object'].map(type => <option key={type} value={type}>{type}</option>)}</select></div>}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <label style={{ fontSize: 10, color: '#475569' }}><input type="checkbox" checked={field.required !== false} onChange={event => updateField(field.name, { ...field, required: event.target.checked })} /> Required</label>
            {['string', 'number', 'integer', 'boolean'].includes(field.type) && <input value={enumText(field.enum)} onChange={event => updateField(field.name, { ...field, enum: parseEnum(event.target.value, field.type) })} placeholder="Allowed values, comma separated" style={{ ...inputStyle, flex: 1 }} />}
          </div>
        </div>)}
      </div>
      <button type="button" onClick={addField} style={{ ...selectStyle, display: 'inline-flex', width: 'auto', alignItems: 'center', gap: 5 }}><Plus size={12} /> Add output field</button>
      <div><FieldLabel>Validation behavior</FieldLabel><select value={direct.outputContract?.validationMode ?? 'hard'} onChange={event => update({ ...direct, outputContract: { ...direct.outputContract!, validationMode: event.target.value as 'hard' | 'soft' | 'off', jsonSchema: undefined } })} style={selectStyle}><option value="hard">Hard block invalid output</option><option value="soft">Pause for human review</option><option value="off">Do not validate output</option></select></div>
      <pre style={{ margin: 0, padding: 9, background: '#0f172a', color: '#dbeafe', borderRadius: 7, fontSize: 10, overflowX: 'auto' }}>{JSON.stringify(direct.outputContract?.jsonSchema ?? schemaFromFields(direct.outputContract?.fields ?? {}) ?? {}, null, 2)}</pre>
    </Section>

    <Section title="Human review"><div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}><label style={{ fontSize: 11, color: '#334155' }}><input type="checkbox" checked={direct.review?.required ?? false} onChange={event => update({ ...direct, review: { ...direct.review!, required: event.target.checked } })} /> Require review</label><label style={{ fontSize: 11, color: '#334155' }}><input type="checkbox" checked={direct.review?.coWork ?? false} onChange={event => update({ ...direct, review: { ...direct.review!, coWork: event.target.checked, required: event.target.checked || direct.review?.required !== false } })} /> Open co-work review</label></div><select value={direct.review?.assignmentMode ?? ''} onChange={event => update({ ...direct, review: { ...direct.review!, assignmentMode: event.target.value || undefined } })} style={selectStyle}><option value="">Choose reviewer routing…</option><option value="DIRECT_USER">Direct user</option><option value="TEAM_QUEUE">Team queue</option><option value="ROLE_BASED">Role</option><option value="SKILL_BASED">Skill</option></select>{direct.review?.assignmentMode === 'DIRECT_USER' && <UserPicker value={direct.review.assignedToId ?? ''} onChange={value => update({ ...direct, review: { ...direct.review!, assignedToId: value } })} />}{direct.review?.assignmentMode === 'TEAM_QUEUE' && <TeamPicker value={direct.review.teamId ?? ''} onChange={value => update({ ...direct, review: { ...direct.review!, teamId: value } })} />}{direct.review?.assignmentMode === 'ROLE_BASED' && <RolePicker value={direct.review.roleKey ?? ''} onChange={value => update({ ...direct, review: { ...direct.review!, roleKey: value } })} />}{direct.review?.assignmentMode === 'SKILL_BASED' && <SkillPicker value={direct.review.skillKey ?? ''} onChange={value => update({ ...direct, review: { ...direct.review!, skillKey: value } })} />}</Section>

    <Section title="Loop strategy"><div style={{ display: 'flex', gap: 7 }}><select value={direct.loopStrategy ? `${direct.loopStrategy.strategyId}@${direct.loopStrategy.version}` : ''} onChange={event => { const [id, version] = event.target.value.split('@'); update(id ? { ...direct, loopStrategy: { strategyId: id, version: Number(version) } } : { ...direct, loopStrategy: undefined }) }} style={{ ...selectStyle, flex: 1 }}><option value="">Single call / legacy inline loop</option>{(strategies.data ?? []).filter(item => item.latestPublishedVersion || (item.status === 'PUBLISHED' && item.latestVersion?.publishedAt)).map(item => { const version = item.latestPublishedVersion?.version ?? item.latestVersion?.version ?? item.currentVersion; return <option key={item.id} value={`${item.id}@${version}`}>{item.name} · {item.kind} · v{version}</option> })}</select><button type="button" onClick={() => setShowWizard(true)} style={{ ...selectStyle, width: 'auto', display: 'inline-flex', gap: 5, alignItems: 'center' }}><Wand2 size={12} /> Design</button></div>{direct.loopStrategy && <div style={{ fontSize: 10, color: '#047857', display: 'flex', alignItems: 'center', gap: 5 }}><Check size={12} /> Pinned strategy version {direct.loopStrategy.version}</div>}</Section>

    <Section title="Advanced provider and JSON" open={showAdvanced}><div><FieldLabel>Provider fallback</FieldLabel><input value={direct.provider ?? ''} onChange={event => update({ ...direct, provider: event.target.value })} placeholder="anthropic | openai_compatible | mock" style={inputStyle} /></div><div><FieldLabel>Model fallback</FieldLabel><input value={direct.model ?? ''} onChange={event => update({ ...direct, model: event.target.value })} placeholder="Used when no connection alias is selected" style={inputStyle} /></div><div><FieldLabel>Base URL fallback</FieldLabel><input value={direct.baseUrl ?? ''} onChange={event => update({ ...direct, baseUrl: event.target.value })} placeholder="https://api.example.com/v1" style={inputStyle} /></div><div><FieldLabel>Credential environment variable</FieldLabel><input value={direct.credentialEnv ?? ''} onChange={event => update({ ...direct, credentialEnv: event.target.value })} placeholder="OPENAI_API_KEY" style={inputStyle} /></div><div><FieldLabel>Output JSON Schema</FieldLabel><textarea value={rawSchema} onChange={event => setRawSchema(event.target.value)} onBlur={applyRawSchema} rows={8} style={{ ...inputStyle, fontFamily: 'monospace', fontSize: 10 }} /><button type="button" onClick={applyRawSchema} style={{ ...selectStyle, width: 'auto', marginTop: 5 }}>Apply and validate schema</button></div></Section>
    <button type="button" onClick={() => setShowAdvanced(value => !value)} style={{ border: 0, background: 'transparent', color: '#64748b', fontSize: 10, cursor: 'pointer', textAlign: 'left' }}>{showAdvanced ? 'Hide advanced configuration' : 'Show advanced configuration'}</button>
    {showWizard && <LoopStrategyWizard onClose={() => setShowWizard(false)} onCreated={attachStrategy} />}
  </div>
}
