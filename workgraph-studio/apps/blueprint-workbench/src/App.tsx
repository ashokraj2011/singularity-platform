import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  Activity,
  ArrowDownLeft,
  BadgeCheck,
  BookOpen,
  Boxes,
  Brain,
  CheckCircle2,
  ClipboardCheck,
  Code2,
  Download,
  FileCode2,
  GitBranch,
  HardDrive,
  Loader2,
  LogOut,
  Play,
  RefreshCw,
  ScanSearch,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Terminal,
  Undo2,
  X,
} from 'lucide-react'
import {
  api,
  clearToken,
  getToken,
  pseudoLogin,
  saveToken,
  type BlueprintArtifact,
  type CodeChangeRecord,
  type BlueprintSession,
  type CreateSessionRequest,
  type DecisionAnswer,
  type GateMode,
  type LoopStage,
  type LoopDefinition,
  type LoopVerdict,
  type LookupAgent,
  type LookupCapability,
  type GovernanceMode,
  type SnapshotMode,
  type SourceType,
  type StageAttempt,
  type WorkbenchExecutionConfig,
  type WorkflowInstanceDetail,
  type WorkflowInstanceListItem,
} from './api'

const knownRoleMeta: Record<string, { label: string; icon: typeof Brain }> = {
  ARCHITECT: { label: 'Architect', icon: Brain },
  DEVELOPER: { label: 'Developer', icon: Code2 },
  QA: { label: 'QA', icon: ClipboardCheck },
}

const defaultWorkbenchGoal = 'Create a governed planning, design, development, QA, and testing loop for this codebase.'

type WorkbenchSection = 'workflow' | 'artifacts' | 'terminal'

type WorkbenchHydratedDefaults = {
  goal?: string
  sourceType?: SourceType
  sourceUri?: string
  sourceRef?: string
  capabilityId?: string
  architectAgentTemplateId?: string
  developerAgentTemplateId?: string
  qaAgentTemplateId?: string
  gateMode?: GateMode
  loopDefinition?: LoopDefinition
}

function requestWorkbenchAuthFromHost() {
  const message = { type: 'blueprintWorkbench.auth.request' }
  if (window.parent && window.parent !== window) {
    window.parent.postMessage(message, 'http://localhost:5174')
  }
  if (window.opener && window.opener !== window) {
    window.opener.postMessage(message, 'http://localhost:5174')
  }
}

function roleMeta(role: string) {
  const normalized = role.toUpperCase()
  if (knownRoleMeta[normalized]) return knownRoleMeta[normalized]
  if (normalized.includes('DEV') || normalized.includes('ENGINEER')) return { label: titleFromRole(role), icon: Code2 }
  if (normalized.includes('QA') || normalized.includes('TEST') || normalized.includes('VERIFY')) return { label: titleFromRole(role), icon: ClipboardCheck }
  return { label: titleFromRole(role), icon: Brain }
}

const verdictLabels: Record<LoopVerdict, string> = {
  PASS: 'Pass',
  NEEDS_REWORK: 'Needs rework',
  BLOCKED: 'Blocked',
  ACCEPTED_WITH_RISK: 'Accepted with risk',
}

export default function App() {
  const queryClient = useQueryClient()
  const workflowDefaults = useMemo(() => readWorkflowDefaults(), [])
  const [activeSession, setActiveSession] = useState<BlueprintSession | null>(null)
  const [activeSection, setActiveSection] = useState<WorkbenchSection>('workflow')
  const [authTick, setAuthTick] = useState(0)
  const [setupOpen, setSetupOpen] = useState(false)
  const [localCreatedSessionIds, setLocalCreatedSessionIds] = useState<Set<string>>(() => new Set())
  const hasToken = Boolean(getToken())

  const sessionsQuery = useQuery({
    queryKey: ['blueprintSessions'],
    queryFn: api.listSessions,
    enabled: hasToken,
  })
  const sessions = sessionsQuery.data?.items ?? []
  const workflowScoped = Boolean(workflowDefaults.workflowInstanceId && workflowDefaults.workflowNodeId)
  const visibleSessions = useMemo(() => {
    if (!workflowScoped) return sessions
    return sessions.filter(session =>
      localCreatedSessionIds.has(session.id)
      || (
        session.workflowInstanceId === workflowDefaults.workflowInstanceId
        && session.workflowNodeId === workflowDefaults.workflowNodeId
      ),
    )
  }, [localCreatedSessionIds, sessions, workflowDefaults.workflowInstanceId, workflowDefaults.workflowNodeId, workflowScoped])

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.origin !== 'http://localhost:5174') return
      const data = event.data
      if (!data || typeof data !== 'object' || data.type !== 'blueprintWorkbench.auth') return
      const token = typeof data.token === 'string' ? data.token : ''
      if (!token) return
      saveToken(token)
      setAuthTick(v => v + 1)
    }
    window.addEventListener('message', handler)
    requestWorkbenchAuthFromHost()
    return () => window.removeEventListener('message', handler)
  }, [])

  useEffect(() => {
    setActiveSession(current => {
      if (visibleSessions.length === 0) {
        return current && localCreatedSessionIds.has(current.id) ? current : null
      }
      if (!current) return visibleSessions[0]
      if (localCreatedSessionIds.has(current.id)) return current
      return visibleSessions.find(session => session.id === current.id) ?? visibleSessions[0]
    })
  }, [localCreatedSessionIds, visibleSessions])

  const refreshSession = (session: BlueprintSession) => {
    setActiveSession(session)
    void queryClient.invalidateQueries({ queryKey: ['blueprintSessions'] })
  }

  if (!hasToken) {
    return <AuthGate onAuthed={() => setAuthTick(v => v + 1)} />
  }

  return (
    <main className="app-shell">
      <WorkbenchCommandHeader
        session={activeSession}
        activeSection={activeSection}
        onSection={setActiveSection}
        onRefresh={() => sessionsQuery.refetch()}
        onSetup={() => setSetupOpen(true)}
        onSignOut={() => {
          clearToken()
          setAuthTick(authTick + 1)
          setActiveSession(null)
          queryClient.clear()
        }}
      />

      <section className="loop-shell">
        <SetupDrawer open={setupOpen || !activeSession} onClose={() => setSetupOpen(false)}>
          <WorkbenchSetup
            sessions={visibleSessions}
            activeSession={activeSession}
            onSelect={(session) => {
              setActiveSession(session)
              setSetupOpen(false)
            }}
            onCreated={(session) => {
              setLocalCreatedSessionIds(current => {
                const next = new Set(current)
                next.add(session.id)
                return next
              })
              refreshSession(session)
              setSetupOpen(false)
            }}
          />
        </SetupDrawer>
        <LoopWorkbench session={activeSession} activeSection={activeSection} onSession={refreshSession} />
      </section>
    </main>
  )
}

function WorkbenchCommandHeader({
  session,
  activeSection,
  onSection,
  onRefresh,
  onSetup,
  onSignOut,
}: {
  session: BlueprintSession | null
  activeSection: WorkbenchSection
  onSection: (section: WorkbenchSection) => void
  onRefresh: () => void
  onSetup: () => void
  onSignOut: () => void
}) {
  const attempts = session?.stageAttempts?.length ?? 0
  const sendBacks = session?.reviewEvents?.filter(event => event.type === 'SEND_BACK' || event.type === 'AUTO_SEND_BACK').length ?? 0
  const activeStage = session?.loopDefinition?.stages.find(stage => stage.key === session.currentStageKey)
  return (
    <header className="command-header">
      <div className="brand-lockup">
        <div className="brand-mark"><Terminal size={18} /></div>
        <div>
          <p className="eyebrow">Singularity Core Engine</p>
          <h1>Story-to-Delivery Workbench</h1>
        </div>
      </div>
      <nav className="command-tabs" aria-label="Workbench sections">
        {([
          ['workflow', 'Workflow'],
          ['artifacts', 'Artifacts'],
          ['terminal', 'Terminal'],
        ] as const).map(([section, label]) => (
          <button
            key={section}
            type="button"
            className={activeSection === section ? 'active' : ''}
            onClick={() => onSection(section)}
            aria-pressed={activeSection === section}
          >
            {label}
          </button>
        ))}
      </nav>
      <div className="command-search">
        <Search size={15} />
        <input placeholder="Search session, stage, artifact..." />
      </div>
      <div className="command-metrics">
        <MetricPill label="Stage" value={activeStage?.label ?? 'No session'} tone="primary" />
        <MetricPill label="Iterations" value={String(attempts)} />
        <MetricPill label="Loops" value={String(sendBacks)} tone={sendBacks > 0 ? 'warning' : 'default'} />
      </div>
      <div className="topbar-actions">
        <button className="secondary-action compact-action" onClick={onSetup}><Settings size={15} /> Setup</button>
        <button className="icon-button" onClick={onRefresh} title="Refresh sessions"><RefreshCw size={16} /></button>
        <button className="icon-button" onClick={onSignOut} title="Sign out"><LogOut size={16} /></button>
      </div>
    </header>
  )
}

function MetricPill({ label, value, tone = 'default' }: { label: string; value: string; tone?: 'default' | 'primary' | 'warning' }) {
  return (
    <div className={`metric-pill ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function SetupDrawer({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  return (
    <>
      <div className={`drawer-scrim ${open ? 'open' : ''}`} onClick={onClose} />
      <aside className={`setup-drawer ${open ? 'open' : ''}`}>
        <button className="drawer-close" onClick={onClose} title="Close setup"><X size={16} /></button>
        {children}
      </aside>
    </>
  )
}

function AuthGate({ onAuthed }: { onAuthed: () => void }) {
  const loginMutation = useMutation({ mutationFn: pseudoLogin, onSuccess: onAuthed })
  return (
    <main className="auth-empty">
      <div>
        <Sparkles size={28} />
        <h1>Blueprint Workbench</h1>
        <p>This standalone MVP uses the Workgraph API and needs a browser token on port 5176.</p>
        <button className="primary-action" onClick={() => loginMutation.mutate()} disabled={loginMutation.isPending}>
          {loginMutation.isPending ? <Loader2 className="spin" size={16} /> : <ShieldCheck size={16} />}
          Continue as super admin
        </button>
        {loginMutation.isError && <p className="error-text">{loginMutation.error.message}</p>}
      </div>
    </main>
  )
}

function WorkbenchSetup({
  sessions,
  activeSession,
  onSelect,
  onCreated,
}: {
  sessions: BlueprintSession[]
  activeSession: BlueprintSession | null
  onSelect: (session: BlueprintSession) => void
  onCreated: (session: BlueprintSession) => void
}) {
  const workflowDefaults = useMemo(readWorkflowDefaults, [])
  const [sourceType, setSourceType] = useState<SourceType>(workflowDefaults.sourceType ?? 'localdir')
  const [sourceUri, setSourceUri] = useState(workflowDefaults.sourceUri ?? '')
  const [sourceRef, setSourceRef] = useState(workflowDefaults.sourceRef ?? '')
  const [goal, setGoal] = useState(workflowDefaults.goal ?? defaultWorkbenchGoal)
  const [gateMode, setGateMode] = useState<GateMode>(workflowDefaults.gateMode ?? 'manual')
  const [capabilityId, setCapabilityId] = useState(workflowDefaults.capabilityId ?? '')
  const [architectAgentTemplateId, setArchitectAgentTemplateId] = useState(workflowDefaults.architectAgentTemplateId ?? '')
  const [developerAgentTemplateId, setDeveloperAgentTemplateId] = useState(workflowDefaults.developerAgentTemplateId ?? '')
  const [qaAgentTemplateId, setQaAgentTemplateId] = useState(workflowDefaults.qaAgentTemplateId ?? '')
  const [loopDefinition, setLoopDefinition] = useState<LoopDefinition | undefined>(workflowDefaults.loopDefinition as LoopDefinition | undefined)
  const [includeGlobs, setIncludeGlobs] = useState('')
  const [excludeGlobs, setExcludeGlobs] = useState('**/node_modules/**,**/dist/**,**/.git/**')
  const [maxLoopsPerStage, setMaxLoopsPerStage] = useState(workflowDefaults.loopDefinition?.maxLoopsPerStage ?? 3)
  const [maxTotalSendBacks, setMaxTotalSendBacks] = useState(workflowDefaults.loopDefinition?.maxTotalSendBacks ?? 8)
  const [snapshotMode, setSnapshotMode] = useState<SnapshotMode>('relevant_excerpts')
  const [excerptBudgetChars, setExcerptBudgetChars] = useState(18_000)
  const [reuseUnchangedAttempt, setReuseUnchangedAttempt] = useState(true)
  const [governanceMode, setGovernanceMode] = useState<GovernanceMode>('fail_open')
  const [modelAlias, setModelAlias] = useState('')
  const [maxContextTokens, setMaxContextTokens] = useState(6_000)
  const [maxOutputTokens, setMaxOutputTokens] = useState(1_200)
  const [maxPromptChars, setMaxPromptChars] = useState(24_000)
  const [maxLayerChars, setMaxLayerChars] = useState(2_000)

  const workflowInstanceQuery = useQuery({
    queryKey: ['workflowInstanceDefaults', workflowDefaults.workflowInstanceId, workflowDefaults.workflowNodeId],
    queryFn: () => api.workflowInstance(workflowDefaults.workflowInstanceId!),
    enabled: Boolean(workflowDefaults.workflowInstanceId && workflowDefaults.workflowNodeId),
  })
  const workflowFallbackQuery = useQuery({
    queryKey: ['workflowWorkbenchFallbackDefaults', workflowDefaults.capabilityId],
    queryFn: () => loadWorkflowWorkbenchFallbackDefaults(workflowDefaults.capabilityId),
    enabled: Boolean(workflowDefaults.workflowInstanceId && (!workflowDefaults.goal || !workflowDefaults.sourceUri)),
    retry: false,
  })
  const capabilitiesQuery = useQuery({ queryKey: ['capabilities'], queryFn: api.capabilities })
  const capabilities = capabilitiesQuery.data ?? []
  const agentsQuery = useQuery({
    queryKey: ['agents', capabilityId],
    queryFn: () => api.agents(capabilityId),
    enabled: Boolean(capabilityId),
  })
  const agents = agentsQuery.data ?? []
  const fallbackCapability = workflowDefaults.capabilityId
    && capabilityId === workflowDefaults.capabilityId
    && !capabilities.some(capability => capability.id === workflowDefaults.capabilityId)
      ? { id: workflowDefaults.capabilityId, name: 'Workflow capability' } as LookupCapability
      : null

  useEffect(() => {
    const hydrated = hydrateDefaultsFromWorkflow(workflowInstanceQuery.data, workflowDefaults.workflowNodeId) ?? workflowFallbackQuery.data
    if (!hydrated) return
    if (hydrated.goal) setGoal(current => current === defaultWorkbenchGoal || !current.trim() ? hydrated.goal! : current)
    if (hydrated.sourceUri) setSourceUri(current => current || hydrated.sourceUri!)
    if (hydrated.sourceType === 'github' || hydrated.sourceType === 'localdir') setSourceType(hydrated.sourceType)
    if (hydrated.sourceRef) setSourceRef(current => current || hydrated.sourceRef!)
    if (hydrated.capabilityId) setCapabilityId(current => current || hydrated.capabilityId!)
    if (hydrated.gateMode === 'auto' || hydrated.gateMode === 'manual') setGateMode(hydrated.gateMode)
    if (hydrated.architectAgentTemplateId) setArchitectAgentTemplateId(current => current || hydrated.architectAgentTemplateId!)
    if (hydrated.developerAgentTemplateId) setDeveloperAgentTemplateId(current => current || hydrated.developerAgentTemplateId!)
    if (hydrated.qaAgentTemplateId) setQaAgentTemplateId(current => current || hydrated.qaAgentTemplateId!)
    if (hydrated.loopDefinition) {
      setLoopDefinition(current => current ?? hydrated.loopDefinition)
      if (typeof hydrated.loopDefinition.maxLoopsPerStage === 'number') setMaxLoopsPerStage(hydrated.loopDefinition.maxLoopsPerStage)
      if (typeof hydrated.loopDefinition.maxTotalSendBacks === 'number') setMaxTotalSendBacks(hydrated.loopDefinition.maxTotalSendBacks)
    }
  }, [workflowFallbackQuery.data, workflowInstanceQuery.data, workflowDefaults.workflowNodeId])

  useEffect(() => {
    if (!activeSession) return
    if (typeof activeSession.loopDefinition?.maxLoopsPerStage === 'number') setMaxLoopsPerStage(activeSession.loopDefinition.maxLoopsPerStage)
    if (typeof activeSession.loopDefinition?.maxTotalSendBacks === 'number') setMaxTotalSendBacks(activeSession.loopDefinition.maxTotalSendBacks)
    const config = activeSession.executionConfig ?? activeSession.metadata?.executionConfig
    if (!config) return
    if (config.snapshotMode) setSnapshotMode(config.snapshotMode)
    if (typeof config.excerptBudgetChars === 'number') setExcerptBudgetChars(config.excerptBudgetChars)
    if (typeof config.reuseUnchangedAttempt === 'boolean') setReuseUnchangedAttempt(config.reuseUnchangedAttempt)
    if (config.governanceMode) setGovernanceMode(config.governanceMode)
    setModelAlias(config.modelAlias ?? '')
    if (typeof config.maxContextTokens === 'number') setMaxContextTokens(config.maxContextTokens)
    if (typeof config.maxOutputTokens === 'number') setMaxOutputTokens(config.maxOutputTokens)
    if (typeof config.maxPromptChars === 'number') setMaxPromptChars(config.maxPromptChars)
    if (typeof config.maxLayerChars === 'number') setMaxLayerChars(config.maxLayerChars)
  }, [activeSession?.id])

  useEffect(() => {
    if (workflowDefaults.capabilityId) {
      setCapabilityId(workflowDefaults.capabilityId)
      return
    }
    if (!capabilityId && capabilities[0]) setCapabilityId(capabilities[0].id)
  }, [capabilityId, capabilities, workflowDefaults.capabilityId])

  useEffect(() => {
    if (workflowDefaults.architectAgentTemplateId || workflowDefaults.developerAgentTemplateId || workflowDefaults.qaAgentTemplateId) return
    if (!agents[0]) return
    setArchitectAgentTemplateId(v => v || preferredAgent(agents, 'architect')?.id || agents[0].id)
    setDeveloperAgentTemplateId(v => v || preferredAgent(agents, 'developer')?.id || agents[0].id)
    setQaAgentTemplateId(v => v || preferredAgent(agents, 'qa')?.id || agents[0].id)
  }, [agents, workflowDefaults.architectAgentTemplateId, workflowDefaults.developerAgentTemplateId, workflowDefaults.qaAgentTemplateId])

  const createMutation = useMutation({
    mutationFn: (body: CreateSessionRequest) => api.createSession(body),
    onSuccess: onCreated,
  })
  const settingsMutation = useMutation({
    mutationFn: (body: WorkbenchExecutionConfig & { maxLoopsPerStage?: number; maxTotalSendBacks?: number }) => {
      if (!activeSession) throw new Error('Select or start a session before saving settings.')
      return api.updateSettings(activeSession.id, body)
    },
    onSuccess: onCreated,
  })

  const runtimeSettings = (): WorkbenchExecutionConfig & { maxLoopsPerStage: number; maxTotalSendBacks: number } => ({
    maxLoopsPerStage,
    maxTotalSendBacks,
    snapshotMode,
    excerptBudgetChars,
    reuseUnchangedAttempt,
    governanceMode,
    modelAlias: modelAlias.trim(),
    maxContextTokens,
    maxOutputTokens,
    maxPromptChars,
    maxLayerChars,
  })

  const loopAgentReady = hasLoopAgentTemplates(loopDefinition)
  const canCreate = goal.trim().length > 7
    && sourceUri.trim()
    && capabilityId
    && (loopAgentReady || architectAgentTemplateId || developerAgentTemplateId || qaAgentTemplateId)

  return (
    <aside className="panel setup-panel">
      <div className="panel-heading">
        <Boxes size={18} />
        <div>
          <h2>Guided Delivery Intake</h2>
          <p>Enter the story once. Singularity resolves source, agents, stages, artifacts, and approval gates.</p>
        </div>
      </div>

      <div className="delivery-intake-steps" aria-label="Story-to-delivery flow">
        {[
          ['Story', 'Capture goal and source'],
          ['Agents', 'Bind capability team'],
          ['Artifacts', 'Produce stage evidence'],
          ['Gates', 'Approve or send back'],
          ['Handoff', 'Finalize consumables'],
        ].map(([title, body], index) => (
          <div key={title} className="delivery-intake-step">
            <span>{index + 1}</span>
            <strong>{title}</strong>
            <em>{body}</em>
          </div>
        ))}
      </div>

      {sessions.length > 0 && (
        <label>
          <span>Recent sessions</span>
          <select
            value={activeSession?.id ?? ''}
            onChange={event => {
              const selected = sessions.find(session => session.id === event.target.value)
              if (selected) onSelect(selected)
            }}
          >
            {sessions.map(session => <option key={session.id} value={session.id}>{sessionOptionLabel(session)}</option>)}
          </select>
        </label>
      )}

      <label>
        <span>Goal</span>
        <textarea value={goal} onChange={event => setGoal(event.target.value)} rows={4} />
      </label>

      <div className="segmented">
        <button className={sourceType === 'localdir' ? 'active' : ''} onClick={() => setSourceType('localdir')} type="button">
          <HardDrive size={14} /> Local dir
        </button>
        <button className={sourceType === 'github' ? 'active' : ''} onClick={() => setSourceType('github')} type="button">
          <GitBranch size={14} /> GitHub
        </button>
      </div>

      <label>
        <span>{sourceType === 'github' ? 'GitHub URL' : 'Local directory'}</span>
        <input
          value={sourceUri}
          onChange={event => setSourceUri(event.target.value)}
          placeholder={sourceType === 'github' ? 'https://github.com/org/repo' : '/path/visible/to/workgraph-api'}
        />
      </label>

      <div className="two-col">
        <label>
          <span>Branch / ref</span>
          <input value={sourceRef} onChange={event => setSourceRef(event.target.value)} placeholder="optional" />
        </label>
        <label>
          <span>Gate mode</span>
          <select value={gateMode} onChange={event => setGateMode(event.target.value as GateMode)}>
            <option value="manual">Manual gates</option>
            <option value="auto">Conservative auto gates</option>
          </select>
        </label>
      </div>

      <div className="two-col">
        <label>
          <span>Include globs</span>
          <input value={includeGlobs} onChange={event => setIncludeGlobs(event.target.value)} placeholder="optional" />
        </label>
        <label>
          <span>Exclude globs</span>
          <input value={excludeGlobs} onChange={event => setExcludeGlobs(event.target.value)} />
        </label>
      </div>

      <label>
        <span>Capability</span>
        <select value={capabilityId} onChange={event => setCapabilityId(event.target.value)}>
          <option value="">{capabilitiesQuery.isLoading ? 'Loading...' : 'Select capability'}</option>
          {fallbackCapability && <option value={fallbackCapability.id}>{capLabel(fallbackCapability)} · from workflow</option>}
          {capabilities.map(capability => <option key={capability.id} value={capability.id}>{capLabel(capability)}</option>)}
        </select>
      </label>

      <div className="agent-grid">
        <AgentSelect label="Architect" role="architect" agents={agents} value={architectAgentTemplateId} onChange={setArchitectAgentTemplateId} />
        <AgentSelect label="Developer" role="developer" agents={agents} value={developerAgentTemplateId} onChange={setDeveloperAgentTemplateId} />
        <AgentSelect label="QA" role="qa" agents={agents} value={qaAgentTemplateId} onChange={setQaAgentTemplateId} />
      </div>

      <section className="settings-section" aria-label="Workbench runtime settings">
        <div className="settings-section-title">
          <Settings size={15} />
          <div>
            <strong>Runtime limits</strong>
            <span>Controls loops, prompt size, context budget, and model routing for this delivery session.</span>
          </div>
        </div>
        <div className="two-col compact-fields">
          <label>
            <span>Max loops / stage</span>
            <input type="number" min={1} max={50} value={maxLoopsPerStage} onChange={event => setMaxLoopsPerStage(Number(event.target.value) || 1)} />
          </label>
          <label>
            <span>Max send-backs</span>
            <input type="number" min={0} max={200} value={maxTotalSendBacks} onChange={event => setMaxTotalSendBacks(Number(event.target.value) || 0)} />
          </label>
        </div>
        <div className="two-col compact-fields">
          <label>
            <span>Context tokens</span>
            <input type="number" min={1000} max={200000} step={500} value={maxContextTokens} onChange={event => setMaxContextTokens(Number(event.target.value) || 6000)} />
          </label>
          <label>
            <span>Output tokens</span>
            <input type="number" min={128} max={32000} step={100} value={maxOutputTokens} onChange={event => setMaxOutputTokens(Number(event.target.value) || 1200)} />
          </label>
        </div>
        <div className="two-col compact-fields">
          <label>
            <span>Prompt chars</span>
            <input type="number" min={2000} max={500000} step={1000} value={maxPromptChars} onChange={event => setMaxPromptChars(Number(event.target.value) || 24000)} />
          </label>
          <label>
            <span>Layer chars</span>
            <input type="number" min={500} max={100000} step={250} value={maxLayerChars} onChange={event => setMaxLayerChars(Number(event.target.value) || 2000)} />
          </label>
        </div>
        <div className="two-col compact-fields">
          <label>
            <span>Snapshot mode</span>
            <select value={snapshotMode} onChange={event => setSnapshotMode(event.target.value as SnapshotMode)}>
              <option value="summary">Summary only</option>
              <option value="relevant_excerpts">Relevant excerpts</option>
              <option value="full_debug">Full debug</option>
            </select>
          </label>
          <label>
            <span>Snapshot chars</span>
            <input type="number" min={2000} max={120000} step={1000} value={excerptBudgetChars} onChange={event => setExcerptBudgetChars(Number(event.target.value) || 18000)} />
          </label>
        </div>
        <div className="two-col compact-fields">
          <label>
            <span>Governance</span>
            <select value={governanceMode} onChange={event => setGovernanceMode(event.target.value as GovernanceMode)}>
              <option value="fail_open">Fail open</option>
              <option value="human_approval_required">Human approval</option>
              <option value="degraded">Degraded only</option>
              <option value="fail_closed">Fail closed</option>
            </select>
          </label>
          <label>
            <span>Model alias</span>
            <input value={modelAlias} onChange={event => setModelAlias(event.target.value)} placeholder="default from MCP" />
          </label>
        </div>
        <label className="checkbox-row">
          <input type="checkbox" checked={reuseUnchangedAttempt} onChange={event => setReuseUnchangedAttempt(event.target.checked)} />
          <span>Reuse unchanged stage attempts</span>
        </label>
        <p className="muted-hint">Increase “Max loops / stage” when a stage needs more than three review/rework cycles. Lower prompt limits to force smaller, cheaper prompts.</p>
        {settingsMutation.isError && <p className="error-text">{settingsMutation.error.message}</p>}
        {settingsMutation.isSuccess && <p className="success-text">Runtime settings saved for this session.</p>}
        <button
          className="secondary-action full-width"
          type="button"
          disabled={!activeSession || settingsMutation.isPending}
          onClick={() => settingsMutation.mutate(runtimeSettings())}
        >
          {settingsMutation.isPending ? <Loader2 className="spin" size={16} /> : <Settings size={16} />}
          Save settings for current session
        </button>
      </section>

      {createMutation.isError && <p className="error-text">{createMutation.error.message}</p>}
      <button
        className="primary-action"
        disabled={!canCreate || createMutation.isPending}
        onClick={() => createMutation.mutate({
          goal,
          sourceType,
          sourceUri,
          sourceRef: sourceRef || undefined,
          includeGlobs: csv(includeGlobs),
          excludeGlobs: csv(excludeGlobs),
          capabilityId,
          architectAgentTemplateId: architectAgentTemplateId || undefined,
          developerAgentTemplateId: developerAgentTemplateId || undefined,
          qaAgentTemplateId: qaAgentTemplateId || undefined,
          gateMode,
          workflowInstanceId: workflowDefaults.workflowInstanceId,
          workflowNodeId: workflowDefaults.workflowNodeId,
          phaseId: workflowDefaults.phaseId,
          loopDefinition: loopDefinition
            ? { ...loopDefinition, maxLoopsPerStage, maxTotalSendBacks }
            : undefined,
          ...runtimeSettings(),
        })}
      >
        {createMutation.isPending ? <Loader2 className="spin" size={16} /> : <Sparkles size={16} />}
        Start guided delivery
      </button>
    </aside>
  )
}

function LoopWorkbench({
  session,
  activeSection,
  onSession,
}: {
  session: BlueprintSession | null
  activeSection: WorkbenchSection
  onSession: (session: BlueprintSession) => void
}) {
  const [activeStageKey, setActiveStageKey] = useState<string | null>(null)
  const stages = session?.loopDefinition?.stages ?? []
  const firstStageKey = stages[0]?.key ?? null

  useEffect(() => {
    if (!session) {
      setActiveStageKey(null)
      return
    }
    setActiveStageKey(session.currentStageKey ?? firstStageKey)
  }, [session?.id, session?.currentStageKey, firstStageKey])

  const activeStage = stages.find(stage => stage.key === activeStageKey) ?? stages[0]
  const activeAttempt = session && activeStage ? attemptsFor(session, activeStage.key).at(-1) : undefined
  const showTopCodeReview = Boolean(activeStage && activeAttempt && isDeveloperStage(activeStage))

  if (!session) {
    return (
      <section className="empty-workbench">
        <Activity size={30} />
        <h2>Start with a story</h2>
        <p>Create or select a guided delivery session. The system will map the story to agents, stages, artifacts, approval gates, and final consumables.</p>
      </section>
    )
  }

  if (activeSection === 'artifacts') {
    return (
      <section className="focused-workbench-view artifacts-view">
        <AssetRail session={session} onSession={onSession} />
      </section>
    )
  }

  if (activeSection === 'terminal') {
    return (
      <section className="focused-workbench-view terminal-view">
        <WorkbenchTerminal session={session} />
      </section>
    )
  }

  return (
    <>
      <DeliveryCockpit session={session} activeStage={activeStage} onStage={setActiveStageKey} />
      {showTopCodeReview && activeStage && activeAttempt && (
        <section className="workbench-code-review-dock" aria-label="Developer code review">
          <DeveloperCodeReview session={session} stage={activeStage} latest={activeAttempt} layout="wide" />
        </section>
      )}
      <section className="control-room-grid">
        <CyclicLoopCanvas session={session} activeStageKey={activeStage?.key ?? null} onStage={setActiveStageKey} onSession={onSession} />
        <StageDetailsPanel session={session} stage={activeStage} onSession={onSession} />
        <AssetRail session={session} activeStageKey={activeStage?.key} onSession={onSession} />
        <WorkbenchTerminal session={session} />
      </section>
    </>
  )
}

function DeliveryCockpit({
  session,
  activeStage,
  onStage,
}: {
  session: BlueprintSession
  activeStage?: LoopStage
  onStage: (stageKey: string) => void
}) {
  const stages = session.loopDefinition?.stages ?? []
  const requiredStages = stages.filter(stage => stage.required !== false)
  const approvedStages = requiredStages.filter(stage => {
    const latest = attemptsFor(session, stage.key).at(-1)
    return latest?.verdict === 'PASS' || latest?.verdict === 'ACCEPTED_WITH_RISK'
  }).length
  const producedArtifacts = session.artifacts.length
  const consumables = collectStageConsumables(session).length
  const nextStage = stages.find(stage => stage.key === session.currentStageKey) ?? activeStage ?? stages[0]
  const finalReady = isLoopGreen(session)

  return (
    <section className="delivery-cockpit" aria-label="Story delivery cockpit">
      <div className="delivery-story-card">
        <span className="stage-key">Story</span>
        <h2>{session.goal}</h2>
        <p>
          {session.sourceType} source {session.sourceUri}
          {session.sourceRef ? ` @ ${session.sourceRef}` : ''} · {session.gateMode === 'auto' ? 'conservative auto gates' : 'manual approval gates'}
        </p>
      </div>
      <div className="delivery-summary-grid">
        <DeliveryMetric label="Next action" value={nextStage?.label ?? 'Finalize'} tone="primary" />
        <DeliveryMetric label="Approved gates" value={`${approvedStages}/${requiredStages.length}`} tone={finalReady ? 'ok' : 'default'} />
        <DeliveryMetric label="Artifacts" value={String(producedArtifacts)} />
        <DeliveryMetric label="Consumables" value={String(consumables)} tone={consumables > 0 ? 'ok' : 'default'} />
      </div>
      <div className="delivery-stage-plan">
        {stages.map(stage => {
          const latest = attemptsFor(session, stage.key).at(-1)
          const status = latestStatus(latest)
          const Icon = roleMeta(stage.agentRole).icon
          return (
            <button
              key={stage.key}
              type="button"
              className={`delivery-stage-chip ${activeStage?.key === stage.key ? 'active' : ''} ${status}`}
              onClick={() => onStage(stage.key)}
            >
              <Icon size={14} />
              <span>{stage.label}</span>
              <em>{roleMeta(stage.agentRole).label}</em>
              {stage.approvalRequired !== false && <strong>Gate</strong>}
            </button>
          )
        })}
      </div>
    </section>
  )
}

function DeliveryMetric({ label, value, tone = 'default' }: { label: string; value: string; tone?: 'default' | 'primary' | 'ok' }) {
  return (
    <div className={`delivery-metric ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function CyclicLoopCanvas({
  session,
  activeStageKey,
  onStage,
  onSession,
}: {
  session: BlueprintSession
  activeStageKey: string | null
  onStage: (stageKey: string) => void
  onSession: (session: BlueprintSession) => void
}) {
  const snapshotMutation = useMutation({ mutationFn: (id: string) => api.snapshot(id), onSuccess: onSession })
  const latestSnapshot = session.snapshots[0]
  const green = isLoopGreen(session)
  const stages = session.loopDefinition?.stages ?? []
  const currentStage = stages.find(stage => stage.key === session.currentStageKey)
  const latestCurrent = currentStage ? attemptsFor(session, currentStage.key).at(-1) : undefined
  const recentSendBack = [...(session.reviewEvents ?? [])].reverse().find(event => event.type === 'SEND_BACK' || event.type === 'AUTO_SEND_BACK')
  return (
    <section className="control-card cycle-card">
      <div className="canvas-header">
        <div>
          <h2>{session.loopDefinition?.name ?? 'Blueprint implementation loop'}</h2>
          <div className="header-meta">
            <span className={`status ${session.status.toLowerCase()}`}>{session.status}</span>
            <span>{session.gateMode === 'auto' ? 'Conservative auto gates' : 'Manual gates'}</span>
            <span>{session.sourceType}</span>
          </div>
        </div>
        <div className="loop-actions">
          <button className="secondary-action compact-action" disabled={snapshotMutation.isPending} onClick={() => snapshotMutation.mutate(session.id)}>
            {snapshotMutation.isPending ? <Loader2 className="spin" size={15} /> : <ScanSearch size={15} />}
            Snapshot
          </button>
          {latestSnapshot && <span className="snapshot-pill">{latestSnapshot.fileCount} files · {formatBytes(latestSnapshot.totalBytes)}</span>}
        </div>
      </div>
      {snapshotMutation.isError && <p className="error-text">{snapshotMutation.error.message}</p>}

      <div className="cycle-canvas">
        <div className="grid-dots" />
        <svg className="cycle-lines" viewBox="0 0 800 560" aria-hidden="true">
          <defs>
            <marker id="arrow-muted" markerHeight="7" markerWidth="10" orient="auto" refX="8" refY="3.5">
              <polygon fill="#424754" points="0 0, 10 3.5, 0 7" />
            </marker>
            <marker id="arrow-hot" markerHeight="7" markerWidth="10" orient="auto" refX="8" refY="3.5">
              <polygon fill="#ffb786" points="0 0, 10 3.5, 0 7" />
            </marker>
          </defs>
          <path d="M 150 280 Q 160 120 315 92" />
          <path d="M 350 78 Q 400 48 455 78" />
          <path d="M 520 108 Q 660 150 682 280" />
          <path d="M 675 320 Q 630 465 430 488" />
          <path d="M 370 488 Q 170 465 128 320" />
          {recentSendBack?.stageKey && recentSendBack.targetStageKey && (
            <path className="sendback-line" d="M 500 88 Q 400 30 300 88" markerEnd="url(#arrow-hot)" />
          )}
        </svg>

        <div className="core-console">
          <div className="console-top">
            <span className="live-dot" />
            <code>VALIDATION_STREAM: {latestCurrent?.status?.toLowerCase() ?? 'idle'}</code>
          </div>
          <div className="console-body">
            <p className="log-warn">[STAGE] {currentStage?.label ?? 'No active stage'} · {latestCurrent?.verdict ?? latestCurrent?.status ?? 'waiting'}</p>
            <p className="log-info">&gt;&gt; {session.goal}</p>
            <div className="comparison-box">
              <div>
                <span>EXPECTED</span>
                <strong>{green ? 'Loop green' : 'Stage gate'}</strong>
              </div>
              <div>
                <span>ACTUAL</span>
                <strong className={green ? 'ok' : 'warn'}>{green ? 'Ready' : 'Pending'}</strong>
              </div>
            </div>
            <p>&gt;&gt; Source: {session.sourceUri}</p>
            <p>&gt;&gt; Latest evidence: {latestCurrent?.correlation?.cfCallId ?? latestCurrent?.id ?? 'none'}</p>
          </div>
        </div>

        {stages.map((stage, index) => {
          const attempts = attemptsFor(session, stage.key)
          const latest = attempts.at(-1)
          const status = latestStatus(latest)
          const Icon = roleMeta(stage.agentRole).icon
          const nodeClass = `cycle-node node-${index} ${activeStageKey === stage.key ? 'active' : ''} ${session.currentStageKey === stage.key ? 'current' : ''} ${status}`
          return (
            <button
              type="button"
              key={stage.key}
              className={nodeClass}
              onClick={() => onStage(stage.key)}
            >
              <span className="node-orb"><Icon size={index === stages.findIndex(item => item.key === session.currentStageKey) ? 28 : 22} /></span>
              <span className="node-label">{stage.label}</span>
              <span className="node-actions">
                <small>{attempts.length || 0} iter</small>
                <small>{latest?.verdict ? verdictLabels[latest.verdict] : latest?.status ?? 'Ready'}</small>
              </span>
            </button>
          )
        })}
      </div>

      <div className="session-status-strip">
        <div>
          <strong>{green ? 'Loop is green' : 'Loop is not green yet'}</strong>
          <span>{green ? 'Final pack can be generated.' : 'Each required stage needs a pass or accepted-risk verdict.'}</span>
        </div>
        <BadgeCheck size={18} />
      </div>
    </section>
  )
}

function StageDetailsPanel({
  session,
  stage,
  onSession,
}: {
  session: BlueprintSession
  stage?: LoopStage
  onSession: (session: BlueprintSession) => void
}) {
  const [answers, setAnswers] = useState<Record<string, DecisionAnswer>>({})
  const [feedback, setFeedback] = useState('')
  const [acceptRisk, setAcceptRisk] = useState(false)
  const [sendBackTarget, setSendBackTarget] = useState('')
  const [sendBackReason, setSendBackReason] = useState('')
  const [requiredChanges, setRequiredChanges] = useState('')

  useEffect(() => {
    setAnswers(Object.fromEntries((session.decisionAnswers ?? []).map(answer => [answer.questionId, answer])))
  }, [session.id, session.decisionAnswers])

  useEffect(() => {
    setFeedback('')
    setSendBackTarget(stage?.allowedSendBackTo?.[0] ?? '')
    setSendBackReason('')
    setRequiredChanges('')
    setAcceptRisk(false)
  }, [stage?.key])

  const runMutation = useMutation({
    mutationFn: () => {
      if (!stage) throw new Error('No stage selected')
      if (!session.snapshots[0]) {
        return api.snapshot(session.id).then(() => api.runStage(session.id, stage.key))
      }
      return api.runStage(session.id, stage.key)
    },
    onSuccess: onSession,
  })
  const verdictMutation = useMutation({
    mutationFn: (verdict: LoopVerdict) => {
      if (!stage) throw new Error('No stage selected')
      return api.verdict(session.id, stage.key, {
        verdict,
        feedback: feedback.trim() || undefined,
        acceptRisk,
        answers: answerList(answers),
      })
    },
    onSuccess: onSession,
  })
  const sendBackMutation = useMutation({
    mutationFn: () => {
      if (!stage) throw new Error('No stage selected')
      return api.sendBack(session.id, stage.key, {
        targetStageKey: sendBackTarget,
        reason: sendBackReason,
        requiredChanges: requiredChanges.trim() || undefined,
      })
    },
    onSuccess: onSession,
  })

  if (!stage) {
    return <section className="control-card stage-details-panel"><p className="empty">No stage selected.</p></section>
  }

  const latest = attemptsFor(session, stage.key).at(-1)
  const canRun = latest?.status !== 'RUNNING'
  const stageCompleted = latest?.verdict === 'PASS' || latest?.verdict === 'ACCEPTED_WITH_RISK'
  const requiredMissing = (stage.questions ?? [])
    .filter(question => question.required && !hasAnswer(answers[question.id]))
    .map(question => question.id)

  return (
    <aside className="control-card stage-details-panel">
      <div className="panel-heading">
        {(() => {
          const Icon = roleMeta(stage.agentRole).icon
          return <Icon size={18} />
        })()}
        <div>
          <h2>Stage Details</h2>
          <p>{stage.label} · {roleMeta(stage.agentRole).label}</p>
        </div>
      </div>

      <div className="anomaly-card">
        <div>
          <span className="stage-key">{stage.key}</span>
          <h3>{stage.label}</h3>
          <p>{stage.description}</p>
        </div>
        <button className="primary-action compact" disabled={!canRun || runMutation.isPending} onClick={() => runMutation.mutate()}>
          {runMutation.isPending ? <Loader2 className="spin" size={15} /> : <Play size={15} />}
          {session.snapshots[0] ? 'Run stage' : 'Snapshot + run'}
        </button>
      </div>

      {!session.snapshots[0] && <p className="warning-text">No snapshot yet. Running this stage will snapshot the source first.</p>}
      {(runMutation.error || verdictMutation.error || sendBackMutation.error) && (
        <p className="error-text">{(runMutation.error ?? verdictMutation.error ?? sendBackMutation.error)?.message}</p>
      )}

      <div className="metric-grid">
        <div className="metric-card">
          <span>Confidence</span>
          <strong>{latest?.gateRecommendation?.confidence ? `${Math.round(latest.gateRecommendation.confidence * 100)}%` : '--'}</strong>
          <div className="meter"><i style={{ width: `${Math.round((latest?.gateRecommendation?.confidence ?? 0) * 100)}%` }} /></div>
        </div>
        <div className="metric-card">
          <span>Iterations</span>
          <strong>#{attemptsFor(session, stage.key).length}</strong>
          <div className="meter amber"><i style={{ width: `${Math.min(attemptsFor(session, stage.key).length * 22, 100)}%` }} /></div>
        </div>
      </div>

      <div className="attempt-card">
        <strong>Latest attempt</strong>
        {latest ? (
          <>
            <span className={`status ${latestStatus(latest)}`}>{latest.verdict ? verdictLabels[latest.verdict] : latest.status}</span>
            <p>{latest.gateRecommendation?.reason ?? latest.error ?? 'Awaiting human verdict.'}</p>
            {latest.status === 'COMPLETED' && !latest.verdict && stage.approvalRequired !== false && (
              <p className="warning-text">Review the artifacts, then mark this stage complete or send it back.</p>
            )}
            {stageCompleted && <p className="success-text">Stage completed. The workflow can continue to the next stage.</p>}
            {latest.correlation && <code>{latest.correlation.cfCallId ?? latest.correlation.traceId ?? latest.id}</code>}
          </>
        ) : (
          <p>No attempt yet. Run this stage to generate artifacts and a gate recommendation.</p>
        )}
      </div>

      {(stage.expectedArtifacts ?? []).length > 0 && (
        <div className="attempt-card">
          <strong>Expected artifacts</strong>
          {(stage.expectedArtifacts ?? []).map(artifact => (
            <p key={`${artifact.kind}-${artifact.title}`}>
              <code>{artifact.kind}</code> {artifact.title}{artifact.required !== false ? ' · approval item' : ''}
            </p>
          ))}
        </div>
      )}

      <div className="question-stack">
        {(stage.questions ?? []).map(question => (
          <section className="question-card" key={question.id}>
            <div>
              <strong>{question.question}</strong>
              <code>{question.id}{question.required ? ' · required' : ''}</code>
            </div>
            {question.options && question.options.length > 0 && (
              <div className="option-grid">
                {question.options.map(option => (
                  <button
                    type="button"
                    key={option.label}
                    className={`option-card ${answers[question.id]?.selectedOptionLabel === option.label ? 'selected' : ''}`}
                    onClick={() => setAnswers(current => ({
                      ...current,
                      [question.id]: {
                        questionId: question.id,
                        answerType: 'option',
                        selectedOptionLabel: option.label,
                        notes: current[question.id]?.notes,
                      },
                    }))}
                  >
                    <strong>{option.label}</strong>
                    {option.recommended && <span>recommended</span>}
                    {option.impact && <p>{option.impact}</p>}
                  </button>
                ))}
              </div>
            )}
            {question.freeform !== false && (
              <textarea
                rows={2}
                value={answers[question.id]?.customAnswer ?? ''}
                onChange={event => setAnswers(current => ({
                  ...current,
                  [question.id]: {
                    questionId: question.id,
                    answerType: 'freeform',
                    customAnswer: event.target.value,
                    notes: current[question.id]?.notes,
                  },
                }))}
                placeholder="Free-form answer, constraints, or stakeholder note"
              />
            )}
          </section>
        ))}
      </div>

      <label>
        <span>Review feedback</span>
        <textarea rows={3} value={feedback} onChange={event => setFeedback(event.target.value)} placeholder="Why this passes, what risk is accepted, or what must change." />
      </label>

      {requiredMissing.length > 0 && (
        <label className="risk-toggle">
          <input type="checkbox" checked={acceptRisk} onChange={event => setAcceptRisk(event.target.checked)} />
          <span>Accept risk and continue with unanswered required questions: {requiredMissing.join(', ')}</span>
        </label>
      )}

      <div className="verdict-row">
        <button className="secondary-action approve" disabled={!latest || verdictMutation.isPending} onClick={() => verdictMutation.mutate('PASS')}>
          <CheckCircle2 size={15} /> {stageCompleted ? 'Stage completed' : 'Mark stage complete'}
        </button>
        <button className="secondary-action" disabled={!latest || verdictMutation.isPending} onClick={() => verdictMutation.mutate('ACCEPTED_WITH_RISK')}>
          <AlertTriangle size={15} /> Accept risk
        </button>
        <button className="secondary-action danger" disabled={!latest || verdictMutation.isPending} onClick={() => verdictMutation.mutate('NEEDS_REWORK')}>
          <Undo2 size={15} /> Mark bad
        </button>
      </div>

      {(stage.allowedSendBackTo ?? []).length > 0 && (
        <div className="send-back-box">
          <div className="send-back-title">
            <ArrowDownLeft size={15} />
            <strong>Bad, go back</strong>
          </div>
          <div className="two-col">
            <label>
              <span>Target stage</span>
              <select value={sendBackTarget} onChange={event => setSendBackTarget(event.target.value)}>
                {(stage.allowedSendBackTo ?? []).map(key => (
                  <option key={key} value={key}>{stageLabel(session, key)}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Reason</span>
              <input value={sendBackReason} onChange={event => setSendBackReason(event.target.value)} placeholder="What failed?" />
            </label>
          </div>
          <label>
            <span>Required changes</span>
            <textarea rows={2} value={requiredChanges} onChange={event => setRequiredChanges(event.target.value)} placeholder="What must the earlier stage fix before coming back?" />
          </label>
          <button className="secondary-action danger" disabled={!sendBackTarget || sendBackReason.trim().length < 3 || sendBackMutation.isPending} onClick={() => sendBackMutation.mutate()}>
            {sendBackMutation.isPending ? <Loader2 className="spin" size={15} /> : <ArrowDownLeft size={15} />}
            Send back
          </button>
        </div>
      )}
    </aside>
  )
}

type DiffLineKind = 'add' | 'remove' | 'meta' | 'context'

type ReviewDiffLine = {
  kind: DiffLineKind
  text: string
  lineNo?: number
}

type ReviewFile = {
  id: string
  path: string
  source: 'mcp' | 'artifact'
  status: string
  additions?: number
  deletions?: number
  commitSha?: string
  hasDiff?: boolean
  diffLines: ReviewDiffLine[]
}

function DeveloperCodeReview({
  session,
  stage,
  latest,
  layout = 'embedded',
}: {
  session: BlueprintSession
  stage: LoopStage
  latest: StageAttempt
  layout?: 'embedded' | 'wide'
}) {
  const [activeFileId, setActiveFileId] = useState<string | null>(null)
  const codeChangesQuery = useQuery({
    queryKey: ['blueprintCodeChanges', session.id, stage.key, latest.id],
    queryFn: () => api.codeChanges(session.id, stage.key),
    enabled: Boolean(latest),
    refetchInterval: latest.status === 'RUNNING' ? 3000 : false,
    retry: 1,
  })
  const files = useMemo(
    () => buildReviewFiles(session, stage.key, codeChangesQuery.data?.items ?? []),
    [session, stage.key, codeChangesQuery.data?.items],
  )
  const activeFile = files.find(file => file.id === activeFileId) ?? files[0]

  useEffect(() => {
    setActiveFileId(current => current && files.some(file => file.id === current) ? current : files[0]?.id ?? null)
  }, [files])

  const hasMcpDiff = files.some(file => file.source === 'mcp' && file.hasDiff)
  const hasAnyCapturedMcp = files.some(file => file.source === 'mcp')
  const status = latest.verdict ? verdictLabels[latest.verdict] : latest.status
  const totals = reviewTotals(files)
  const activeStats = activeFile ? reviewFileStats(activeFile) : { additions: 0, deletions: 0, total: 0 }

  return (
    <section className={`code-review-panel ${layout === 'wide' ? 'wide-review' : ''}`}>
      <div className="code-review-header">
        <div>
          <span className="stage-key">Developer approval</span>
          <h3><FileCode2 size={16} /> Code review</h3>
          <p>Review changed files and highlighted diffs before approving or sending work back.</p>
        </div>
        <span className={`status ${latestStatus(latest)}`}>{status}</span>
      </div>

      <div className="code-review-stats" aria-label="Developer review summary">
        <span><FileCode2 size={13} /> {files.length} changed file{files.length === 1 ? '' : 's'}</span>
        <span className="stat-add">+{totals.additions}</span>
        <span className="stat-remove">-{totals.deletions}</span>
        <span>{hasMcpDiff ? 'Actual MCP/git diff' : 'No actual diff'}</span>
      </div>

      {codeChangesQuery.isError && (
        <p className="code-review-warning">
          <AlertTriangle size={14} />
          MCP code-change lookup failed. This screen only treats MCP/git records as actual code changes.
        </p>
      )}

      {hasAnyCapturedMcp && !hasMcpDiff && (
        <p className="code-review-warning">
          <AlertTriangle size={14} />
          MCP reported a code-change record, but no diff body was available. Review the commit/paths and rerun if a patch is required for approval.
        </p>
      )}

      {codeChangesQuery.isLoading && files.length === 0 ? (
        <div className="code-review-empty"><Loader2 className="spin" size={15} /> Loading code-change evidence...</div>
      ) : files.length === 0 ? (
        <div className="code-review-empty">
          <FileCode2 size={18} />
          <span>No actual MCP/git code change was captured for this attempt. Re-run the Developer stage with a writable MCP workspace and a tool-capable model alias, then approve from the captured diff.</span>
        </div>
      ) : (
        <div className="vscode-review-shell">
          <aside className="vscode-review-activity" aria-label="Review activity rail">
            <span className="active"><FileCode2 size={17} /></span>
            <span><GitBranch size={17} /></span>
            <span><ShieldCheck size={17} /></span>
          </aside>

          <nav className="vscode-review-explorer" aria-label="Changed files">
            <div className="vscode-explorer-title">
              <span>Changes</span>
              <strong>{files.length}</strong>
            </div>
            {files.map(file => (
              <ReviewFileButton
                key={file.id}
                file={file}
                active={file.id === activeFile?.id}
                onClick={() => setActiveFileId(file.id)}
              />
            ))}
          </nav>

          <article className="vscode-review-editor">
            <div className="vscode-editor-tabs">
              <button type="button" className="active">
                <FileCode2 size={13} />
                <span>{activeFile?.path ?? 'diff'}</span>
              </button>
            </div>

            <div className="vscode-editor-toolbar">
              <span>{activeFile?.path}</span>
              <em>{activeFile?.source === 'mcp' ? 'actual MCP/git diff' : 'proposed artifact patch'}</em>
            </div>

            {activeFile?.commitSha && (
              <div className="editor-commit">
                <GitBranch size={13} />
                <code>{activeFile.commitSha}</code>
              </div>
            )}

            <div className="vscode-review-guidance">
              <div>
                <strong>{activeStats.total}</strong>
                <span>review lines</span>
              </div>
              <div className="stat-add">
                <strong>+{activeStats.additions}</strong>
                <span>added</span>
              </div>
              <div className="stat-remove">
                <strong>-{activeStats.deletions}</strong>
                <span>removed</span>
              </div>
              <div>
                <strong>{activeFile?.status ?? 'pending'}</strong>
                <span>evidence status</span>
              </div>
            </div>

            <div className="vscode-diff-code" role="region" aria-label="Code diff">
              {(activeFile?.diffLines ?? []).map((line, index) => (
                <div className={`diff-line diff-${line.kind}`} key={`${activeFile?.id}-${index}`}>
                  <span className="diff-gutter">{line.lineNo ?? ''}</span>
                  <span className="diff-sign">{diffSign(line.kind)}</span>
                  <code className="diff-text">{line.text || ' '}</code>
                </div>
              ))}
            </div>
          </article>

          <aside className="vscode-review-checklist">
            <h4>Approval checklist</h4>
            <p>Use this review before marking the developer stage complete.</p>
            <ul>
              <li><CheckCircle2 size={13} /> Diff matches the story intent.</li>
              <li><CheckCircle2 size={13} /> No unexpected files changed.</li>
              <li><CheckCircle2 size={13} /> Evidence is enough for QA to continue.</li>
            </ul>
            <div className="review-source-card">
              <span>Source</span>
              <strong>{hasMcpDiff ? 'Actual MCP/git diff' : 'No actual code change'}</strong>
            </div>
          </aside>
        </div>
      )}
    </section>
  )
}

function ReviewFileButton({
  file,
  active,
  onClick,
}: {
  file: ReviewFile
  active: boolean
  onClick: () => void
}) {
  const stats = reviewFileStats(file)
  return (
    <button
      type="button"
      className={active ? 'active' : ''}
      onClick={onClick}
    >
      <FileCode2 size={13} />
      <span>{file.path}</span>
      <small>{file.source === 'mcp' ? 'MCP' : 'artifact'} · {file.status}</small>
      <b><span className="stat-add">+{stats.additions}</span> <span className="stat-remove">-{stats.deletions}</span></b>
    </button>
  )
}

function reviewFileStats(file: ReviewFile) {
  const additions = file.additions ?? file.diffLines.filter(line => line.kind === 'add').length
  const deletions = file.deletions ?? file.diffLines.filter(line => line.kind === 'remove').length
  return { additions, deletions, total: file.diffLines.length }
}

function reviewTotals(files: ReviewFile[]) {
  return files.reduce(
    (acc, file) => {
      const stats = reviewFileStats(file)
      acc.additions += stats.additions
      acc.deletions += stats.deletions
      return acc
    },
    { additions: 0, deletions: 0 },
  )
}

function diffSign(kind: DiffLineKind) {
  if (kind === 'add') return '+'
  if (kind === 'remove') return '-'
  if (kind === 'meta') return '@'
  return ''
}

function buildReviewFiles(session: BlueprintSession, stageKey: string, changes: CodeChangeRecord[]): ReviewFile[] {
  void session
  void stageKey
  return changes.flatMap(change => reviewFilesFromCodeChange(change))
}

function reviewFilesFromCodeChange(change: CodeChangeRecord): ReviewFile[] {
  const body = change.diff || change.patch || ''
  const paths = change.paths_touched?.length ? change.paths_touched : [pathFromDiff(body) ?? change.id]
  const pathLabel = paths.length === 1 ? paths[0] : `${paths[0]} +${paths.length - 1}`
  return [{
    id: `mcp-${change.id}`,
    path: pathLabel,
    source: 'mcp',
    status: change.stale ? 'stale' : 'captured',
    additions: change.lines_added,
    deletions: change.lines_removed,
    commitSha: change.commit_sha,
    hasDiff: Boolean(body),
    diffLines: parseDiffLines(body || fallbackDiffBody(paths, change)),
  }]
}

function parseDiffLines(body: string): ReviewDiffLine[] {
  const lines = body.split('\n')
  if (lines.length === 0) return [{ kind: 'context', text: 'No diff body captured.' }]
  let displayLine = 0
  return lines.slice(0, 500).map(line => {
    const kind = diffLineKind(line)
    if (kind === 'add' || kind === 'context') displayLine += 1
    return { kind, text: line, lineNo: kind === 'meta' ? undefined : displayLine }
  })
}

function diffLineKind(line: string): DiffLineKind {
  if (line.startsWith('diff --git') || line.startsWith('@@') || line.startsWith('+++') || line.startsWith('---')) return 'meta'
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'remove'
  return 'context'
}

function pathFromDiff(body: string) {
  const match = body.match(/\+\+\+\s+b\/([^\n]+)/) ?? body.match(/diff --git\s+a\/\S+\s+b\/([^\n]+)/)
  return match?.[1]?.trim()
}

function fallbackDiffBody(paths: string[], change: CodeChangeRecord) {
  return [
    '@@ MCP code-change metadata @@',
    ...paths.map(path => `+ ${path}`),
    change.tool_name ? `+ Tool: ${change.tool_name}` : '',
    change.commit_sha ? `+ Commit: ${change.commit_sha}` : '',
  ].filter(Boolean).join('\n')
}

function AssetRail({ session, activeStageKey, onSession }: { session: BlueprintSession; activeStageKey?: string; onSession: (session: BlueprintSession) => void }) {
  const [activeArtifactId, setActiveArtifactId] = useState<string | null>(null)
  const finalizeMutation = useMutation({
    mutationFn: () => api.finalize(session.id),
    onSuccess: (nextSession) => {
      onSession(nextSession)
      notifyWorkflowFinalized(nextSession)
    },
  })
  const artifacts = useMemo(() => {
    const ordered = [...session.artifacts]
    ordered.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    return ordered
  }, [session.artifacts])
  const visible = artifacts.filter(artifact => !activeStageKey || !artifact.stageKey || artifact.stageKey === activeStageKey || artifact.kind === 'final_implementation_pack')
  const active = visible.find(artifact => artifact.id === activeArtifactId) ?? visible[0]
  const consumableRefs = collectStageConsumables(session)
  const publishWarnings = visible
    .map(artifact => artifact.payload?.consumablePublish)
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item)))

  useEffect(() => {
    setActiveArtifactId(current => current && visible.some(artifact => artifact.id === current) ? current : visible[0]?.id ?? null)
  }, [session.id, activeStageKey, visible])

  const green = isLoopGreen(session)

  return (
    <section className="control-card asset-rail">
      <div className="panel-heading">
        <BookOpen size={18} />
        <div>
          <h2>Current Assets</h2>
          <p>Contract pack artifacts, versions, and final handoff status.</p>
        </div>
      </div>

      <div className="finalize-strip">
        <div>
          <strong>{session.finalPack ? 'Final pack stamped' : green ? 'Ready to finalize' : 'Final pack locked'}</strong>
          <span>{session.finalPack?.summary ?? (green ? 'All required gates are green.' : 'Pass or accept risk on every required stage first.')}</span>
          {session.finalPack?.finalPackConsumableId && (
            <span>Workflow consumable: {session.finalPack.finalPackConsumableId.slice(0, 8)}</span>
          )}
        </div>
        <button className="secondary-action approve" disabled={!green || Boolean(session.finalPack) || finalizeMutation.isPending} onClick={() => finalizeMutation.mutate()}>
          {finalizeMutation.isPending ? <Loader2 className="spin" size={15} /> : <BadgeCheck size={15} />}
          Finalize
        </button>
      </div>
      {finalizeMutation.isError && <p className="error-text">{finalizeMutation.error.message}</p>}

      {(consumableRefs.length > 0 || publishWarnings.length > 0) && (
        <div className="workflow-consumable-ledger">
          <div className="ledger-title">
            <Boxes size={14} />
            <span>Workflow consumables</span>
          </div>
          {consumableRefs.length > 0 ? (
            <div className="ledger-list">
              {consumableRefs.slice(0, 8).map(ref => (
                <div className="ledger-item" key={`${ref.consumableId}-${ref.artifactId ?? ref.artifactKind}`}>
                  <strong>{String(ref.title ?? ref.artifactKind ?? 'Workbench artifact')}</strong>
                  <span>{String(ref.stageKey ?? 'final')} · v{String(ref.consumableVersion ?? 1)}</span>
                  <em className={`consumable-badge ${String(ref.status ?? '').toLowerCase()}`}>
                    {String(ref.status ?? 'UNDER_REVIEW').replaceAll('_', ' ')}
                  </em>
                  <code>{String(ref.consumableId).slice(0, 8)}</code>
                </div>
              ))}
            </div>
          ) : (
            <p className="ledger-empty">No workflow consumables have been created for this session yet.</p>
          )}
          {publishWarnings.slice(0, 3).map((warning, index) => (
            <p className="ledger-warning" key={`${warning.reason ?? 'warning'}-${index}`}>
              <AlertTriangle size={13} />
              {String(warning.message ?? 'Consumable publishing was skipped.')}
            </p>
          ))}
        </div>
      )}

      {visible.length === 0 ? (
        <p className="empty">Artifacts appear as stage attempts complete.</p>
      ) : (
        <div className="artifact-layout">
          <nav className="artifact-tabs">
            {visible.map(artifact => <ArtifactTab key={artifact.id} artifact={artifact} active={artifact.id === active?.id} onClick={() => setActiveArtifactId(artifact.id)} />)}
          </nav>
          <article className="artifact-reader">
            <h3>{active?.title}</h3>
            <pre>{renderArtifact(active)}</pre>
          </article>
        </div>
      )}
    </section>
  )
}

function ArtifactTab({ artifact, active, onClick }: { artifact: BlueprintArtifact; active: boolean; onClick: () => void }) {
  return (
    <button className={active ? 'active' : ''} onClick={onClick}>
      <strong>{artifact.title}</strong>
      <span>{artifact.stageKey ? `${artifact.stageKey} · v${artifact.version ?? 1}` : artifact.kind}</span>
      {artifact.consumableId && (
        <em className={`consumable-badge ${String(artifact.consumableStatus ?? '').toLowerCase()}`}>
          {artifact.consumableStatus ? artifact.consumableStatus.replaceAll('_', ' ') : 'Consumable'}
        </em>
      )}
    </button>
  )
}

function WorkbenchTerminal({ session }: { session: BlueprintSession }) {
  const events = [...(session.reviewEvents ?? [])].reverse()
  const attempts = [...(session.stageAttempts ?? [])].reverse()
  return (
    <section className="control-card terminal-panel">
      <div className="terminal-header">
        <div>
          <ShieldCheck size={16} />
          <span>Console - raw_blueprint_stream</span>
        </div>
        <div>
          <button className="terminal-tool"><Download size={13} /> Export JSON</button>
        </div>
      </div>

      <div className="terminal-log">
        {events.length === 0 && attempts.length === 0 && <p className="empty">No loop events yet.</p>}
        {events.map(event => (
          <div className={`log-row ${event.type.includes('SEND_BACK') ? 'fail-block' : ''}`} key={event.id}>
            <time>{new Date(event.createdAt).toLocaleTimeString()}</time>
            <span>[{event.type.replaceAll('_', ' ')}]</span>
            <strong>{event.message}</strong>
          </div>
        ))}
        {attempts.filter(attempt => attempt.correlation).map(attempt => (
          <div className="log-row evidence" key={attempt.id}>
            <time>{attempt.completedAt ? new Date(attempt.completedAt).toLocaleTimeString() : '--:--:--'}</time>
            <span>[EVIDENCE]</span>
            <strong>{attempt.stageLabel}: {attempt.correlation?.cfCallId ?? attempt.correlation?.traceId ?? attempt.id}</strong>
            <small>{stageCostEvidence(attempt)}</small>
          </div>
        ))}
        <div className="terminal-input"><span>TERMINAL &gt;</span><em>Waiting for developer approval...</em></div>
      </div>
    </section>
  )
}

function stageCostEvidence(attempt: StageAttempt) {
  const tokens = attempt.tokensUsed?.total
    ? `${attempt.tokensUsed.total} actual tokens`
    : 'actual tokens pending'
  const optimization = attempt.metrics?.contextOptimization
  if (optimization && typeof optimization === 'object' && 'tokens_saved' in optimization) {
    const saved = (optimization as { tokens_saved?: unknown }).tokens_saved
    return `${tokens} · saved ${saved ?? 0}`
  }
  return tokens
}

function AgentSelect({
  label,
  role,
  agents,
  value,
  onChange,
}: {
  label: string
  role: string
  agents: LookupAgent[]
  value: string
  onChange: (value: string) => void
}) {
  const hasSelectedAgent = value && agents.some(agent => agent.id === value)
  return (
    <label>
      <span>{label}</span>
      <select value={value} onChange={event => onChange(event.target.value)}>
        <option value="">{agents.length ? 'Select agent' : 'Load capability first'}</option>
        {value && !hasSelectedAgent && <option value={value}>{titleFromRole(role)} agent · from workflow</option>}
        {agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
      </select>
    </label>
  )
}

function preferredAgent(agents: LookupAgent[], role: string) {
  return agents.find(agent => agent.name.toLowerCase().includes(role))
}

function attemptsFor(session: BlueprintSession, stageKey: string) {
  return (session.stageAttempts ?? []).filter(attempt => attempt.stageKey === stageKey)
}

function isDeveloperStage(stage: LoopStage) {
  const signature = `${stage.key} ${stage.label} ${stage.agentRole}`.toLowerCase()
  return signature.includes('develop') || signature.includes('developer') || signature.includes('engineer') || signature.includes('code')
}

function latestStatus(attempt?: StageAttempt) {
  if (!attempt) return 'pending'
  if (attempt.verdict === 'PASS' || attempt.verdict === 'ACCEPTED_WITH_RISK') return 'passed'
  if (attempt.verdict === 'BLOCKED' || attempt.status === 'FAILED') return 'failed'
  if (attempt.verdict === 'NEEDS_REWORK' || attempt.status === 'NEEDS_REWORK') return 'rework'
  if (attempt.status === 'RUNNING') return 'running'
  return 'completed'
}

function isLoopGreen(session: BlueprintSession) {
  const stages = session.loopDefinition?.stages ?? []
  return stages.filter(stage => stage.required !== false).every(stage => {
    const latest = attemptsFor(session, stage.key).at(-1)
    return latest?.verdict === 'PASS' || latest?.verdict === 'ACCEPTED_WITH_RISK'
  })
}

function answerList(answers: Record<string, DecisionAnswer>) {
  return Object.values(answers).filter(hasAnswer)
}

function hasAnswer(answer?: DecisionAnswer) {
  return Boolean(answer?.selectedOptionLabel?.trim() || answer?.customAnswer?.trim() || answer?.notes?.trim())
}

function stageLabel(session: BlueprintSession, stageKey: string) {
  return session.loopDefinition?.stages.find(stage => stage.key === stageKey)?.label ?? stageKey
}

function titleFromRole(role: string) {
  return role
    .toLowerCase()
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || 'Agent'
}

function renderArtifact(artifact?: BlueprintArtifact) {
  if (!artifact) return ''
  if (artifact.content) return artifact.content
  return JSON.stringify(artifact.payload ?? {}, null, 2)
}

function sessionOptionLabel(session: BlueprintSession) {
  return `${session.status} · ${session.goal.slice(0, 54)}${session.goal.length > 54 ? '...' : ''}`
}

function capLabel(cap: LookupCapability) {
  return `${cap.name}${cap.capability_type ? ` · ${cap.capability_type}` : ''}`
}

function csv(value: string) {
  return value.split(',').map(item => item.trim()).filter(Boolean)
}

function hasLoopAgentTemplates(loopDefinition: unknown) {
  if (!loopDefinition || typeof loopDefinition !== 'object' || Array.isArray(loopDefinition)) return false
  const stages = (loopDefinition as { stages?: unknown }).stages
  return Array.isArray(stages) && stages.some(stage =>
    Boolean(stage && typeof stage === 'object' && !Array.isArray(stage) && typeof (stage as { agentTemplateId?: unknown }).agentTemplateId === 'string' && (stage as { agentTemplateId: string }).agentTemplateId.trim()),
  )
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

async function loadWorkflowWorkbenchFallbackDefaults(capabilityId?: string): Promise<WorkbenchHydratedDefaults | null> {
  let instances: WorkflowInstanceListItem[] = []
  try {
    instances = await api.workflowInstances()
  } catch {
    return null
  }

  for (const item of instances) {
    try {
      const instance = await api.workflowInstance(item.id)
      const nodes = instance.nodes ?? []
      for (const node of nodes) {
        if (!asRecord(node.config?.workbench)) continue
        const hydrated = hydrateDefaultsFromWorkflow(instance, node.id)
        if (!hydrated) continue
        if (capabilityId && hydrated.capabilityId && hydrated.capabilityId !== capabilityId) continue
        if (hydrated.sourceUri || hydrated.goal) return hydrated
      }
    } catch {
      // Stale runs or inaccessible instances should not block fallback recovery.
    }
  }
  return null
}

function hydrateDefaultsFromWorkflow(instance: WorkflowInstanceDetail | undefined, workflowNodeId: string | undefined): WorkbenchHydratedDefaults | null {
  if (!instance || !workflowNodeId) return null
  const node = instance.nodes?.find(node => node.id === workflowNodeId)
  const workbench = asRecord(node?.config?.workbench)
  if (!workbench) return null
  const context = asRecord(instance.context) ?? {}
  const rendered = renderWorkflowValue(workbench, {
    context,
    instance: {
      vars: asRecord(context._vars) ?? {},
      globals: asRecord(context._globals) ?? {},
      params: asRecord(context._params) ?? {},
    },
    vars: asRecord(context._vars) ?? {},
    globals: asRecord(context._globals) ?? {},
    params: asRecord(context._params) ?? {},
  }) as Record<string, unknown>
  const bindings = asRecord(rendered.agentBindings) ?? {}
  const sourceType = rendered.sourceType === 'github' || rendered.sourceType === 'localdir' ? rendered.sourceType : undefined
  const gateMode = rendered.gateMode === 'auto' || rendered.gateMode === 'manual' ? rendered.gateMode : undefined
  return {
    goal: cleanText(typeof rendered.goal === 'string' ? rendered.goal : typeof rendered.task === 'string' ? rendered.task : undefined),
    sourceType,
    sourceUri: cleanText(rendered.sourceUri),
    sourceRef: cleanText(rendered.sourceRef),
    capabilityId: cleanText(rendered.capabilityId),
    architectAgentTemplateId: cleanText(bindings.architectAgentTemplateId),
    developerAgentTemplateId: cleanText(bindings.developerAgentTemplateId),
    qaAgentTemplateId: cleanText(bindings.qaAgentTemplateId),
    gateMode,
    loopDefinition: rendered.loopDefinition && typeof rendered.loopDefinition === 'object' && !Array.isArray(rendered.loopDefinition)
      ? rendered.loopDefinition as LoopDefinition
      : undefined,
  }
}

function renderWorkflowValue(value: unknown, context: Record<string, unknown>): unknown {
  if (typeof value === 'string') return renderWorkflowTemplate(value, context)
  if (Array.isArray(value)) return value.map(item => renderWorkflowValue(item, context))
  const object = asRecord(value)
  if (object) return Object.fromEntries(Object.entries(object).map(([key, child]) => [key, renderWorkflowValue(child, context)]))
  return value
}

function renderWorkflowTemplate(template: string, context: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, rawPath: string) => {
    const value = lookupWorkflowPath(context, rawPath.trim())
    return value === undefined || value === null ? '' : String(value)
  })
}

function lookupWorkflowPath(root: Record<string, unknown>, path: string): unknown {
  const direct = root[path]
  if (direct !== undefined) return direct
  return path.split('.').reduce<unknown>((cursor, segment) => {
    const object = asRecord(cursor)
    return object ? object[segment] : undefined
  }, root)
}

function cleanText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (!text || /\{\{[^}]+}}/.test(text)) return undefined
  return text
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function readWorkflowDefaults() {
  if (typeof window === 'undefined') return {}
  const params = new URLSearchParams(window.location.search)
  const gateMode = params.get('gateMode') === 'auto' ? 'auto' as const : params.get('gateMode') === 'manual' ? 'manual' as const : undefined
  const encodedLoop = params.get('loopDefinition')
  let loopDefinition
  if (encodedLoop) {
    try {
      const json = encodedLoop.trim().startsWith('{') ? encodedLoop : atob(encodedLoop)
      loopDefinition = JSON.parse(json)
    } catch {
      loopDefinition = undefined
    }
  }
  return {
    workflowInstanceId: cleanQueryParam(params.get('workflowInstanceId')),
    workflowNodeId: cleanQueryParam(params.get('workflowNodeId')),
    phaseId: cleanQueryParam(params.get('phaseId')),
    goal: cleanQueryParam(params.get('goal')),
    sourceType: params.get('sourceType') === 'github' ? 'github' as const : params.get('sourceType') === 'localdir' ? 'localdir' as const : undefined,
    sourceUri: cleanQueryParam(params.get('sourceUri')),
    sourceRef: cleanQueryParam(params.get('sourceRef')),
    capabilityId: cleanQueryParam(params.get('capabilityId')),
    architectAgentTemplateId: cleanQueryParam(params.get('architectAgentTemplateId')),
    developerAgentTemplateId: cleanQueryParam(params.get('developerAgentTemplateId')),
    qaAgentTemplateId: cleanQueryParam(params.get('qaAgentTemplateId')),
    productOwnerAgentTemplateId: cleanQueryParam(params.get('productOwnerAgentTemplateId')),
    securityAgentTemplateId: cleanQueryParam(params.get('securityAgentTemplateId')),
    devopsAgentTemplateId: cleanQueryParam(params.get('devopsAgentTemplateId')),
    gateMode,
    loopDefinition,
  }
}

function cleanQueryParam(value: string | null): string | undefined {
  const text = value?.trim()
  if (!text || /\{\{[^}]+}}/.test(text)) return undefined
  return text
}

function notifyWorkflowFinalized(session: BlueprintSession) {
  if (typeof window === 'undefined' || window.parent === window) return
  const stageConsumables = collectStageConsumables(session)
  const consumableIds = Array.from(new Set([
    ...(session.finalPack?.consumableIds ?? []),
    ...stageConsumables.map(ref => ref.consumableId).filter(Boolean),
    session.finalPack?.finalPackConsumableId,
  ].filter((id): id is string => Boolean(id))))
  window.parent.postMessage({
    type: 'blueprintWorkbench.finalized',
    sessionId: session.id,
    workflowInstanceId: session.workflowInstanceId,
    workflowNodeId: session.workflowNodeId,
    finalPack: session.finalPack,
    finalPackConsumableId: session.finalPack?.finalPackConsumableId,
    stageConsumables,
    consumableIds,
    stageArtifactsByKind: groupStageConsumablesByKind(stageConsumables),
    status: session.status,
  }, window.location.origin === 'http://localhost:5176' ? 'http://localhost:5174' : '*')
}

function collectStageConsumables(session: BlueprintSession): Array<Record<string, any>> {
  const fromPack = session.finalPack?.stageConsumables
  if (Array.isArray(fromPack) && fromPack.length > 0) return fromPack
  return session.artifacts.flatMap(artifact => {
    const consumable = artifact.payload?.consumable
    if (consumable && typeof consumable === 'object') return [consumable as Record<string, any>]
    if (!artifact.consumableId) return []
    return [{
      artifactId: artifact.id,
      artifactKind: artifact.kind,
      title: artifact.title,
      consumableId: artifact.consumableId,
      consumableVersion: artifact.consumableVersion ?? 1,
      status: artifact.consumableStatus ?? 'UNDER_REVIEW',
      stageKey: artifact.stageKey,
      attemptId: artifact.attemptId,
    }]
  })
}

function groupStageConsumablesByKind(refs: Array<Record<string, any>>) {
  return refs.reduce<Record<string, Array<Record<string, any>>>>((acc, ref) => {
    const key = typeof ref.artifactKind === 'string' && ref.artifactKind ? ref.artifactKind : 'artifact'
    acc[key] = [...(acc[key] ?? []), ref]
    return acc
  }, {})
}
