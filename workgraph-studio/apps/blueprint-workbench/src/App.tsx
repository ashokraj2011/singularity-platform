import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
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
  Maximize2,
  Minimize2,
  RefreshCw,
  Settings,
  ShieldCheck,
  Sparkles,
  Terminal,
  X,
} from 'lucide-react'
import {
  api,
  BLUEPRINT_AUTH_INVALID_EVENT,
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
  type LoopQuestion,
  type LoopVerdict,
  type LlmModelCatalogEntry,
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
import { AppSwitcher } from './components/AppSwitcher'
import { LoopRail } from './neo/LoopRail'
import { LiveCockpit } from './neo/LiveCockpit'
import { FocusPane, computeFocusIntent, type FocusAction } from './neo/FocusPane'
import { NeoNotifier } from './neo/NeoNotifier'
import { StageChat } from './neo/StageChat'
import { LoopTrace } from './neo/LoopTrace'
import { NeoThemePicker, lookClass, useNeoLook } from './neo/NeoThemePicker'
import { MarkdownView } from './neo/MarkdownView'

const knownRoleMeta: Record<string, { label: string; icon: typeof Brain }> = {
  ARCHITECT: { label: 'Architect', icon: Brain },
  DEVELOPER: { label: 'Developer', icon: Code2 },
  QA: { label: 'QA', icon: ClipboardCheck },
}

const defaultWorkbenchGoal = 'Create a governed planning, design, development, QA, and testing loop for this codebase.'

type WorkbenchSection = 'workflow' | 'artifacts' | 'terminal' | 'loop' | 'replay'

const WORKGRAPH_WEB_ORIGIN = normalizeOrigin(import.meta.env.VITE_WORKGRAPH_WEB_ORIGIN)
  ?? `${window.location.protocol}//${window.location.hostname}:5174`
const WORKBENCH_ORIGIN = normalizeOrigin(import.meta.env.VITE_BLUEPRINT_WORKBENCH_ORIGIN)
  ?? `${window.location.protocol}//${window.location.hostname}:5176`

type WorkbenchHydratedDefaults = {
  browserRunId?: string
  goal?: string
  goalProvenance?: string
  sourceType?: SourceType
  sourceUri?: string
  sourceRef?: string
  sourceProvenance?: string
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
    window.parent.postMessage(message, '*')
  }
  if (window.opener && window.opener !== window) {
    window.opener.postMessage(message, '*')
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
  const workflowScoped = Boolean((workflowDefaults.workflowInstanceId || workflowDefaults.browserRunId) && workflowDefaults.workflowNodeId)
  const visibleSessions = useMemo(() => {
    if (!workflowScoped) return sessions
    return sessions.filter(session => sessionMatchesWorkflowDefaults(session, workflowDefaults))
  }, [sessions, workflowDefaults, workflowScoped])

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (!isAllowedWorkbenchHostOrigin(event.origin)) return
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
    const handler = () => {
      clearToken()
      setAuthTick(v => v + 1)
      requestWorkbenchAuthFromHost()
    }
    window.addEventListener(BLUEPRINT_AUTH_INVALID_EVENT, handler)
    return () => window.removeEventListener(BLUEPRINT_AUTH_INVALID_EVENT, handler)
  }, [])

  useEffect(() => {
    setActiveSession(current => {
      if (visibleSessions.length === 0) {
        return workflowScoped ? null : current && localCreatedSessionIds.has(current.id) ? current : null
      }
      if (workflowScoped && current && !sessionMatchesWorkflowDefaults(current, workflowDefaults)) return visibleSessions[0]
      if (!current) return visibleSessions[0]
      if (localCreatedSessionIds.has(current.id)) return current
      return visibleSessions.find(session => session.id === current.id) ?? visibleSessions[0]
    })
  }, [localCreatedSessionIds, visibleSessions, workflowDefaults, workflowScoped])

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
                if (!workflowScoped || sessionMatchesWorkflowDefaults(session, workflowDefaults)) next.add(session.id)
                return next
              })
              if (workflowScoped && !sessionMatchesWorkflowDefaults(session, workflowDefaults)) {
                setActiveSession(null)
                void queryClient.invalidateQueries({ queryKey: ['blueprintSessions'] })
                setSetupOpen(true)
                return
              }
              refreshSession(session)
              setSetupOpen(false)
            }}
          />
        </SetupDrawer>
        <WorkbenchNeo session={activeSession} activeSection={activeSection} onSection={setActiveSection} onSession={refreshSession} />
        <ClarificationPrompt session={activeSession} onSession={refreshSession} />
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
          ['loop', 'Loop'],
          ['replay', 'Replay'],
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
      <div className="command-metrics">
        <MetricPill label="Stage" value={activeStage?.label ?? 'No session'} tone="primary" />
        <MetricPill label="Iterations" value={String(attempts)} />
        <MetricPill label="Loops" value={String(sendBacks)} tone={sendBacks > 0 ? 'warning' : 'default'} />
      </div>
      <div className="topbar-actions">
        <AppSwitcher currentApp="workbench" />
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
        <p>This standalone Workbench uses the Workgraph API and needs a browser token from the workflow portal.</p>
        <button className="primary-action" onClick={() => loginMutation.mutate()} disabled={loginMutation.isPending}>
          {loginMutation.isPending ? <Loader2 className="spin" size={16} /> : <ShieldCheck size={16} />}
          Continue as super admin
        </button>
        {loginMutation.isError && <p className="error-text">{loginMutation.error.message}</p>}
      </div>
    </main>
  )
}

function ClarificationPrompt({
  session,
  onSession,
}: {
  session: BlueprintSession | null
  onSession: (session: BlueprintSession) => void
}) {
  const [answers, setAnswers] = useState<Record<string, DecisionAnswer>>({})
  const [dismissedKey, setDismissedKey] = useState('')
  const stage = session?.loopDefinition?.stages.find(item => item.key === session.currentStageKey)
  const questions = useMemo(() => {
    if (!session || !stage) return []
    return unansweredClarificationQuestions(session, stage)
  }, [session, stage])
  const promptKey = session && stage && questions.length
    ? `${session.id}:${stage.key}:${questions.map(question => question.id).join('|')}`
    : ''
  const open = Boolean(promptKey && promptKey !== dismissedKey)
  const saveMutation = useMutation({
    mutationFn: () => {
      if (!session) throw new Error('No Workbench session selected')
      const current = Object.fromEntries((session.decisionAnswers ?? []).map(answer => [answer.questionId, answer]))
      const merged = { ...current, ...answers }
      return api.saveDecisionAnswers(session.id, answerList(merged))
    },
    onSuccess: (updated) => {
      setAnswers({})
      onSession(updated)
      setDismissedKey(promptKey)
    },
  })

  // M54.A — "Save & re-run with answers". The previous flow saved answers
  // but left the existing (pre-answer) attempt as the one operators
  // approved — wasting the answers as metadata. This chains save → run
  // so the next attempt's task includes `capturedDecisions` (router.ts
  // buildLoopStageVars:3393) and the agent produces a refined output the
  // operator can then approve.
  const saveAndRerunMutation = useMutation({
    mutationFn: async () => {
      if (!session || !stage) throw new Error('No Workbench session/stage selected')
      const current = Object.fromEntries((session.decisionAnswers ?? []).map(answer => [answer.questionId, answer]))
      const merged = { ...current, ...answers }
      const afterSave = await api.saveDecisionAnswers(session.id, answerList(merged))
      // Snapshot first if needed, mirroring runMutation in WorkbenchNeoFocus.
      if (!afterSave.snapshots[0]) {
        await api.snapshot(afterSave.id)
      }
      return api.runStage(afterSave.id, stage.key)
    },
    onSuccess: (updated) => {
      setAnswers({})
      onSession(updated)
      setDismissedKey(promptKey)
    },
  })

  useEffect(() => {
    if (!open || !session) return
    setAnswers(Object.fromEntries((session.decisionAnswers ?? []).map(answer => [answer.questionId, answer])))
  }, [open, session?.id, session?.decisionAnswers])

  if (!open || !session || !stage) return null
  const answeredCount = questions.filter(question => hasAnswerForQuestion(question, answerList(answers))).length

  return (
    <div className="clarification-scrim" role="dialog" aria-modal="true" aria-labelledby="clarification-title">
      <section className="clarification-modal">
        <div className="clarification-heading">
          <div>
            <p className="eyebrow">Agent clarification</p>
            <h2 id="clarification-title">{stage.label} needs your input</h2>
            <p>
              The LLM returned open questions. Answer them here so the stage gate and downstream agents use your decisions instead of guessing.
            </p>
          </div>
          <button className="icon-button" type="button" onClick={() => setDismissedKey(promptKey)} title="Answer later">
            <X size={16} />
          </button>
        </div>

        <div className="question-stack">
          {questions.map(question => (
          <QuestionAnswerCard
              key={question.id}
              question={question}
              answer={answerForQuestion(question, answerList(answers))}
              onAnswer={(answer) => setAnswers(current => ({ ...current, [question.id]: answer }))}
            />
          ))}
        </div>

        {(saveMutation.isError || saveAndRerunMutation.isError) && (
          <p className="error-text">
            {(saveMutation.error ?? saveAndRerunMutation.error)?.message}
          </p>
        )}
        <div className="clarification-actions">
          <span>{answeredCount}/{questions.length} answered</span>
          <button className="secondary-action" type="button" onClick={() => setDismissedKey(promptKey)}>Answer later</button>
          {/* M54.A — "Save answers" alone leaves the existing pre-answer attempt
              as what gets approved. Most operators want their answers to
              actually shape the agent's output — that's "Save & re-run". */}
          <button
            className="secondary-action"
            type="button"
            disabled={answeredCount === 0 || saveMutation.isPending || saveAndRerunMutation.isPending}
            onClick={() => saveMutation.mutate()}
            title="Persist the answers without firing a new attempt. The current pre-answer attempt remains the one shown for approval."
          >
            {saveMutation.isPending ? <Loader2 className="spin" size={15} /> : <CheckCircle2 size={15} />}
            Save answers
          </button>
          <button
            className="primary-action compact"
            type="button"
            disabled={answeredCount === 0 || saveMutation.isPending || saveAndRerunMutation.isPending}
            onClick={() => saveAndRerunMutation.mutate()}
            title="Persist the answers AND immediately re-run the stage so the agent generates a new attempt that reflects your decisions."
          >
            {saveAndRerunMutation.isPending ? <Loader2 className="spin" size={15} /> : <CheckCircle2 size={15} />}
            Save &amp; re-run with answers
          </button>
        </div>
      </section>
    </div>
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
  const [goalDefault, setGoalDefault] = useState(workflowDefaults.goal ?? '')
  const [goalDefaultSource, setGoalDefaultSource] = useState(workflowDefaults.goal ? 'workflow launch URL' : '')
  const [sourceDefaultType, setSourceDefaultType] = useState<SourceType | undefined>(workflowDefaults.sourceType)
  const [sourceDefaultUri, setSourceDefaultUri] = useState(workflowDefaults.sourceUri ?? '')
  const [sourceDefaultRef, setSourceDefaultRef] = useState(workflowDefaults.sourceRef ?? '')
  const [sourceDefaultSource, setSourceDefaultSource] = useState(workflowDefaults.sourceUri ? 'workflow launch URL' : '')
  const [intakeTouched, setIntakeTouched] = useState({ goal: false, sourceType: false, sourceUri: false, sourceRef: false })
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
  const [excerptBudgetChars, setExcerptBudgetChars] = useState(8_000)
  const [reuseUnchangedAttempt, setReuseUnchangedAttempt] = useState(true)
  const [governanceMode, setGovernanceMode] = useState<GovernanceMode>('fail_open')
  const [modelAlias, setModelAlias] = useState('')
  const [stageModelAliases, setStageModelAliases] = useState<Record<string, string>>({})
  const [maxContextTokens, setMaxContextTokens] = useState(3_000)
  const [maxOutputTokens, setMaxOutputTokens] = useState(800)
  const [maxPromptChars, setMaxPromptChars] = useState(12_000)
  const [maxLayerChars, setMaxLayerChars] = useState(1_000)

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
  const selectedCapability = capabilities.find(capability => capability.id === capabilityId || capability.capability_id === capabilityId)
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
  const capabilitySourceDefault = useMemo(
    () => defaultSourceFromCapability(selectedCapability ?? fallbackCapability ?? undefined),
    [selectedCapability, fallbackCapability],
  )

  useEffect(() => {
    const hydrated = hydrateDefaultsFromWorkflow(workflowInstanceQuery.data, workflowDefaults.workflowNodeId) ?? workflowFallbackQuery.data
    if (!hydrated) return
    if (hydrated.goal) {
      setGoalDefault(hydrated.goal)
      setGoalDefaultSource(hydrated.goalProvenance ?? 'workflow/work item context')
      if (!intakeTouched.goal) setGoal(hydrated.goal)
    }
    if (hydrated.sourceUri) {
      setSourceDefaultUri(hydrated.sourceUri)
      setSourceDefaultSource(hydrated.sourceProvenance ?? 'workflow source context')
      if (!intakeTouched.sourceUri) setSourceUri(hydrated.sourceUri)
    }
    if (hydrated.sourceType === 'github' || hydrated.sourceType === 'localdir') {
      setSourceDefaultType(hydrated.sourceType)
      if (!intakeTouched.sourceType) setSourceType(hydrated.sourceType)
    }
    if (hydrated.sourceRef) {
      setSourceDefaultRef(hydrated.sourceRef)
      if (!intakeTouched.sourceRef) setSourceRef(hydrated.sourceRef)
    }
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
  }, [intakeTouched.goal, intakeTouched.sourceRef, intakeTouched.sourceType, intakeTouched.sourceUri, workflowFallbackQuery.data, workflowInstanceQuery.data, workflowDefaults.workflowNodeId])

  useEffect(() => {
    if (!capabilitySourceDefault) return
    setSourceDefaultUri(capabilitySourceDefault.sourceUri)
    setSourceDefaultType(capabilitySourceDefault.sourceType)
    setSourceDefaultRef(capabilitySourceDefault.sourceRef ?? '')
    setSourceDefaultSource(capabilitySourceDefault.provenance)
    if (!intakeTouched.sourceUri) setSourceUri(capabilitySourceDefault.sourceUri)
    if (!intakeTouched.sourceType) setSourceType(capabilitySourceDefault.sourceType)
    if (!intakeTouched.sourceRef && capabilitySourceDefault.sourceRef) setSourceRef(capabilitySourceDefault.sourceRef)
  }, [
    capabilitySourceDefault?.provenance,
    capabilitySourceDefault?.sourceRef,
    capabilitySourceDefault?.sourceType,
    capabilitySourceDefault?.sourceUri,
    intakeTouched.sourceRef,
    intakeTouched.sourceType,
    intakeTouched.sourceUri,
  ])

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
    setStageModelAliases(config.stageModelAliases ?? {})
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
  const resetActiveStageMutation = useMutation({
    mutationFn: () => {
      if (!activeSession?.currentStageKey) throw new Error('Select a session with an active stage before resetting attempts.')
      return api.resetStageAttempts(activeSession.id, activeSession.currentStageKey)
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
    stageModelAliases: cleanStageModelAliases(stageModelAliases),
    maxContextTokens,
    maxOutputTokens,
    maxPromptChars,
    maxLayerChars,
  })

  const modelStages = loopDefinition?.stages ?? activeSession?.loopDefinition?.stages ?? []

  const loopAgentReady = hasLoopAgentTemplates(loopDefinition)
  const canCreate = goal.trim().length > 7
    && sourceUri.trim()
    && capabilityId
    && (loopAgentReady || architectAgentTemplateId || developerAgentTemplateId || qaAgentTemplateId)
  const goalEdited = Boolean(goalDefault.trim() && goal.trim() !== goalDefault.trim())
  const sourceEdited = Boolean(
    (sourceDefaultUri.trim() && sourceUri.trim() !== sourceDefaultUri.trim())
      || (sourceDefaultType && sourceType !== sourceDefaultType)
      || (sourceDefaultRef.trim() && sourceRef.trim() !== sourceDefaultRef.trim()),
  )
  const intakeDefaults = {
    goal: goalDefault.trim() || undefined,
    sourceType: sourceDefaultType,
    sourceUri: sourceDefaultUri.trim() || undefined,
    sourceRef: sourceDefaultRef.trim() || undefined,
    sourceProvenance: sourceDefaultSource || undefined,
  }
  const intakeOverrides = goalEdited || sourceEdited
    ? {
      goalEdited,
      sourceEdited,
      originalGoal: goalDefault.trim() || undefined,
      editedGoal: goalEdited ? goal.trim() : undefined,
      originalSourceType: sourceDefaultType,
      editedSourceType: sourceEdited ? sourceType : undefined,
      originalSourceUri: sourceDefaultUri.trim() || undefined,
      editedSourceUri: sourceEdited ? sourceUri.trim() : undefined,
      originalSourceRef: sourceDefaultRef.trim() || undefined,
      editedSourceRef: sourceEdited ? sourceRef.trim() || undefined : undefined,
      sourceProvenance: sourceDefaultSource || undefined,
    }
    : undefined

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
        <textarea
          value={goal}
          onChange={event => {
            setIntakeTouched(current => ({ ...current, goal: true }))
            setGoal(event.target.value)
          }}
          rows={4}
        />
        {goalDefault && (
          <p className={goalEdited ? 'warning-text compact-note' : 'muted-hint'}>
            {goalEdited
              ? `Edited from ${goalDefaultSource || 'the WorkItem/workflow default'}; this override will be audited.`
              : `Defaulted from ${goalDefaultSource || 'the WorkItem/workflow default'}.`}
          </p>
        )}
      </label>

      <div className="segmented">
        <button
          className={sourceType === 'localdir' ? 'active' : ''}
          onClick={() => {
            setIntakeTouched(current => ({ ...current, sourceType: true }))
            setSourceType('localdir')
          }}
          type="button"
        >
          <HardDrive size={14} /> Local dir
        </button>
        <button
          className={sourceType === 'github' ? 'active' : ''}
          onClick={() => {
            setIntakeTouched(current => ({ ...current, sourceType: true }))
            setSourceType('github')
          }}
          type="button"
        >
          <GitBranch size={14} /> GitHub
        </button>
      </div>

      <label>
        <span>{sourceType === 'github' ? 'GitHub URL' : 'Local directory'}</span>
        <input
          value={sourceUri}
          onChange={event => {
            setIntakeTouched(current => ({ ...current, sourceUri: true }))
            setSourceUri(event.target.value)
          }}
          placeholder={sourceType === 'github' ? 'https://github.com/org/repo' : '/path/visible/to/workgraph-api'}
        />
        {sourceDefaultUri && (
          <p className={sourceEdited ? 'warning-text compact-note' : 'muted-hint'}>
            {sourceEdited
              ? `Edited from ${sourceDefaultSource || 'the capability/workflow default'}; this source override will be audited.`
              : `Defaulted from ${sourceDefaultSource || 'the capability/workflow default'}.`}
          </p>
        )}
      </label>

      <div className="two-col">
        <label>
          <span>Branch / ref</span>
          <input
            value={sourceRef}
            onChange={event => {
              setIntakeTouched(current => ({ ...current, sourceRef: true }))
              setSourceRef(event.target.value)
            }}
            placeholder="optional"
          />
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
            <input type="number" min={1000} max={200000} step={500} value={maxContextTokens} onChange={event => setMaxContextTokens(Number(event.target.value) || 3000)} />
          </label>
          <label>
            <span>Output tokens</span>
            <input type="number" min={128} max={32000} step={100} value={maxOutputTokens} onChange={event => setMaxOutputTokens(Number(event.target.value) || 800)} />
          </label>
        </div>
        <div className="two-col compact-fields">
          <label>
            <span>Prompt chars</span>
            <input type="number" min={2000} max={500000} step={1000} value={maxPromptChars} onChange={event => setMaxPromptChars(Number(event.target.value) || 12000)} />
          </label>
          <label>
            <span>Layer chars</span>
            <input type="number" min={500} max={100000} step={250} value={maxLayerChars} onChange={event => setMaxLayerChars(Number(event.target.value) || 1000)} />
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
            <input type="number" min={2000} max={120000} step={1000} value={excerptBudgetChars} onChange={event => setExcerptBudgetChars(Number(event.target.value) || 8000)} />
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
        {modelStages.length > 0 && (
          <div className="stage-model-grid">
            {modelStages.map(stage => (
              <label key={stage.key}>
                <span>{stage.label || stage.key}</span>
                <input
                  value={stageModelAliases[stage.key] ?? ''}
                  onChange={event => {
                    const value = event.target.value
                    setStageModelAliases(current => ({ ...current, [stage.key]: value }))
                  }}
                  placeholder="use fallback"
                />
              </label>
            ))}
          </div>
        )}
        <label className="checkbox-row">
          <input type="checkbox" checked={reuseUnchangedAttempt} onChange={event => setReuseUnchangedAttempt(event.target.checked)} />
          <span>Reuse unchanged stage attempts</span>
        </label>
        <p className="muted-hint">Increase “Max loops / stage” when a stage needs more than three review/rework cycles. Lower prompt limits to force smaller, cheaper prompts.</p>
        {settingsMutation.isError && <p className="error-text">{settingsMutation.error.message}</p>}
        {settingsMutation.isSuccess && <p className="success-text">Runtime settings saved for this session.</p>}
        {resetActiveStageMutation.isError && <p className="error-text">{resetActiveStageMutation.error.message}</p>}
        {resetActiveStageMutation.isSuccess && <p className="success-text">Active stage attempt counter reset.</p>}
        <button
          className="secondary-action full-width"
          type="button"
          disabled={!activeSession || settingsMutation.isPending}
          onClick={() => settingsMutation.mutate(runtimeSettings())}
        >
          {settingsMutation.isPending ? <Loader2 className="spin" size={16} /> : <Settings size={16} />}
          Save settings for current session
        </button>
        <button
          className="secondary-action full-width danger"
          type="button"
          disabled={!activeSession?.currentStageKey || resetActiveStageMutation.isPending}
          onClick={() => resetActiveStageMutation.mutate()}
        >
          {resetActiveStageMutation.isPending ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}
          Reset active stage attempts
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
          browserRunId: workflowDefaults.browserRunId,
          workflowNodeId: workflowDefaults.workflowNodeId,
          phaseId: workflowDefaults.phaseId,
          intakeDefaults,
          intakeOverrides,
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

type NeoOverlayKind = 'none' | 'review' | 'artifacts' | 'terminal' | 'loop' | 'replay'

function WorkbenchNeo({
  session,
  activeSection,
  onSection,
  onSession,
}: {
  session: BlueprintSession | null
  activeSection: WorkbenchSection
  onSection: (section: WorkbenchSection) => void
  onSession: (session: BlueprintSession) => void
}) {
  const [activeStageKey, setActiveStageKey] = useState<string | null>(null)
  const [overlay, setOverlay] = useState<NeoOverlayKind>('none')
  const [look, setLook] = useNeoLook()
  // M42.7 — fetch the LLM model alias catalog so each stage row can render a
  // model picker. Cached for 5 min — the gateway reloads on restart and the
  // list is short, so we trade freshness for quietness.
  const modelCatalogQuery = useQuery({
    queryKey: ['llm-models'],
    queryFn: () => api.listModelAliases(),
    staleTime: 5 * 60 * 1000,
  })
  const modelCatalog: LlmModelCatalogEntry[] = modelCatalogQuery.data?.models ?? []
  const defaultModelAlias =
    session?.executionConfig?.modelAlias ||
    modelCatalogQuery.data?.default_model_alias ||
    undefined
  const stageModelAliases: Record<string, string> = session?.executionConfig?.stageModelAliases ?? {}
  const updateStageModelMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Parameters<typeof api.updateSettings>[1] }) =>
      api.updateSettings(id, body),
    onSuccess: updated => onSession(updated),
  })
  const stages = session?.loopDefinition?.stages ?? []
  const firstStageKey = stages[0]?.key ?? null

  useEffect(() => {
    if (!session) {
      setActiveStageKey(null)
      setOverlay('none')
      return
    }
    setActiveStageKey(session.currentStageKey ?? firstStageKey)
  }, [session?.id, session?.currentStageKey, firstStageKey])

  // Mirror external section requests into the overlay state so the
  // host AppSwitcher can still pop the Artifacts / Terminal views.
  useEffect(() => {
    if (activeSection === 'artifacts') setOverlay('artifacts')
    else if (activeSection === 'terminal') setOverlay('terminal')
    else if (activeSection === 'loop') setOverlay('loop')
    else if (activeSection === 'replay') setOverlay('replay')
    else if (overlay === 'artifacts' || overlay === 'terminal' || overlay === 'loop' || overlay === 'replay') setOverlay('none')
  }, [activeSection])

  const activeStage = stages.find(stage => stage.key === activeStageKey) ?? stages[0]
  const activeAttempt = session && activeStage ? attemptsFor(session, activeStage.key).at(-1) : undefined
  const canReview = Boolean(session && activeStage && activeAttempt && isDeveloperStage(activeStage))

  const closeOverlay = (reset = true) => {
    setOverlay('none')
    if (reset) onSection('workflow')
  }

  if (!session) {
    return (
      <section className="empty-workbench neo-empty">
        <Sparkles size={32} />
        <h2>Start guided delivery</h2>
        <p>Create or select a Workbench session. Neo will keep stages, evidence, artifacts, code review, and approvals in one cockpit.</p>
      </section>
    )
  }

  // M41.5 — lookClass(look) yields the .neo-cockpit-root wrapper class
  // with three orthogonal modifiers (color theme, surface mode,
  // font family) that scope every --neo-* CSS variable. The LoopRail,
  // FocusPane, LiveCockpit, StageChat AND overlays all inherit the
  // same look so the cockpit feels like a single coherent surface.
  return (
    <div className={lookClass(look)}>
      <NeoNotifier session={session} />
      <section className="neo-shell neo-cockpit-shell">
        <LoopRail
          session={session}
          activeStageKey={activeStage?.key ?? null}
          onStage={(key) => {
            setActiveStageKey(key)
            setOverlay('none')
            onSection('workflow')
          }}
          modelCatalog={modelCatalog}
          stageModelAliases={stageModelAliases}
          defaultModelAlias={defaultModelAlias}
          onStageModelChange={(stageKey, alias) => {
            // M42.7 — patch stageModelAliases via /settings. We merge the
            // current map with the new pick (or delete the key when alias is
            // null) so other pinned stages keep their model.
            const next = { ...stageModelAliases }
            if (alias) next[stageKey] = alias
            else delete next[stageKey]
            updateStageModelMutation.mutate({ id: session.id, body: { stageModelAliases: next } })
          }}
          footer={<NeoThemePicker value={look} onChange={setLook} />}
        />

        <div className="neo-center-column">
          <NeoStageController
            session={session}
            stage={activeStage}
            onSession={onSession}
            canReview={canReview}
            onOpenReview={() => canReview && setOverlay('review')}
            onOpenArtifacts={() => { setOverlay('artifacts'); onSection('artifacts') }}
            onOpenTerminal={() => { setOverlay('terminal'); onSection('terminal') }}
          />
          <FinalizeStrip session={session} onSession={onSession} />
        </div>

        {/* LiveCockpit needs a workflow instance id to subscribe to the
            SSE stream. Standalone Workbench sessions without a linked
            workflow run get an explanatory empty state instead of a
            permanent connection error. */}
        <LiveCockpit
          workflowInstanceId={session.workflowInstanceId ?? null}
          authToken={getToken()}
        />
      </section>

      {/* M41.2 — Stage Chat docked at the bottom, persistent across stage
          navigation. Drops operator hints that feed into the next attempt. */}
      <div className="neo-bottom-dock">
        <StageChat
          sessionId={session.id}
          stage={activeStage}
          seedThread={activeStage ? session.stageChats?.[activeStage.key] : undefined}
        />
      </div>

      {overlay === 'review' && activeStage && activeAttempt && canReview && (
        <NeoOverlayShell title={`Code review · ${activeStage.label}`} onClose={() => closeOverlay(false)}>
          <DeveloperCodeReview session={session} stage={activeStage} latest={activeAttempt} layout="wide" />
        </NeoOverlayShell>
      )}
      {overlay === 'artifacts' && (
        <NeoOverlayShell title="Artifacts" onClose={() => closeOverlay()}>
          <AssetRail session={session} activeStageKey={activeStage?.key} onSession={onSession} />
        </NeoOverlayShell>
      )}
      {overlay === 'terminal' && (
        <NeoOverlayShell title="Event log" onClose={() => closeOverlay()}>
          <WorkbenchTerminal session={session} />
        </NeoOverlayShell>
      )}
      {overlay === 'loop' && (
        <NeoOverlayShell title="Agent loop" onClose={() => closeOverlay()}>
          <LoopTrace
            sessionId={session.id}
            stage={activeStage}
            attemptStatus={activeAttempt?.status}
          />
        </NeoOverlayShell>
      )}
      {overlay === 'replay' && (
        <NeoOverlayShell title="Workflow replay" onClose={() => closeOverlay()}>
          <WorkflowReplay session={session} stages={stages} />
        </NeoOverlayShell>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// M59 — Workflow Replay (the "flight recorder").
//
// Stitches everything we already capture in session.metadata into a single
// chronological view, no LLM calls required:
//
//   • stage attempts (verdict, duration, tokens, $cost, phaseTokens)
//   • review events (verdicts, send-backs, attempt resets, chat)
//   • artifacts produced per stage
//   • for Developer attempts: drill into the existing LoopTrace component
//     (M45) which already renders the per-phase ReAct breakdown.
//
// Pure read from session data + the existing /loop-trace endpoint. No new
// server endpoints required.
// ─────────────────────────────────────────────────────────────────────────

function WorkflowReplay({ session, stages }: { session: BlueprintSession; stages: LoopStage[] }) {
  const [expandedKey, setExpandedKey] = useState<string | null>(null)
  const attempts = session.stageAttempts ?? []
  const reviewEvents = session.reviewEvents ?? []
  // Merge: every attempt becomes a row; review events get sorted in by createdAt.
  // Send-backs and resets are surfaced as inline markers between stages.
  const rowsByStage = useMemo(() => {
    const grouped = new Map<string, StageAttempt[]>()
    for (const a of attempts) {
      const arr = grouped.get(a.stageKey) ?? []
      arr.push(a)
      grouped.set(a.stageKey, arr)
    }
    for (const arr of grouped.values()) {
      arr.sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? ''))
    }
    return grouped
  }, [attempts])

  const totals = useMemo(() => {
    let tokens = 0
    let cost = 0
    let calls = 0
    for (const a of attempts) {
      tokens += a.tokensUsed?.total ?? 0
      const c = a.tokensUsed?.estimatedCost
      if (typeof c === 'number') cost += c
      calls += 1
    }
    return { tokens, cost, calls }
  }, [attempts])

  if (attempts.length === 0 && reviewEvents.length === 0) {
    return <p className="cockpit-empty">No attempts yet — nothing to replay.</p>
  }

  return (
    <div className="workflow-replay">
      <div className="replay-summary">
        <span><strong>{attempts.length}</strong> attempts</span>
        <span><strong>{totals.tokens.toLocaleString()}</strong> tokens</span>
        {totals.cost > 0 && <span><strong>{formatUsd(totals.cost)}</strong> spent</span>}
        <span><strong>{reviewEvents.length}</strong> review events</span>
      </div>
      <ol className="replay-stage-list">
        {stages.map(stage => {
          const stageAttempts = rowsByStage.get(stage.key) ?? []
          const stageReviewEvents = reviewEvents.filter(e => e.stageKey === stage.key)
          const stageTokens = stageAttempts.reduce((s, a) => s + (a.tokensUsed?.total ?? 0), 0)
          const stageCost = stageAttempts.reduce((s, a) => s + (typeof a.tokensUsed?.estimatedCost === 'number' ? a.tokensUsed.estimatedCost : 0), 0)
          const lastAttempt = stageAttempts.at(-1)
          const finalVerdict = lastAttempt?.verdict ?? null
          return (
            <li key={stage.key} className={`replay-stage ${finalVerdict?.toLowerCase() ?? 'pending'}`}>
              <header>
                <span className="stage-role">{stage.agentRole ?? '—'}</span>
                <strong>{stage.label}</strong>
                <span className="stage-meta">
                  {stageAttempts.length} attempt{stageAttempts.length === 1 ? '' : 's'}
                  {stageTokens > 0 && ` · ${stageTokens.toLocaleString()} tokens`}
                  {stageCost > 0 && ` · ${formatUsd(stageCost)}`}
                </span>
                {finalVerdict && <span className={`verdict-badge ${finalVerdict.toLowerCase()}`}>{finalVerdict}</span>}
              </header>
              {stageAttempts.length === 0 && (
                <p className="replay-empty">No attempts yet.</p>
              )}
              {stageAttempts.map(attempt => {
                const key = `${stage.key}/${attempt.id}`
                const expanded = expandedKey === key
                const duration = attempt.completedAt && attempt.startedAt
                  ? new Date(attempt.completedAt).getTime() - new Date(attempt.startedAt).getTime()
                  : null
                return (
                  <article key={attempt.id} className={`replay-attempt ${expanded ? 'expanded' : ''}`}>
                    <button type="button" className="replay-attempt-head" onClick={() => setExpandedKey(expanded ? null : key)}>
                      <span className="attempt-num">#{attempt.attemptNumber}</span>
                      <span className={`attempt-status ${attempt.status?.toLowerCase() ?? ''}`}>{attempt.status ?? '—'}</span>
                      {attempt.verdict && <span className={`verdict-badge inline ${attempt.verdict.toLowerCase()}`}>{attempt.verdict}</span>}
                      <span className="attempt-time">
                        {attempt.startedAt && new Date(attempt.startedAt).toLocaleTimeString()}
                        {duration !== null && ` · ${(duration / 1000).toFixed(1)}s`}
                      </span>
                      {(attempt.tokensUsed?.total ?? 0) > 0 && (
                        <span className="attempt-tokens">{attempt.tokensUsed!.total!.toLocaleString()} tok</span>
                      )}
                      {typeof attempt.tokensUsed?.estimatedCost === 'number' && attempt.tokensUsed.estimatedCost > 0 && (
                        <span className="attempt-cost">{formatUsd(attempt.tokensUsed.estimatedCost)}</span>
                      )}
                      <span className="caret">{expanded ? '▾' : '▸'}</span>
                    </button>
                    {expanded && (
                      <div className="replay-attempt-body">
                        <PhaseTokensStrip attempt={attempt} />
                        {attempt.response && (
                          <details>
                            <summary>Final response ({attempt.response.length.toLocaleString()} chars)</summary>
                            <pre className="replay-response">{attempt.response.slice(0, 2000)}{attempt.response.length > 2000 ? '\n…(truncated)' : ''}</pre>
                          </details>
                        )}
                        {attempt.error && (
                          <p className="replay-error"><strong>Error:</strong> {attempt.error}</p>
                        )}
                        {(attempt.artifactIds?.length ?? 0) > 0 && (
                          <p className="replay-artifacts">
                            <strong>Artifacts:</strong> {attempt.artifactIds!.length} produced
                          </p>
                        )}
                        {(attempt.correlation as { traceId?: string } | undefined)?.traceId && isDeveloperStage(stage) && (
                          <details className="replay-loop-trace">
                            <summary>Show ReAct loop (phases, LLM calls, tool invocations)</summary>
                            <LoopTrace
                              sessionId={session.id}
                              stage={stage}
                              attemptStatus={attempt.status}
                            />
                          </details>
                        )}
                      </div>
                    )}
                  </article>
                )
              })}
              {stageReviewEvents.length > 0 && (
                <ul className="replay-review-events">
                  {stageReviewEvents.map(ev => (
                    <li key={ev.id} className={`review-event ${ev.type.toLowerCase().replaceAll('_', '-')}`}>
                      <time>{new Date(ev.createdAt).toLocaleTimeString()}</time>
                      <span className="ev-type">{ev.type.replaceAll('_', ' ')}</span>
                      <span>{ev.message}</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          )
        })}
      </ol>
    </div>
  )
}

function NeoOverlayShell({
  title,
  onClose,
  children,
}: {
  title: string
  onClose: () => void
  children: ReactNode
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="neo-overlay-scrim" role="dialog" aria-modal="true" aria-label={title}>
      <div className="neo-overlay-card">
        <header className="neo-overlay-head">
          <strong>{title}</strong>
          <button type="button" className="neo-overlay-close" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>
        <div className="neo-overlay-body">
          {children}
        </div>
      </div>
    </div>
  )
}

function NeoStageController({
  session,
  stage,
  onSession,
  canReview,
  onOpenReview,
  onOpenArtifacts,
  onOpenTerminal,
}: {
  session: BlueprintSession
  stage: LoopStage | undefined
  onSession: (session: BlueprintSession) => void
  canReview: boolean
  onOpenReview: () => void
  onOpenArtifacts: () => void
  onOpenTerminal: () => void
}) {
  const [answers, setAnswers] = useState<Record<string, DecisionAnswer>>({})
  const [feedback, setFeedback] = useState('')
  const [acceptRisk, setAcceptRisk] = useState(false)
  const [sendBackOpen, setSendBackOpen] = useState(false)
  const [sendBackTarget, setSendBackTarget] = useState('')
  const [sendBackReason, setSendBackReason] = useState('')
  const [requiredChanges, setRequiredChanges] = useState('')

  // Hydrate answers from the session whenever the source-of-truth answers change.
  useEffect(() => {
    setAnswers(Object.fromEntries((session.decisionAnswers ?? []).map(a => [a.questionId, a])))
  }, [session.id, session.decisionAnswers])

  // Reset per-stage controls when the user switches stages.
  useEffect(() => {
    setFeedback('')
    setAcceptRisk(false)
    setSendBackOpen(false)
    setSendBackTarget(stage?.allowedSendBackTo?.[0] ?? '')
    setSendBackReason('')
    setRequiredChanges('')
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
    onSuccess: (next) => {
      setSendBackOpen(false)
      onSession(next)
    },
  })
  const resetAttemptsMutation = useMutation({
    mutationFn: () => {
      if (!stage) throw new Error('No stage selected')
      return api.resetStageAttempts(session.id, stage.key)
    },
    onSuccess: onSession,
  })
  const approvalMutation = useMutation({
    mutationFn: (decision: 'approved' | 'rejected') => {
      if (!stage) throw new Error('No stage selected')
      return api.stageApproval(session.id, stage.key, {
        decision,
        reason: feedback.trim() || (decision === 'approved' ? 'Approved from Workbench Neo' : 'Rejected from Workbench Neo'),
      })
    },
    onSuccess: onSession,
  })

  if (!stage) {
    return <FocusPane stage={undefined} latest={undefined} intent="idle" />
  }

  const latest = attemptsFor(session, stage.key).at(-1)
  const stageAttemptCount = attemptsFor(session, stage.key).length
  const maxLoopsForStage = session.loopDefinition?.maxLoopsPerStage ?? 3
  const requiredMissing = (stage.questions ?? [])
    .filter(q => q.required && !hasAnswerForQuestion(q, answerList(answers)))
    .map(q => q.id)
  const hasUnansweredRequired = requiredMissing.length > 0
  const intent = computeFocusIntent(stage, latest, hasUnansweredRequired)
  const stageArtifacts = session.artifacts.filter(a => a.stageKey === stage.key)
  const confidence = latest?.gateRecommendation?.confidence
  const pendingApproval = pendingApprovalFor(latest)

  const mutationError = (runMutation.error ?? verdictMutation.error ?? sendBackMutation.error ?? resetAttemptsMutation.error ?? approvalMutation.error)?.message ?? null

  // Compose the FocusPane body based on intent.
  const body: ReactNode = (
    <>
      {intent === 'answer' && (
        <div className="focus-questions">
          {(stage.questions ?? []).filter(q => q.required && !hasAnswerForQuestion(q, answerList(answers))).map(question => (
            <QuestionAnswerCard
              key={question.id}
              question={question}
              answer={answerForQuestion(question, answerList(answers))}
              onAnswer={(answer) => setAnswers(current => ({ ...current, [question.id]: answer }))}
            />
          ))}
          {(stage.questions ?? []).some(q => !q.required) && (
            <details className="focus-question-extras">
              <summary>Optional questions ({(stage.questions ?? []).filter(q => !q.required).length})</summary>
              {(stage.questions ?? []).filter(q => !q.required).map(question => (
                <QuestionAnswerCard
                  key={question.id}
                  question={question}
                  answer={answerForQuestion(question, answerList(answers))}
                  onAnswer={(answer) => setAnswers(current => ({ ...current, [question.id]: answer }))}
                />
              ))}
            </details>
          )}
        </div>
      )}

      {(intent === 'approve' || intent === 'rework' || intent === 'completed' || intent === 'running' || intent === 'mcp-approval') && latest?.response && (
        <div className="focus-response">
          <header>
            <strong>Latest stage output</strong>
            {latest.correlation && <code>{String(latest.correlation.cfCallId ?? latest.correlation.traceId ?? latest.id).slice(0, 36)}</code>}
          </header>
          <MarkdownView content={latest.response} />
        </div>
      )}

      {intent === 'mcp-approval' && (
        <div className="focus-approval-card">
          <header>
            <strong>{toolNameFromApproval(pendingApproval)}</strong>
            <code>{String(pendingApproval?.continuation_token ?? latest?.correlation?.cfCallId ?? latest?.id ?? '').slice(0, 36)}</code>
          </header>
          <pre>{formatApprovalArgs(pendingApproval)}</pre>
          <label className="focus-feedback">
            <span>Approval note</span>
            <textarea
              rows={3}
              value={feedback}
              onChange={e => setFeedback(e.target.value)}
              placeholder="Reason for approving, rejecting, or changing the requested tool call."
            />
          </label>
        </div>
      )}

      {intent === 'approve' && (
        <div className="focus-verdict-extras">
          <label className="focus-feedback">
            <span>Review feedback (optional)</span>
            <textarea
              rows={3}
              value={feedback}
              onChange={e => setFeedback(e.target.value)}
              placeholder="Why this passes, what risk is accepted, or what must change."
            />
          </label>
          {requiredMissing.length > 0 && (
            <label className="focus-risk-toggle">
              <input type="checkbox" checked={acceptRisk} onChange={e => setAcceptRisk(e.target.checked)} />
              <span>Accept risk with unanswered required questions: {requiredMissing.join(', ')}</span>
            </label>
          )}
        </div>
      )}

      {sendBackOpen && (stage.allowedSendBackTo ?? []).length > 0 && (
        <div className="focus-sendback">
          <header>
            <strong>Send back</strong>
            <button type="button" className="focus-sendback-cancel" onClick={() => setSendBackOpen(false)}>Cancel</button>
          </header>
          <div className="focus-sendback-grid">
            <label>
              <span>Target stage</span>
              <select value={sendBackTarget} onChange={e => setSendBackTarget(e.target.value)}>
                {(stage.allowedSendBackTo ?? []).map(key => (
                  <option key={key} value={key}>{stageLabel(session, key)}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Reason</span>
              <input value={sendBackReason} onChange={e => setSendBackReason(e.target.value)} placeholder="What failed?" />
            </label>
          </div>
          <label>
            <span>Required changes</span>
            <textarea rows={2} value={requiredChanges} onChange={e => setRequiredChanges(e.target.value)} placeholder="What must the earlier stage fix before coming back?" />
          </label>
          <button
            className="focus-sendback-submit"
            disabled={!sendBackTarget || sendBackReason.trim().length < 3 || sendBackMutation.isPending}
            onClick={() => sendBackMutation.mutate()}
          >
            {sendBackMutation.isPending ? '↻ ' : '↩ '}Send stage back
          </button>
        </div>
      )}

      {/* M58 — Loop-limit banner.
            Previously suppressed for intent==='completed' (the last attempt
            passed) under the assumption that operators wouldn't try to
            re-run a passed stage. In practice they do — to regenerate with
            new context, after sending back from a later stage, etc. — and
            the server's "reached the max loop count (3)" rejection then
            had no in-UI escape hatch. Surface Reset whenever the loop
            limit is hit regardless of intent. */}
      {stageAttemptCount >= maxLoopsForStage && (
        <div className="focus-loop-warning">
          <strong>Loop limit reached</strong>
          <p>This stage has used {stageAttemptCount}/{maxLoopsForStage} attempts. Reset to retry.</p>
          <button
            className="focus-secondary"
            disabled={resetAttemptsMutation.isPending}
            onClick={() => resetAttemptsMutation.mutate()}
          >
            {resetAttemptsMutation.isPending ? '↻ ' : '⟲ '}Reset this stage
          </button>
        </div>
      )}
      {/* M58 — Surface the loop-cap error inline next to the Reset button.
            workgraph-api rejects re-runs with "Stage X reached the max loop
            count (N)"; before this fix the error landed in a generic toast
            with no contextual recovery action. */}
      {runMutation.isError && /reached the max loop count/i.test(runMutation.error?.message ?? '') && stageAttemptCount < maxLoopsForStage * 2 && (
        <div className="focus-loop-warning" role="alert">
          <strong>{runMutation.error?.message}</strong>
          <p>Reset this stage's attempts to start over with a clean slate.</p>
          <button
            className="focus-secondary"
            disabled={resetAttemptsMutation.isPending}
            onClick={() => resetAttemptsMutation.mutate()}
          >
            {resetAttemptsMutation.isPending ? '↻ ' : '⟲ '}Reset this stage
          </button>
        </div>
      )}
    </>
  )

  // Badges — small chips under the title.
  const badges: ReactNode = (
    <>
      <span className="focus-badge role">{roleMeta(stage.agentRole).label}</span>
      <span className="focus-badge attempts">attempt #{Math.max(1, stageAttemptCount)}</span>
      {typeof confidence === 'number' && (
        <span className={`focus-badge confidence ${confidence > 0.7 ? 'ok' : 'mid'}`}>
          {Math.round(confidence * 100)}% confidence
        </span>
      )}
      <span className="focus-badge artifacts">{stageArtifacts.length} artifact{stageArtifacts.length === 1 ? '' : 's'}</span>
      {canReview && (
        <button type="button" className="focus-badge link" onClick={onOpenReview}>open code review →</button>
      )}
      <button type="button" className="focus-badge link" onClick={onOpenArtifacts}>artifacts →</button>
      <button type="button" className="focus-badge link" onClick={onOpenTerminal}>event log →</button>
    </>
  )

  // Decide the primary CTA based on intent.
  let primaryAction: FocusAction | undefined
  let secondaryActions: FocusAction[] = []
  let helperText: string | undefined

  if (intent === 'answer') {
    primaryAction = {
      label: 'Answer & continue',
      onClick: () => verdictMutation.mutate('PASS'),
      disabled: hasUnansweredRequired,
      busy: verdictMutation.isPending,
    }
    helperText = hasUnansweredRequired
      ? `Provide answers to ${requiredMissing.length} required question${requiredMissing.length === 1 ? '' : 's'} to unblock the agent.`
      : 'All required questions answered.'
  } else if (intent === 'run') {
    primaryAction = {
      label: session.snapshots[0] ? 'Run stage' : 'Snapshot + run',
      onClick: () => runMutation.mutate(),
      busy: runMutation.isPending,
    }
    helperText = session.snapshots[0]
      ? 'Sends task + context to the agent loop.'
      : 'A workspace snapshot will be created first.'
  } else if (intent === 'running') {
    primaryAction = undefined
    helperText = 'The cockpit on the right shows tool calls and tokens as they happen.'
  } else if (intent === 'mcp-approval') {
    primaryAction = {
      label: 'Approve MCP action',
      onClick: () => approvalMutation.mutate('approved'),
      busy: approvalMutation.isPending,
      disabled: !pendingApproval,
    }
    secondaryActions = [
      { label: 'Reject action', onClick: () => approvalMutation.mutate('rejected'), busy: approvalMutation.isPending },
    ]
    helperText = pendingApproval
      ? 'Approval resumes the same MCP loop with the saved continuation token.'
      : 'This attempt is paused but the continuation token is missing.'
  } else if (intent === 'approve') {
    // M54.B — Staleness guard. If the operator answered (or edited) decision
    // answers AFTER the current attempt finished, the attempt's output didn't
    // see those answers — approving it would advance a stale artifact. Block
    // approval and point them at "Re-run stage" or the clarification modal's
    // "Save & re-run with answers" button.
    const answersUpdatedAt = session.metadata?.decisionAnswersUpdatedAt
    const attemptCompletedAt = latest?.completedAt
    const answersStale = Boolean(
      answersUpdatedAt &&
      attemptCompletedAt &&
      new Date(answersUpdatedAt).getTime() > new Date(attemptCompletedAt).getTime(),
    )
    primaryAction = {
      label: 'Approve & advance',
      onClick: () => verdictMutation.mutate('PASS'),
      busy: verdictMutation.isPending,
      disabled: answersStale,
    }
    secondaryActions = [
      ...(answersStale ? [{
        label: 'Re-run with answers',
        onClick: () => runMutation.mutate(),
        busy: runMutation.isPending,
      }] : []),
      { label: 'Accept with risk', onClick: () => verdictMutation.mutate('ACCEPTED_WITH_RISK'), busy: verdictMutation.isPending },
      { label: 'Needs rework', onClick: () => verdictMutation.mutate('NEEDS_REWORK'), busy: verdictMutation.isPending },
    ]
    helperText = answersStale
      ? 'You answered questions AFTER this attempt finished. Click "Re-run with answers" so the agent regenerates with your decisions — otherwise the next stage inherits the pre-answer output. "Accept with risk" still overrides if you really want to advance as-is.'
      : requiredMissing.length > 0 && !acceptRisk
        ? `${requiredMissing.length} required question${requiredMissing.length === 1 ? '' : 's'} still unanswered — tick "Accept risk" to override.`
        : 'Verdict will be recorded in the audit trail.'
  } else if (intent === 'rework') {
    primaryAction = {
      label: session.snapshots[0] ? 'Re-run stage' : 'Snapshot + re-run',
      onClick: () => runMutation.mutate(),
      busy: runMutation.isPending,
      disabled: stageAttemptCount >= maxLoopsForStage,
    }
    secondaryActions = [
      { label: 'Reset attempts', onClick: () => resetAttemptsMutation.mutate(), busy: resetAttemptsMutation.isPending },
    ]
    helperText = stageAttemptCount >= maxLoopsForStage
      ? 'Loop limit hit — reset to try again.'
      : `Attempt ${stageAttemptCount + 1}/${maxLoopsForStage}.`
  } else if (intent === 'completed') {
    primaryAction = {
      label: 'Run again',
      onClick: () => runMutation.mutate(),
      busy: runMutation.isPending,
    }
    helperText = 'Stage is closed. Re-running creates a new attempt with the same inputs.'
  }

  return (
    <FocusPane
      stage={stage}
      latest={latest}
      intent={intent}
      badges={badges}
      body={body}
      primaryAction={primaryAction}
      secondaryActions={secondaryActions.length > 0 ? secondaryActions : undefined}
      onOpenSendBack={() => setSendBackOpen(true)}
      inlineError={mutationError}
      helperText={helperText}
    />
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
  const [isFullReview, setIsFullReview] = useState(false)
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

  useEffect(() => {
    if (!isFullReview) return undefined
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsFullReview(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isFullReview])

  const hasMcpDiff = files.some(file => file.source === 'mcp' && file.hasDiff)
  const hasAnyCapturedMcp = files.some(file => file.source === 'mcp')
  const status = latest.verdict ? verdictLabels[latest.verdict] : latest.status
  const totals = reviewTotals(files)
  const activeStats = activeFile ? reviewFileStats(activeFile) : { additions: 0, deletions: 0, total: 0 }

  return (
    <section className={`code-review-panel ${layout === 'wide' ? 'wide-review' : ''} ${isFullReview ? 'fullscreen-review' : ''}`}>
      <div className="code-review-header">
        <div>
          <span className="stage-key">Developer approval</span>
          <h3><FileCode2 size={16} /> Code review</h3>
          <p>Review changed files and highlighted diffs before approving or sending work back.</p>
        </div>
        <div className="code-review-actions">
          <button
            type="button"
            className="code-review-expand"
            onClick={() => setIsFullReview(current => !current)}
          >
            {isFullReview ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            {isFullReview ? 'Exit full view' : 'Open full view'}
          </button>
          <span className={`status ${latestStatus(latest)}`}>{status}</span>
        </div>
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

  return (
    <section className="control-card asset-rail">
      <div className="panel-heading">
        <BookOpen size={18} />
        <div>
          <h2>Current Assets</h2>
          <p>Contract pack artifacts, versions, and final handoff status.</p>
        </div>
      </div>

      <FinalizeStrip session={session} onSession={onSession} />

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
            <MarkdownView
              content={renderArtifact(active)}
              kind={active?.kind}
              title={active?.title}
            />
          </article>
        </div>
      )}
    </section>
  )
}

function FinalizeStrip({ session, onSession }: { session: BlueprintSession; onSession: (session: BlueprintSession) => void }) {
  const finalizeMutation = useMutation({
    mutationFn: () => api.finalize(session.id),
    onSuccess: (nextSession) => {
      onSession(nextSession)
      notifyWorkflowFinalized(nextSession)
    },
  })
  const green = isLoopGreen(session)
  const workflowLinked = Boolean(session.workflowInstanceId && session.workflowNodeId)
  const title = session.finalPack ? 'Final pack sent' : green ? 'Ready for final handoff' : 'Final handoff locked'
  const summary = session.finalPack?.summary
    ?? (green
      ? workflowLinked
        ? 'All required gates are green. Finalize sends artifacts, consumables, and the final pack back to the workflow, then advances the Workbench node.'
        : 'All required gates are green. Finalize creates the final implementation pack for this standalone session.'
      : 'Pass or accept risk on every required stage before sending the final pack back to the workflow.')

  return (
    <>
      <div className={`finalize-strip ${green && !session.finalPack ? 'ready' : ''} ${session.finalPack ? 'stamped' : ''}`}>
        <div>
          <strong>{title}</strong>
          <span>{summary}</span>
          {session.finalPack?.finalPackConsumableId && (
            <span>Workflow consumable: {session.finalPack.finalPackConsumableId.slice(0, 8)}</span>
          )}
        </div>
        <button
          className="secondary-action approve"
          disabled={!green || Boolean(session.finalPack) || finalizeMutation.isPending}
          onClick={() => finalizeMutation.mutate()}
        >
          {finalizeMutation.isPending ? <Loader2 className="spin" size={15} /> : <BadgeCheck size={15} />}
          {workflowLinked ? 'Finalize + send' : 'Finalize'}
        </button>
      </div>
      {finalizeMutation.isError && <p className="error-text">{finalizeMutation.error.message}</p>}
    </>
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
            <PhaseTokensStrip attempt={attempt} />
          </div>
        ))}
        <div className="terminal-input"><span>TERMINAL &gt;</span><em>Waiting for developer approval...</em></div>
      </div>
    </section>
  )
}

function stageCostEvidence(attempt: StageAttempt) {
  const tokens = attempt.tokensUsed?.total
    ? `${attempt.tokensUsed.total.toLocaleString()} actual tokens`
    : 'actual tokens pending'
  // M56 — append $-cost when the gateway returned a non-null estimate.
  // Null is shown as "—" rather than $0.00 to distinguish "we don't know"
  // from "literally free" (mock provider).
  const cost = attempt.tokensUsed?.estimatedCost
  const costText = typeof cost === 'number' && cost > 0
    ? ` · ${formatUsd(cost)}`
    : ''
  const optimization = attempt.metrics?.contextOptimization
  if (optimization && typeof optimization === 'object' && 'tokens_saved' in optimization) {
    const saved = (optimization as { tokens_saved?: unknown }).tokens_saved
    return `${tokens}${costText} · saved ${saved ?? 0}`
  }
  return `${tokens}${costText}`
}

// M56 — Format USD amounts at the right precision for an LLM agent run.
// Most calls cost fractions of a cent; rolled-up stages tend to be in
// $-cents to $-tens. Use 4 decimals below $0.01, 3 decimals below $1,
// 2 decimals above. Surface "—" when the gateway returned null (catalog
// has no prices for this model).
function formatUsd(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  if (value === 0) return '$0'
  if (value < 0.01) return `$${value.toFixed(4)}`
  if (value < 1) return `$${value.toFixed(3)}`
  return `$${value.toFixed(2)}`
}

// M56 Slice C — Compact per-phase strip. Renders one mini-card per phase
// the attempt actually used, with token sparkline + cost. Source of
// truth: attempt.correlation.phaseTokens (set by mcp-server's
// computePhaseTokens at runLoop exit).
const PHASE_ORDER = ['PLAN_DRAFT', 'EXPLORE', 'PLAN_CONFIRM', 'ACT', 'VERIFY', 'FINALIZE'] as const
const PHASE_LABEL: Record<string, string> = {
  PLAN_DRAFT:  'Plan',
  EXPLORE:     'Explore',
  PLAN_CONFIRM:'Confirm',
  ACT:         'Act',
  VERIFY:      'Verify',
  FINALIZE:    'Final',
  unknown:     'Other',
}

function PhaseTokensStrip({ attempt }: { attempt: StageAttempt }) {
  const phaseTokens = (attempt.correlation as { phaseTokens?: Record<string, { input: number; output: number; cost: number; calls: number }> } | undefined)?.phaseTokens
  if (!phaseTokens || Object.keys(phaseTokens).length === 0) return null
  // Use a stable order: known phases first (in canonical sequence), then
  // anything else (just 'unknown' in practice) at the end.
  const knownInUse = PHASE_ORDER.filter(p => phaseTokens[p])
  const extras = Object.keys(phaseTokens).filter(p => !knownInUse.includes(p as typeof knownInUse[number]))
  const ordered = [...knownInUse, ...extras]
  const maxTotal = ordered.reduce((max, p) => {
    const b = phaseTokens[p]
    return Math.max(max, (b?.input ?? 0) + (b?.output ?? 0))
  }, 1)  // 1 prevents div-by-zero on degenerate input
  const totalCost = ordered.reduce((s, p) => s + (phaseTokens[p]?.cost ?? 0), 0)
  return (
    <div className="phase-tokens-strip" title="Token + cost breakdown per phase">
      {ordered.map(p => {
        const b = phaseTokens[p]
        const t = (b.input + b.output)
        const pct = Math.max(2, Math.round((t / maxTotal) * 100))  // 2% floor so non-zero bars are still visible
        return (
          <span key={p} className="phase-bar" title={`${PHASE_LABEL[p] ?? p}: ${b.input.toLocaleString()} in / ${b.output.toLocaleString()} out · ${b.calls} call${b.calls === 1 ? '' : 's'} · ${formatUsd(b.cost)}`}>
            <em>{PHASE_LABEL[p] ?? p}</em>
            <span className="bar" style={{ width: `${pct}%` }} />
            <small>{t.toLocaleString()}</small>
          </span>
        )
      })}
      {totalCost > 0 && <span className="phase-total">{formatUsd(totalCost)} total</span>}
    </div>
  )
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

function QuestionAnswerCard({
  question,
  answer,
  onAnswer,
}: {
  question: LoopQuestion
  answer?: DecisionAnswer
  onAnswer: (answer: DecisionAnswer) => void
}) {
  const kind = question.type ?? ((question.options?.length ?? 0) > 0 ? 'single_select' : 'freeform')
  const isMulti = kind === 'multi_select'
  const selectedLabels = answer?.answerType === 'multi_option'
    ? answer.selectedOptionLabels ?? []
    : answer?.selectedOptionLabel ? [answer.selectedOptionLabel] : []
  const setFreeform = (value: string) => {
    onAnswer({
      questionId: question.id,
      questionText: question.question,
      normalizedQuestion: normalizeQuestionText(question.question),
      answerType: answer?.answerType === 'option' || answer?.answerType === 'multi_option' ? answer.answerType : 'freeform',
      selectedOptionLabel: answer?.selectedOptionLabel,
      selectedOptionLabels: answer?.selectedOptionLabels,
      customAnswer: value,
      notes: answer?.notes,
    })
  }
  const toggleOption = (label: string) => {
    if (isMulti) {
      const next = selectedLabels.includes(label)
        ? selectedLabels.filter(item => item !== label)
        : [...selectedLabels, label]
      onAnswer({
        questionId: question.id,
        questionText: question.question,
        normalizedQuestion: normalizeQuestionText(question.question),
        answerType: 'multi_option',
        selectedOptionLabels: next,
        customAnswer: answer?.customAnswer,
        notes: answer?.notes,
      })
      return
    }
    onAnswer({
      questionId: question.id,
      questionText: question.question,
      normalizedQuestion: normalizeQuestionText(question.question),
      answerType: 'option',
      selectedOptionLabel: label,
      customAnswer: answer?.customAnswer,
      notes: answer?.notes,
    })
  }

  return (
    <section className={`question-card ${question.source === 'llm_open_question' ? 'generated' : ''}`}>
      <div>
        <strong>{question.question}</strong>
        <code>
          {question.id}{question.required ? ' · required' : ''}{question.source === 'llm_open_question' ? ' · from LLM' : ''}
        </code>
      </div>
      {question.options && question.options.length > 0 && (
        <div className="option-grid">
          {question.options.map(option => (
            <button
              type="button"
              key={option.label}
              className={`option-card ${selectedLabels.includes(option.label) ? 'selected' : ''}`}
              onClick={() => toggleOption(option.label)}
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
          value={answer?.customAnswer ?? ''}
          onChange={event => setFreeform(event.target.value)}
          placeholder={kind === 'clarification' ? 'Answer the clarification or add constraints' : 'Free-form answer, constraints, or stakeholder note'}
        />
      )}
    </section>
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
  if (attempt.status === 'PAUSED') return 'paused'
  if (attempt.status === 'RUNNING') return 'running'
  return 'completed'
}

function pendingApprovalFor(attempt?: StageAttempt): Record<string, unknown> | null {
  if (!attempt) return null
  return asRecord(attempt.pendingApproval)
    ?? asRecord(attempt.correlation?.pendingApproval)
    ?? null
}

function toolNameFromApproval(approval: Record<string, unknown> | null): string {
  const raw = approval?.tool_name
  return typeof raw === 'string' && raw.trim() ? raw.trim() : 'Pending MCP approval'
}

function formatApprovalArgs(approval: Record<string, unknown> | null): string {
  const args = asRecord(approval?.tool_args) ?? asRecord(approval?.tool_descriptor) ?? approval
  if (!args) return 'No tool arguments were included.'
  try {
    const pretty = JSON.stringify(args, null, 2)
    return pretty.length > 4000 ? `${pretty.slice(0, 4000)}\n... truncated` : pretty
  } catch {
    return String(args)
  }
}

function isLoopGreen(session: BlueprintSession) {
  const stages = session.loopDefinition?.stages ?? []
  return stages.filter(stage => stage.required !== false).every(stage => {
    const latest = attemptsFor(session, stage.key).at(-1)
    return latest?.verdict === 'PASS' || latest?.verdict === 'ACCEPTED_WITH_RISK'
  })
}

function unansweredClarificationQuestions(session: BlueprintSession, stage: LoopStage) {
  const latest = attemptsFor(session, stage.key).at(-1)
  if (!latest || latest.status === 'RUNNING' || latest.status === 'PAUSED' || latest.verdict) return []
  const generatedIds = new Set(latest.generatedQuestionIds ?? [])
  return (stage.questions ?? []).filter(question => {
    const generated = question.source === 'llm_open_question' || generatedIds.has(question.id)
    return generated && !hasAnswerForQuestion(question, session.decisionAnswers ?? [])
  })
}

function answerList(answers: Record<string, DecisionAnswer>) {
  return Object.values(answers).filter(hasAnswer)
}

function hasAnswer(answer?: DecisionAnswer) {
  return Boolean(
    answer?.selectedOptionLabel?.trim()
    || answer?.selectedOptionLabels?.some(label => label.trim())
    || answer?.customAnswer?.trim()
    || answer?.notes?.trim(),
  )
}

function normalizeQuestionText(value?: string) {
  return (value ?? '')
    .toLowerCase()
    .replace(/["'`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(the|a|an|please|should|could|would|do|does|is|are|there|any)\b/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

function answerForQuestion(question: LoopQuestion, answers: DecisionAnswer[]) {
  const direct = answers.find(answer => answer.questionId === question.id && hasAnswer(answer))
  if (direct) return direct
  const normalized = normalizeQuestionText(question.question)
  if (!normalized) return undefined
  return answers.find(answer => {
    if (!hasAnswer(answer)) return false
    return questionKeysMatch(answer.normalizedQuestion || normalizeQuestionText(answer.questionText), normalized)
  })
}

function hasAnswerForQuestion(question: LoopQuestion, answers: DecisionAnswer[]) {
  return Boolean(answerForQuestion(question, answers))
}

function questionKeysMatch(left?: string, right?: string) {
  if (!left || !right) return false
  if (left === right) return true
  const leftTokens = new Set(left.split(' ').filter(token => token.length > 2))
  const rightTokens = new Set(right.split(' ').filter(token => token.length > 2))
  if (leftTokens.size < 4 || rightTokens.size < 4) return false
  let shared = 0
  leftTokens.forEach(token => {
    if (rightTokens.has(token)) shared += 1
  })
  return shared / Math.min(leftTokens.size, rightTokens.size) >= 0.72
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

function defaultSourceFromCapability(capability?: LookupCapability): { sourceType: SourceType; sourceUri: string; sourceRef?: string; provenance: string } | undefined {
  if (!capability) return undefined
  const repositories = Array.isArray(capability.repositories) ? capability.repositories : []
  const primaryRepo = repositories.find(repo => String(repo.status ?? '').toUpperCase() === 'ACTIVE')
    ?? repositories[0]
  const sourceUri = cleanText(primaryRepo?.repoUrl)
    ?? cleanText(capability.repoUrl)
    ?? cleanText(capability.sourceUri)
    ?? cleanText(asRecord(capability.metadata)?.repoUrl)
    ?? cleanText(asRecord(capability.metadata)?.githubUrl)
    ?? cleanText(asRecord(capability.metadata)?.sourceUri)
  if (!sourceUri) return undefined
  const repoType = cleanText(primaryRepo?.repositoryType) ?? cleanText(capability.sourceType)
  const sourceType: SourceType = repoType?.toUpperCase() === 'LOCAL' || sourceUri.startsWith('local://') ? 'localdir' : 'github'
  return {
    sourceType,
    sourceUri,
    sourceRef: cleanText(primaryRepo?.defaultBranch) ?? cleanText(capability.defaultBranch),
    provenance: `capability repository (${capability.name})`,
  }
}

function csv(value: string) {
  return value.split(',').map(item => item.trim()).filter(Boolean)
}

function cleanStageModelAliases(value: Record<string, string>) {
  const out: Record<string, string> = {}
  for (const [key, alias] of Object.entries(value)) {
    const trimmed = alias.trim()
    if (key.trim() && trimmed) out[key.trim()] = trimmed
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function hasLoopAgentTemplates(loopDefinition: unknown) {
  if (!loopDefinition || typeof loopDefinition !== 'object' || Array.isArray(loopDefinition)) return false
  const stages = (loopDefinition as { stages?: unknown }).stages
  return Array.isArray(stages) && stages.some(stage =>
    Boolean(stage && typeof stage === 'object' && !Array.isArray(stage) && typeof (stage as { agentTemplateId?: unknown }).agentTemplateId === 'string' && (stage as { agentTemplateId: string }).agentTemplateId.trim()),
  )
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
  const resolvedGoal = goalFromWorkflowContext(context, rendered)
  return {
    goal: resolvedGoal.goal,
    goalProvenance: resolvedGoal.provenance,
    sourceType,
    sourceUri: cleanText(rendered.sourceUri),
    sourceRef: cleanText(rendered.sourceRef),
    sourceProvenance: cleanText(rendered.sourceUri) ? 'workflow source mapping' : undefined,
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

function goalFromWorkflowContext(context: Record<string, unknown>, rendered: Record<string, unknown>): { goal?: string; provenance?: string } {
  const vars = asRecord(context._vars) ?? {}
  const workItem = asRecord(context._workItem)
    ?? asRecord(context.workItem)
    ?? asRecord(vars.workItem)
    ?? undefined
  const details = asRecord(workItem?.details) ?? asRecord(vars.workItemDetails) ?? {}
  const input = asRecord(workItem?.input) ?? asRecord(details.input) ?? {}
  const fromWorkItem = firstCleanText(
    joinedTitleDescription(workItem?.title, workItem?.description),
    joinedTitleDescription(details.title, details.description),
    details.request,
    details.story,
    details.goal,
    details.description,
    input.story,
    input.goal,
    input.description,
    vars.story,
    vars.goal,
  )
  if (fromWorkItem) return { goal: fromWorkItem, provenance: 'WorkItem packet' }
  const fromWorkflow = firstCleanText(
    vars.story,
    vars.goal,
    context.story,
    context.goal,
    rendered.goal,
    rendered.task,
  )
  if (fromWorkflow) return { goal: fromWorkflow, provenance: 'workflow context' }
  return {}
}

function joinedTitleDescription(title: unknown, description: unknown): string | undefined {
  const cleanTitle = cleanText(title)
  const cleanDescription = cleanText(description)
  if (cleanTitle && cleanDescription && cleanTitle !== cleanDescription) return `${cleanTitle}\n\n${cleanDescription}`
  return cleanDescription ?? cleanTitle
}

function firstCleanText(...values: unknown[]): string | undefined {
  for (const value of values) {
    const text = cleanText(value)
    if (text) return text
  }
  return undefined
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

function normalizeOrigin(value?: string): string | undefined {
  if (!value?.trim()) return undefined
  try {
    return new URL(value).origin
  } catch {
    return undefined
  }
}

function isAllowedWorkbenchHostOrigin(origin: string) {
  return origin === WORKGRAPH_WEB_ORIGIN || origin === window.location.origin
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
    browserRunId: cleanQueryParam(params.get('browserRunId')),
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

function sessionMatchesWorkflowDefaults(session: BlueprintSession, defaults: ReturnType<typeof readWorkflowDefaults>) {
  const browserRunId = defaults.browserRunId ?? defaults.workflowInstanceId
  if (browserRunId && defaults.workflowNodeId && session.metadata?.browserRunId === browserRunId && session.workflowNodeId === defaults.workflowNodeId) {
    return true
  }
  return Boolean(
    defaults.workflowInstanceId
    && defaults.workflowNodeId
    && session.workflowInstanceId === defaults.workflowInstanceId
    && session.workflowNodeId === defaults.workflowNodeId,
  )
}

function cleanQueryParam(value: string | null): string | undefined {
  const text = value?.trim()
  if (!text || /\{\{[^}]+}}/.test(text)) return undefined
  return text
}

function notifyWorkflowFinalized(session: BlueprintSession) {
  if (typeof window === 'undefined') return
  const stageConsumables = collectStageConsumables(session)
  const workbenchDocuments = collectWorkbenchDocuments(session)
  const consumableIds = Array.from(new Set([
    ...(session.finalPack?.consumableIds ?? []),
    ...stageConsumables.map(ref => ref.consumableId).filter(Boolean),
    session.finalPack?.finalPackConsumableId,
  ].filter((id): id is string => Boolean(id))))
  const message = {
    type: 'blueprintWorkbench.finalized',
    sessionId: session.id,
    workflowInstanceId: session.workflowInstanceId,
    browserRunId: session.metadata?.browserRunId,
    workflowNodeId: session.workflowNodeId,
    finalPack: session.finalPack,
    finalPackConsumableId: session.finalPack?.finalPackConsumableId,
    stageConsumables,
    consumableIds,
    artifacts: workbenchDocuments,
    workbenchArtifacts: workbenchDocuments,
    workbenchDocuments,
    workbenchArtifactsByKind: groupWorkbenchDocumentsByKind(workbenchDocuments),
    workbenchDocumentsByKind: groupWorkbenchDocumentsByKind(workbenchDocuments),
    stageArtifactsByKind: groupStageConsumablesByKind(stageConsumables),
    status: session.status,
  }
  if (window.parent && window.parent !== window) {
    window.parent.postMessage(message, window.location.origin === WORKBENCH_ORIGIN ? WORKGRAPH_WEB_ORIGIN : '*')
  }
  if (window.opener && window.opener !== window) {
    window.opener.postMessage(message, WORKGRAPH_WEB_ORIGIN)
  }
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

function collectWorkbenchDocuments(session: BlueprintSession): Array<Record<string, any>> {
  return session.artifacts.map(artifact => {
    const payload = artifact.payload && typeof artifact.payload === 'object' && !Array.isArray(artifact.payload)
      ? artifact.payload
      : {}
    return {
      id: artifact.id,
      artifactId: artifact.id,
      kind: artifact.kind,
      title: artifact.title,
      stage: artifact.stage,
      stageKey: artifact.stageKey ?? stringValue(payload.stageKey),
      attemptId: artifact.attemptId ?? stringValue(payload.attemptId),
      version: artifact.version ?? numberValue(payload.version),
      content: artifact.content ?? '',
      createdAt: artifact.createdAt,
      consumableId: artifact.consumableId ?? stringValue(payload.consumableId),
      consumableVersion: artifact.consumableVersion ?? numberValue(payload.consumableVersion),
      consumableStatus: artifact.consumableStatus ?? stringValue(payload.consumableStatus),
      source: 'blueprint-workbench',
    }
  })
}

function groupWorkbenchDocumentsByKind(documents: Array<Record<string, any>>) {
  return documents.reduce<Record<string, Array<Record<string, any>>>>((acc, document) => {
    const key = typeof document.kind === 'string' && document.kind ? document.kind : 'artifact'
    acc[key] = [...(acc[key] ?? []), document]
    return acc
  }, {})
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function groupStageConsumablesByKind(refs: Array<Record<string, any>>) {
  return refs.reduce<Record<string, Array<Record<string, any>>>>((acc, ref) => {
    const key = typeof ref.artifactKind === 'string' && ref.artifactKind ? ref.artifactKind : 'artifact'
    acc[key] = [...(acc[key] ?? []), ref]
    return acc
  }, {})
}
