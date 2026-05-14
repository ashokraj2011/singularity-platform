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
  type BlueprintSession,
  type CreateSessionRequest,
  type DecisionAnswer,
  type GateMode,
  type LoopStage,
  type LoopVerdict,
  type LookupAgent,
  type LookupCapability,
  type SourceType,
  type StageAttempt,
} from './api'

const knownRoleMeta: Record<string, { label: string; icon: typeof Brain }> = {
  ARCHITECT: { label: 'Architect', icon: Brain },
  DEVELOPER: { label: 'Developer', icon: Code2 },
  QA: { label: 'QA', icon: ClipboardCheck },
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
  const [authTick, setAuthTick] = useState(0)
  const [setupOpen, setSetupOpen] = useState(false)
  const hasToken = Boolean(getToken())

  const sessionsQuery = useQuery({
    queryKey: ['blueprintSessions'],
    queryFn: api.listSessions,
    enabled: hasToken,
  })
  const sessions = sessionsQuery.data?.items ?? []

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
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ type: 'blueprintWorkbench.auth.request' }, 'http://localhost:5174')
    }
    return () => window.removeEventListener('message', handler)
  }, [])

  useEffect(() => {
    const scopedSessions = workflowDefaults.workflowInstanceId && workflowDefaults.workflowNodeId
      ? sessions.filter(session =>
          session.workflowInstanceId === workflowDefaults.workflowInstanceId
          && session.workflowNodeId === workflowDefaults.workflowNodeId,
        )
      : sessions
    if (workflowDefaults.workflowInstanceId && workflowDefaults.workflowNodeId && scopedSessions.length === 0) {
      setActiveSession(null)
      return
    }
    if (scopedSessions.length === 0) return
    setActiveSession(current => {
      if (!current) return scopedSessions[0]
      return scopedSessions.find(session => session.id === current.id) ?? scopedSessions[0]
    })
  }, [sessions, workflowDefaults.workflowInstanceId, workflowDefaults.workflowNodeId])

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
            sessions={sessions}
            activeSession={activeSession}
            onSelect={(session) => {
              setActiveSession(session)
              setSetupOpen(false)
            }}
            onCreated={(session) => {
              refreshSession(session)
              setSetupOpen(false)
            }}
          />
        </SetupDrawer>
        <LoopWorkbench session={activeSession} onSession={refreshSession} />
      </section>
    </main>
  )
}

function WorkbenchCommandHeader({
  session,
  onRefresh,
  onSetup,
  onSignOut,
}: {
  session: BlueprintSession | null
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
          <h1>Blueprint Workbench</h1>
        </div>
      </div>
      <nav className="command-tabs" aria-label="Workbench sections">
        <span className="active">Workflow</span>
        <span>Artifacts</span>
        <span>Terminal</span>
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
  const [goal, setGoal] = useState(workflowDefaults.goal ?? 'Create a governed planning, design, development, QA, and testing loop for this codebase.')
  const [gateMode, setGateMode] = useState<GateMode>(workflowDefaults.gateMode ?? 'manual')
  const [capabilityId, setCapabilityId] = useState(workflowDefaults.capabilityId ?? '')
  const [architectAgentTemplateId, setArchitectAgentTemplateId] = useState(workflowDefaults.architectAgentTemplateId ?? '')
  const [developerAgentTemplateId, setDeveloperAgentTemplateId] = useState(workflowDefaults.developerAgentTemplateId ?? '')
  const [qaAgentTemplateId, setQaAgentTemplateId] = useState(workflowDefaults.qaAgentTemplateId ?? '')
  const [includeGlobs, setIncludeGlobs] = useState('')
  const [excludeGlobs, setExcludeGlobs] = useState('**/node_modules/**,**/dist/**,**/.git/**')

  const capabilitiesQuery = useQuery({ queryKey: ['capabilities'], queryFn: api.capabilities })
  const capabilities = capabilitiesQuery.data ?? []
  const agentsQuery = useQuery({
    queryKey: ['agents', capabilityId],
    queryFn: () => api.agents(capabilityId),
    enabled: Boolean(capabilityId),
  })
  const agents = agentsQuery.data ?? []

  useEffect(() => {
    if (!capabilityId && capabilities[0]) setCapabilityId(capabilities[0].id)
  }, [capabilityId, capabilities])

  useEffect(() => {
    if (!agents[0]) return
    setArchitectAgentTemplateId(v => v || preferredAgent(agents, 'architect')?.id || agents[0].id)
    setDeveloperAgentTemplateId(v => v || preferredAgent(agents, 'developer')?.id || agents[0].id)
    setQaAgentTemplateId(v => v || preferredAgent(agents, 'qa')?.id || agents[0].id)
  }, [agents])

  const createMutation = useMutation({
    mutationFn: (body: CreateSessionRequest) => api.createSession(body),
    onSuccess: onCreated,
  })

  const loopAgentReady = hasLoopAgentTemplates(workflowDefaults.loopDefinition)
  const canCreate = goal.trim().length > 7
    && sourceUri.trim()
    && capabilityId
    && (loopAgentReady || architectAgentTemplateId || developerAgentTemplateId || qaAgentTemplateId)

  return (
    <aside className="panel setup-panel">
      <div className="panel-heading">
        <Boxes size={18} />
        <div>
          <h2>Source + Loop Context</h2>
          <p>Read-only source intake plus governed stage bindings.</p>
        </div>
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
          {capabilities.map(capability => <option key={capability.id} value={capability.id}>{capLabel(capability)}</option>)}
        </select>
      </label>

      <div className="agent-grid">
        <AgentSelect label="Architect" agents={agents} value={architectAgentTemplateId} onChange={setArchitectAgentTemplateId} />
        <AgentSelect label="Developer" agents={agents} value={developerAgentTemplateId} onChange={setDeveloperAgentTemplateId} />
        <AgentSelect label="QA" agents={agents} value={qaAgentTemplateId} onChange={setQaAgentTemplateId} />
      </div>

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
          loopDefinition: workflowDefaults.loopDefinition,
        })}
      >
        {createMutation.isPending ? <Loader2 className="spin" size={16} /> : <Sparkles size={16} />}
        Create Loop Session
      </button>
    </aside>
  )
}

function LoopWorkbench({ session, onSession }: { session: BlueprintSession | null; onSession: (session: BlueprintSession) => void }) {
  const [activeStageKey, setActiveStageKey] = useState<string | null>(null)
  const stages = session?.loopDefinition?.stages ?? []

  useEffect(() => {
    if (!session) {
      setActiveStageKey(null)
      return
    }
    const preferred = session.currentStageKey ?? stages[0]?.key ?? null
    setActiveStageKey(current => current && stages.some(stage => stage.key === current) ? current : preferred)
  }, [session?.id, session?.currentStageKey, stages])

  const activeStage = stages.find(stage => stage.key === activeStageKey) ?? stages[0]

  if (!session) {
    return (
      <section className="empty-workbench">
        <Activity size={30} />
        <h2>Create or select a session</h2>
        <p>The cyclic workbench canvas, stage controls, assets, and terminal evidence stream will appear here.</p>
      </section>
    )
  }

  return (
    <section className="control-room-grid">
      <CyclicLoopCanvas session={session} activeStageKey={activeStage?.key ?? null} onStage={setActiveStageKey} onSession={onSession} />
      <StageDetailsPanel session={session} stage={activeStage} onSession={onSession} />
      <AssetRail session={session} activeStageKey={activeStage?.key} onSession={onSession} />
      <WorkbenchTerminal session={session} />
    </section>
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
  const canRun = Boolean(session.snapshots[0]) && latest?.status !== 'RUNNING'
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
          Run stage
        </button>
      </div>

      {!session.snapshots[0] && <p className="warning-text">Snapshot the source before running stages.</p>}
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
              <p className="warning-text">Human approval is required before this artifact set can move forward.</p>
            )}
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
          <CheckCircle2 size={15} /> Approve artifacts
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
        </div>
        <button className="secondary-action approve" disabled={!green || Boolean(session.finalPack) || finalizeMutation.isPending} onClick={() => finalizeMutation.mutate()}>
          {finalizeMutation.isPending ? <Loader2 className="spin" size={15} /> : <BadgeCheck size={15} />}
          Finalize
        </button>
      </div>
      {finalizeMutation.isError && <p className="error-text">{finalizeMutation.error.message}</p>}

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

function AgentSelect({ label, agents, value, onChange }: { label: string; agents: LookupAgent[]; value: string; onChange: (value: string) => void }) {
  return (
    <label>
      <span>{label}</span>
      <select value={value} onChange={event => onChange(event.target.value)}>
        <option value="">{agents.length ? 'Select agent' : 'Load capability first'}</option>
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
    workflowInstanceId: params.get('workflowInstanceId') ?? undefined,
    workflowNodeId: params.get('workflowNodeId') ?? undefined,
    phaseId: params.get('phaseId') ?? undefined,
    goal: params.get('goal') ?? undefined,
    sourceType: params.get('sourceType') === 'github' ? 'github' as const : params.get('sourceType') === 'localdir' ? 'localdir' as const : undefined,
    sourceUri: params.get('sourceUri') ?? undefined,
    sourceRef: params.get('sourceRef') ?? undefined,
    capabilityId: params.get('capabilityId') ?? undefined,
    architectAgentTemplateId: params.get('architectAgentTemplateId') ?? undefined,
    developerAgentTemplateId: params.get('developerAgentTemplateId') ?? undefined,
    qaAgentTemplateId: params.get('qaAgentTemplateId') ?? undefined,
    gateMode,
    loopDefinition,
  }
}

function notifyWorkflowFinalized(session: BlueprintSession) {
  if (typeof window === 'undefined' || window.parent === window) return
  window.parent.postMessage({
    type: 'blueprintWorkbench.finalized',
    sessionId: session.id,
    workflowInstanceId: session.workflowInstanceId,
    workflowNodeId: session.workflowNodeId,
    finalPack: session.finalPack,
    status: session.status,
  }, window.location.origin === 'http://localhost:5176' ? 'http://localhost:5174' : '*')
}
