import { useEffect, useMemo, useRef, useState, lazy, Suspense } from 'react'
import type { ReactNode } from 'react'

// M83 S2.2 — Monaco editor lazy-loaded so the workbench landing
// page doesn't pull ~3MB of editor + workers. Triggers on first
// open of the Code overlay (in practice when the operator clicks
// "Edit" on a file). The default export is the React component.
const MonacoEditor = lazy(() => import('@monaco-editor/react'))

// M83 S2.3 — Monaco DiffEditor lazy-loaded behind the same chunk
// so reviewing changes before commit doesn't double-fetch. The
// named export is `DiffEditor`.
const MonacoDiffEditor = lazy(() =>
  import('@monaco-editor/react').then(m => ({ default: m.DiffEditor })),
)

// Map a file path's extension to a Monaco language ID. Keep this
// short — Monaco accepts unknown languages as plain text, so the
// fallback is fine.
function monacoLanguageForPath(p: string): string {
  const lower = p.toLowerCase()
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : ''
  switch (ext) {
    case 'ts': case 'tsx': return 'typescript'
    case 'js': case 'jsx': case 'mjs': case 'cjs': return 'javascript'
    case 'java': return 'java'
    case 'py': return 'python'
    case 'go': return 'go'
    case 'rs': return 'rust'
    case 'rb': return 'ruby'
    case 'kt': case 'kts': return 'kotlin'
    case 'scala': return 'scala'
    case 'swift': return 'swift'
    case 'c': case 'h': return 'c'
    case 'cpp': case 'cc': case 'cxx': case 'hpp': case 'hh': return 'cpp'
    case 'cs': return 'csharp'
    case 'json': return 'json'
    case 'yaml': case 'yml': return 'yaml'
    case 'xml': case 'pom': return 'xml'
    case 'html': case 'htm': return 'html'
    case 'css': return 'css'
    case 'scss': case 'sass': return 'scss'
    case 'md': case 'markdown': return 'markdown'
    case 'sh': case 'bash': return 'shell'
    case 'sql': return 'sql'
    case 'dockerfile': return 'dockerfile'
    case 'toml': return 'toml'
    case 'ini': return 'ini'
    default:
      if (lower.endsWith('/dockerfile') || lower === 'dockerfile') return 'dockerfile'
      return 'plaintext'
  }
}
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
  type SendBackAnnotation,
  type SnapshotMode,
  type SourceType,
  type StageAttempt,
  type WorkbenchExecutionConfig,
  type WorkflowInstanceDetail,
  type WorkflowInstanceListItem,
} from './api'
import { AppSwitcher } from './components/AppSwitcher'
import { LoopRail } from './neo/LoopRail'
import { CopilotExportButton } from './neo/CopilotExportButton'
import { LiveCockpit } from './neo/LiveCockpit'
import { FocusPane, computeFocusIntent, type FocusAction } from './neo/FocusPane'
import { NeoNotifier } from './neo/NeoNotifier'
import { StageChat } from './neo/StageChat'
import { InheritedFailureCard, getVerificationFailureAnalysis } from './neo/InheritedFailureCard'
import { LoopTrace } from './neo/LoopTrace'
import { stageMode, stageModeMeta, stageAllowsMutation, stageUsesRepoContext } from './neo/stageMode'
import { LoopTheater } from './loop-theater/LoopTheater'
import { NeoThemePicker, lookClass, useNeoLook } from './neo/NeoThemePicker'
import { MarkdownView } from './neo/MarkdownView'

const knownRoleMeta: Record<string, { label: string; icon: typeof Brain }> = {
  ARCHITECT: { label: 'Architect', icon: Brain },
  DEVELOPER: { label: 'Developer', icon: Code2 },
  QA: { label: 'QA', icon: ClipboardCheck },
}

const defaultWorkbenchGoal = 'Create a governed planning, design, development, QA, and testing loop for this codebase.'

// M69 — 'theater' added: Loop Theater is the replay view that animates how
// the LLM and agent talked to each other during a run. See loop-theater/.
type WorkbenchSection = 'workflow' | 'artifacts' | 'terminal' | 'loop' | 'replay' | 'theater'

// M100 P3 — under the single-origin edge gateway, workgraph-web and the
// workbench share the current origin, so postMessage targets / origin checks
// default to window.location.origin (was hardcoded :5174 / :5176). The
// VITE_*_ORIGIN overrides remain for split-origin deployments.
const WORKGRAPH_WEB_ORIGIN = normalizeOrigin(import.meta.env.VITE_WORKGRAPH_WEB_ORIGIN)
  ?? window.location.origin
const WORKBENCH_ORIGIN = normalizeOrigin(import.meta.env.VITE_BLUEPRINT_WORKBENCH_ORIGIN)
  ?? window.location.origin

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

  // M98 P2 — Live status refresh. The session list is fetched once (no
  // refetchInterval), so when the backend agent advances a stage on its own
  // the workbench shows stale status until a manual refresh. While the active
  // session has a stage in flight, poll the cheap status endpoint; when the
  // session's `updatedAt` advances we know something changed and refresh — the
  // sidebar list (which re-derives the active session for list-backed sessions)
  // plus, for locally-created sessions the selection effect pins, the full
  // session payload. This avoids re-loading the whole session blob every poll.
  const activeSessionId = activeSession?.id
  const activeSessionLive = Boolean(
    activeSession &&
      (activeSession.status === 'RUNNING' ||
        (activeSession.stageAttempts ?? []).some(a => a.status === 'RUNNING' || a.status === 'PAUSED')),
  )
  const sessionStatusQuery = useQuery({
    queryKey: ['blueprintSessionStatus', activeSessionId],
    queryFn: () => api.sessionStatus(activeSessionId!),
    enabled: hasToken && Boolean(activeSessionId) && activeSessionLive,
    refetchInterval: activeSessionLive ? 4000 : false,
    staleTime: 3750,
  })
  const lastStatusUpdatedAt = useRef<string | null>(null)
  useEffect(() => {
    lastStatusUpdatedAt.current = null
  }, [activeSessionId])
  useEffect(() => {
    const updatedAt = sessionStatusQuery.data?.updatedAt
    const polledId = sessionStatusQuery.data?.id
    if (!updatedAt || !polledId || polledId !== activeSessionId) return
    if (lastStatusUpdatedAt.current === null) {
      lastStatusUpdatedAt.current = updatedAt
      return
    }
    if (updatedAt === lastStatusUpdatedAt.current) return
    lastStatusUpdatedAt.current = updatedAt
    void queryClient.invalidateQueries({ queryKey: ['blueprintSessions'] })
    if (localCreatedSessionIds.has(polledId)) {
      void api
        .getSession(polledId)
        .then(full => setActiveSession(prev => (prev && prev.id === full.id ? full : prev)))
        .catch(() => {})
    }
  }, [sessionStatusQuery.data?.updatedAt, sessionStatusQuery.data?.id, activeSessionId, localCreatedSessionIds, queryClient])

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
          // M69 — Loop Theater. Animates the LLM↔agent conversation
          // for the current session by replaying audit-gov events.
          ['theater', 'Theater'],
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

type NeoOverlayKind = 'none' | 'review' | 'artifacts' | 'terminal' | 'loop' | 'replay' | 'theater' | 'code'

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
  const queryClient = useQueryClient()
  // M100 — live provider readiness. Polled on a short interval (and on window
  // focus) so an out-of-band provider flip (e.g. bin/llm-use-copilot.sh) is
  // reflected without a hard reload. `default_provider` is folded into the
  // model-catalog query key below so the catalog auto-refetches when the
  // active provider changes.
  const providersQuery = useQuery({
    queryKey: ['llm-providers'],
    queryFn: () => api.listProviders(),
    staleTime: 15 * 1000,
    refetchInterval: 30 * 1000,
    refetchOnWindowFocus: true,
  })
  const activeProvider = providersQuery.data?.default_provider
  // M42.7 / M100 — fetch the LLM model alias catalog so each stage row can
  // render a (provider-aware) model picker. Keyed by the active provider so a
  // provider flip invalidates it; short staleTime keeps `ready` per-row fresh.
  const modelCatalogQuery = useQuery({
    queryKey: ['llm-models', activeProvider],
    queryFn: () => api.listModelAliases(),
    staleTime: 30 * 1000,
    refetchOnWindowFocus: true,
  })
  const modelCatalog: LlmModelCatalogEntry[] = modelCatalogQuery.data?.models ?? []
  const defaultModelAlias =
    session?.executionConfig?.modelAlias ||
    modelCatalogQuery.data?.default_model_alias ||
    undefined
  const refreshModels = () => {
    void queryClient.invalidateQueries({ queryKey: ['llm-providers'] })
    void queryClient.invalidateQueries({ queryKey: ['llm-models'] })
  }
  const stageModelAliases: Record<string, string> = session?.executionConfig?.stageModelAliases ?? {}
  const stagePhaseModelAliases: Record<string, Record<string, string>> =
    session?.executionConfig?.stagePhaseModelAliases ?? {}
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
    else if (activeSection === 'theater') setOverlay('theater')
    else if (overlay === 'artifacts' || overlay === 'terminal' || overlay === 'loop' || overlay === 'replay' || overlay === 'theater') setOverlay('none')
  }, [activeSection])

  const activeStage = stages.find(stage => stage.key === activeStageKey) ?? stages[0]
  // (2026-05-31) Steer & rerun — post operator guidance to the stage chat, then
  // reset + rerun the active stage so the agent picks it up on a fresh attempt
  // (the {{operatorChat}} prompt var is assembled at run-start). Cancels any
  // in-flight attempt first (best-effort) so a stuck/running stage restarts
  // cleanly. This is the "interact with the existing phase" path: the message
  // reaches the agent's work on this stage immediately, via a fresh attempt.
  const steerAndRerun = async (content: string) => {
    if (!session || !activeStage) return
    await api.postStageMessage(session.id, activeStage.key, { content })
    try { await api.cancelInflightAttempt(session.id, activeStage.key) } catch { /* no in-flight attempt to cancel */ }
    if (!session.snapshots[0]) await api.snapshot(session.id)
    const updated = await api.runStage(session.id, activeStage.key)
    onSession(updated)
  }
  const activeAttempt = session && activeStage ? attemptsFor(session, activeStage.key).at(-1) : undefined
  const canReview = Boolean(session && activeStage && activeAttempt && stageAllowsMutation(activeStage))

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

  // The active stage's workspace mode (derived purely from its policy via
  // stageMode) drives a `mode-*` modifier on the cockpit shell, so the layout
  // adapts per stage (e.g. the live agent-activity rail widens on CODE/VERIFY
  // stages) without hardcoding stage names.
  const cockpitMode = stageMode(activeStage)

  // M41.5 — lookClass(look) yields the .neo-cockpit-root wrapper class
  // with three orthogonal modifiers (color theme, surface mode,
  // font family) that scope every --neo-* CSS variable. The LoopRail,
  // FocusPane, LiveCockpit, StageChat AND overlays all inherit the
  // same look so the cockpit feels like a single coherent surface.
  return (
    <div className={lookClass(look)}>
      <NeoNotifier session={session} />
      <section className={`neo-shell neo-cockpit-shell mode-${cockpitMode}`}>
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
          stagePhaseModelAliases={stagePhaseModelAliases}
          defaultModelAlias={defaultModelAlias}
          activeProvider={activeProvider}
          onRefreshModels={refreshModels}
          onStageModelChange={(stageKey, alias) => {
            // M42.7 — patch stageModelAliases via /settings. We merge the
            // current map with the new pick (or delete the key when alias is
            // null) so other pinned stages keep their model.
            const next = { ...stageModelAliases }
            if (alias) next[stageKey] = alias
            else delete next[stageKey]
            updateStageModelMutation.mutate({ id: session.id, body: { stageModelAliases: next } })
          }}
          onStagePhaseModelChange={(stageKey, phase, alias) => {
            // M100 — patch stagePhaseModelAliases via /settings. Merge into the
            // stage's phase map (or delete the phase when alias is null);
            // prune empty inner maps so the persisted shape stays clean.
            const next: Record<string, Record<string, string>> = { ...stagePhaseModelAliases }
            const inner = { ...(next[stageKey] ?? {}) }
            if (alias) inner[phase] = alias
            else delete inner[phase]
            if (Object.keys(inner).length > 0) next[stageKey] = inner
            else delete next[stageKey]
            updateStageModelMutation.mutate({ id: session.id, body: { stagePhaseModelAliases: next } })
          }}
          footer={
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {/* M97.6 — export this loop as a portable GitHub Copilot playbook */}
              <CopilotExportButton nodeId={session.workflowNodeId ?? null} />
              <NeoThemePicker value={look} onChange={setLook} />
            </div>
          }
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
            onOpenCode={() => setOverlay('code')}
            // M83.t (2026-05-27) — open the LoopTrace overlay which
            // already renders every turn's "Assistant said:" reasoning
            // text from audit-gov. Without this chip the data was
            // accessible but invisible — operators had to navigate
            // away from the stage card to find it.
            onOpenLoop={() => { setOverlay('loop'); onSection('loop') }}
          />
          {/* Phase 2 — mode-adaptive inline workspace. For CODE/VERIFY stages
              the worktree (file tree + inline diff + test runner) is promoted
              INLINE so coding/verification feels like an IDE rather than a
              modal. Additive: the full-screen `code`/`review` overlays remain.
              Inlined here (not a separate StageWorkspace component) because
              WorktreeBrowser is defined in this module — avoids a circular
              import. Gating is policy-driven (stageMode/cockpitMode) AND requires
              an attempt: until the stage has actually run there is no
              materialized worktree (the workflow may not have reached it yet),
              so promoting the cockpit would only surface a "no worktree" error.
              Before that, the operator can still peek via the `code →` overlay. */}
          {activeStage && activeAttempt && (cockpitMode === 'CODE' || cockpitMode === 'VERIFY') && (
            <details className={`neo-stage-workspace ${stageModeMeta(cockpitMode).chipClass}`} open>
              <summary className="neo-stage-workspace-head">
                <strong>{stageModeMeta(cockpitMode).label} workspace</strong>
                <small>file tree · inline diff · test runner — click to collapse · full-screen via “code →”</small>
              </summary>
              <div className="neo-stage-workspace-body">
                <WorktreeBrowser sessionId={session.id} stage={activeStage} />
              </div>
            </details>
          )}
          <FinalizeStrip session={session} onSession={onSession} />
        </div>

        {/* LiveCockpit subscribes to audit-gov by trace prefix
            `blueprint-<sessionId>` (the same path the Loop Theater
            uses). Standalone Workbench sessions without a linked
            workflow run still get a session id, so the cockpit lights
            up for them too. workflowInstanceId is passed so the empty
            state can differentiate "loading" from "will never load". */}
        <LiveCockpit
          sessionId={session.id ?? null}
          workflowInstanceId={session.workflowInstanceId ?? null}
        />
      </section>

      {/* M41.2 — Stage Chat docked at the bottom, persistent across stage
          navigation. Drops operator hints that feed into the next attempt. */}
      <div className="neo-bottom-dock">
        <StageChat
          sessionId={session.id}
          stage={activeStage}
          seedThread={activeStage ? session.stageChats?.[activeStage.key] : undefined}
          onApplyNow={steerAndRerun}
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
      {overlay === 'code' && (
        // M83.z (2026-05-27) — title was hardcoded to `Code ·
        // wi/<workitem>` (literal angle brackets), which read like
        // a UI typo when the session wasn't bound to a workitem.
        // The real workItemCode now renders inside the panel
        // header (line ~2612) once worktreeTree resolves; the
        // overlay chrome just says "Code" so there's no misleading
        // placeholder when binding hasn't happened.
        <NeoOverlayShell title="Code" onClose={() => closeOverlay()}>
          <WorktreeBrowser sessionId={session.id} stage={activeStage} />
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
      {overlay === 'theater' && (
        // M69 — Loop Theater overlay. Subscribes to audit-gov for this
        // session's trace and animates the LLM↔agent conversation.
        // traceIdPrefix is `blueprint-<sessionId>` (matches what mcp-server
        // emits as the trace_id on all events tied to this session).
        <NeoOverlayShell title="Loop Theater · how the agent did this run" onClose={() => closeOverlay()}>
          <LoopTheater traceIdPrefix={`blueprint-${session.id}`} />
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
                        {(attempt.correlation as { traceId?: string } | undefined)?.traceId && stageAllowsMutation(stage) && (
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
  onOpenCode,
  onOpenLoop,
}: {
  session: BlueprintSession
  stage: LoopStage | undefined
  onSession: (session: BlueprintSession) => void
  canReview: boolean
  onOpenReview: () => void
  onOpenArtifacts: () => void
  onOpenTerminal: () => void
  // M83 S1 — chip → opens the wi/<code> file browser overlay. Only
  // rendered when the workitem has a materialized worktree, but the
  // gate happens server-side; the chip is unconditional in the UI.
  onOpenCode: () => void
  // M83.t — chip → opens the LoopTrace overlay. Shows every turn's
  // assistant text + tool calls + tool results from audit-gov.
  // Operators get the full reasoning trail, not just the final
  // response text in LATEST STAGE OUTPUT.
  onOpenLoop: () => void
}) {
  const [answers, setAnswers] = useState<Record<string, DecisionAnswer>>({})
  const [feedback, setFeedback] = useState('')
  const [acceptRisk, setAcceptRisk] = useState(false)
  const [sendBackOpen, setSendBackOpen] = useState(false)
  const [sendBackTarget, setSendBackTarget] = useState('')
  const [sendBackReason, setSendBackReason] = useState('')
  const [requiredChanges, setRequiredChanges] = useState('')
  // M60 Slice 2 — Free-text annotations the operator pastes/types in the
  // send-back panel. Parsed on submit into SendBackAnnotation[] (see
  // parseSendBackAnnotations). One line per annotation:
  //   path/to/File.ext:142          must-fix     Comment here
  //   path/to/Other.ext:55-60       suggestion   Multi-line span
  // Severity column is optional; comment runs to end of line.
  const [annotationsText, setAnnotationsText] = useState('')

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
    setAnnotationsText('')
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
  // M82 S2 — verdictMutation now accepts MARK_DONE alongside the
  // standard LoopVerdict union. The backend persists MARK_DONE as PASS
  // but skips the required-question gate when the stage opts in via
  // allowMarkDone. Other downstream consumers stay typed to LoopVerdict.
  const verdictMutation = useMutation({
    mutationFn: (verdict: LoopVerdict | 'MARK_DONE') => {
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
  const parsedAnnotations = parseSendBackAnnotations(annotationsText)
  const sendBackMutation = useMutation({
    mutationFn: () => {
      if (!stage) throw new Error('No stage selected')
      return api.sendBack(session.id, stage.key, {
        targetStageKey: sendBackTarget,
        reason: sendBackReason,
        requiredChanges: requiredChanges.trim() || undefined,
        annotations: parsedAnnotations.length > 0 ? parsedAnnotations : undefined,
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
  // M89.e — Cancel the in-flight attempt for this stage. Sibling to
  // resetAttemptsMutation but surgical: only marks the RUNNING/PAUSED
  // attempt as FAILED so the operator can re-run without losing prior
  // history. Use when the agent is stuck, the worker got orphaned by
  // a server restart, or the operator just wants to abort.
  const cancelInflightMutation = useMutation({
    mutationFn: () => {
      if (!stage) throw new Error('No stage selected')
      return api.cancelInflightAttempt(session.id, stage.key)
    },
    onSuccess: onSession,
  })
  // (2026-05-31) Reset & rerun — one-click recovery for a stuck stage. Cancels
  // the in-flight attempt (the common server-restart-orphaned "forever RUNNING"
  // case), ensures a workspace snapshot exists, then re-runs the stage. Saves
  // the operator the two-step Cancel-attempt → find-Run dance.
  const resetAndRerunMutation = useMutation({
    mutationFn: async () => {
      if (!stage) throw new Error('No stage selected')
      await api.cancelInflightAttempt(session.id, stage.key)
      if (!session.snapshots[0]) {
        await api.snapshot(session.id)
      }
      return api.runStage(session.id, stage.key)
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
  // M78 Slice 3 — one-click remediation WI creation. Each failed test
  // the operator clicks "Create remediation WI →" on triggers one
  // independent call, so partial selection works without losing the
  // others. onSuccess raises a toast via NeoNotifier-compatible window
  // event; failures show in the card's row-level error (the mutation
  // tracks its own error state distinct from approvalMutation).
  const remediationMutation = useMutation({
    mutationFn: (failure: { test: string; file: string; exception?: string; exceptionLine?: number; hint?: string }) => {
      if (!stage) throw new Error('No stage selected')
      return api.createInheritedFailureRemediation(session.id, stage.key, {
        failure,
        originAttemptId: latest?.id,
      })
    },
    onSuccess: (created) => {
      // Notify via the same channel NeoNotifier listens on. Keeps the
      // toast plumbing out of this component.
      window.dispatchEvent(new CustomEvent('neo:notify', {
        detail: {
          kind: 'success',
          message: `Created remediation WI ${created.workCode}: ${created.title}`,
          href: `/work-items/${created.id}`,
        },
      }))
    },
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

  const rawError = runMutation.error ?? verdictMutation.error ?? sendBackMutation.error ?? resetAttemptsMutation.error ?? cancelInflightMutation.error ?? resetAndRerunMutation.error ?? approvalMutation.error
  const mutationErrorMessage = rawError?.message ?? null
  // M78 Slice 2 — When the error carries a structured failure-analysis
  // payload (only emitted today for develop-stage approval blocks where
  // the API was able to classify each failure as inherited vs
  // regression), render an actionable card instead of the flat string.
  // The bare `mutationErrorMessage` falls back to the inlineError prop
  // for every other error path — network/401/legacy validation errors
  // get exactly the same treatment as before.
  const failureAnalysis = getVerificationFailureAnalysis(rawError)
  const mutationError = failureAnalysis ? null : mutationErrorMessage

  // Compose the FocusPane body based on intent.
  const body: ReactNode = (
    <>
      {failureAnalysis && (
        <InheritedFailureCard
          analysis={failureAnalysis}
          message={mutationErrorMessage ?? ''}
          onSendBack={() => setSendBackOpen(true)}
          // M78 Slice 3 — wire each per-failure click to the mutation.
          // The mutation is fire-and-forget: success raises a window
          // event for NeoNotifier, failure surfaces via mutation.error.
          // The card itself stays simple — no React Query coupling.
          onCreateRemediationWI={(failure) => {
            remediationMutation.mutate(failure)
          }}
        />
      )}
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
          {/* M60 Slice 2 — Line-anchored annotations. One per line:
                path/to/File.ext:142          must-fix     Comment text
                path/to/File.ext:142-148      suggestion   Multi-line span
              Severity column is optional. Parsed live; the counter below
              reflects how many entries will be sent. */}
          <label>
            <span>
              Line annotations <em className="focus-sendback-hint">(optional · one per line · <code>path:line[-end] [severity] comment</code>)</em>
            </span>
            <textarea
              rows={3}
              value={annotationsText}
              onChange={e => setAnnotationsText(e.target.value)}
              placeholder={'src/main/java/Foo.java:142  must-fix  Rewrite using a character-set ignore-case match.\nsrc/main/java/Bar.java:55-60  suggestion  Add negative test for null.'}
              spellCheck={false}
            />
            {annotationsText.trim() && (
              <small className="focus-sendback-hint">
                {parsedAnnotations.length} annotation{parsedAnnotations.length === 1 ? '' : 's'} parsed
                {parsedAnnotations.length !== annotationsText.trim().split(/\r?\n/).filter(l => l.trim()).length
                  ? ` · ${annotationsText.trim().split(/\r?\n/).filter(l => l.trim()).length - parsedAnnotations.length} unparseable line(s) ignored`
                  : ''}
              </small>
            )}
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

  // Badges — small chips under the title. Mode + policy chips are derived from
  // the workflow's stage policy (stageMode classifier), not stage names.
  const stageWsMode = stageMode(stage)
  const badges: ReactNode = (
    <>
      <span className={`focus-badge mode ${stageModeMeta(stageWsMode).chipClass}`}>{stageModeMeta(stageWsMode).label}</span>
      <span className="focus-badge role">{roleMeta(stage.agentRole).label}</span>
      {stage.approvalRequired && <span className="focus-badge approval">approval gate</span>}
      {stage.toolPolicy && <span className="focus-badge policy">{stage.toolPolicy.toLowerCase()}</span>}
      {stage.repoAccess === false && <span className="focus-badge policy">no-repo</span>}
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
      {/* M83.t (2026-05-27) — every turn the agent took, with the
          assistant text ("I read the file because…", "Let me fix
          this:") plus emitted tool calls + tool results. Lifted
          from audit-gov via the existing /loop-trace endpoint
          (LoopTrace component, which already worked but was
          buried under the Loop tab). */}
      <button type="button" className="focus-badge link" onClick={onOpenLoop}>thinking →</button>
      {/* M83 S1 — file browser of the wi/<code> worktree. Backend
          refuses the open if the workitem isn't materialized yet,
          which surfaces as a friendly error in the overlay. */}
      {stageUsesRepoContext(stage) && (
        <button type="button" className="focus-badge link" onClick={onOpenCode}>code →</button>
      )}
    </>
  )

  // Decide the primary CTA based on intent.
  // (2026-05-31) Computed before the intent switch so the Run actions can be
  // gated on it: never offer an enabled Run/Re-run while an attempt is already
  // in-flight (e.g. the workflow runtime auto-started the stage via WORKBENCH_TASK).
  // Backstops the server-side idempotent guard so the operator never clicks into
  // an "already has an in-flight attempt" conflict.
  const hasInflightAttempt =
    !!stage &&
    (session.stageAttempts ?? []).some(
      a => a.stageKey === stage.key && (a.status === 'RUNNING' || a.status === 'PAUSED'),
    )
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
      disabled: hasInflightAttempt,
    }
    helperText = session.snapshots[0]
      ? 'Sends task + context to the agent loop.'
      : 'A workspace snapshot will be created first.'
  } else if (intent === 'running') {
    primaryAction = undefined
    helperText = 'The cockpit on the right shows tool calls and tokens as they happen. If the stage looks stuck (e.g., no activity after a server restart), use "Reset & rerun" to cancel the orphaned attempt and start it over.'
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
      // M82 S2 — "Mark done & advance" shortcut. Only surfaced when
      // the workflow's WORKBENCH_TASK node declared allowMarkDone=true
      // on this stage. Backend persists it as PASS but skips the
      // required-question gate, so it's only useful when the operator
      // has eyes-on review and the questions are documentation rather
      // than gates. Structural gates (accumulated code change for dev,
      // verification receipts) still fire.
      ...(stage?.allowMarkDone === true ? [{
        label: 'Mark done & advance',
        onClick: () => verdictMutation.mutate('MARK_DONE'),
        busy: verdictMutation.isPending,
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
      disabled: hasInflightAttempt || stageAttemptCount >= maxLoopsForStage,
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
      disabled: hasInflightAttempt,
    }
    helperText = 'Stage is closed. Re-running creates a new attempt with the same inputs.'
  }

  // M89.e — universal kill switch. Visible the moment ANY attempt for
  // this stage is RUNNING or PAUSED, regardless of intent. Covers the
  // common "the cockpit is live but the agent is stuck and I want to
  // start over" case, plus the wedged-after-server-restart case where
  // an attempt is forever RUNNING with no live worker. Pushed onto
  // secondaryActions so it lives next to "Reset attempts" / approval
  // buttons depending on the intent.
  if (hasInflightAttempt) {
    secondaryActions = [
      ...secondaryActions,
      {
        label: 'Reset & rerun',
        onClick: () => resetAndRerunMutation.mutate(),
        busy: resetAndRerunMutation.isPending,
      },
      {
        label: 'Cancel attempt',
        onClick: () => cancelInflightMutation.mutate(),
        busy: cancelInflightMutation.isPending,
      },
    ]
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
    // M98 P1 — treat a fresh fetch as current until just before the next
    // 3s poll; with React Query structural sharing the `items` reference
    // stays stable on a no-change poll, so the buildReviewFiles memo below
    // doesn't rebuild the diff views.
    staleTime: 2750,
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
  // M82 S1 — operator artifact edits. `editingId` tracks which artifact's
  // body is currently in edit mode; `draft` is the in-flight buffer. We
  // keep them outside the active-artifact dependency so flipping tabs
  // doesn't clobber a half-written edit. `reason` is an optional 1-line
  // justification persisted to the audit event for diffing.
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState<string>('')
  const [editReason, setEditReason] = useState<string>('')
  const [editError, setEditError] = useState<string | null>(null)
  const artifacts = useMemo(() => {
    const ordered = [...session.artifacts]
    ordered.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    return ordered
  }, [session.artifacts])
  const visible = artifacts.filter(artifact => !activeStageKey || !artifact.stageKey || artifact.stageKey === activeStageKey || artifact.kind === 'final_implementation_pack')
  const active = visible.find(artifact => artifact.id === activeArtifactId) ?? visible[0]
  // (2026-05-31) Universal editability: every artifact is editable while the
  // blueprint is in flight, and locks once the work is finalized (session
  // APPROVED/COMPLETED). Per-stage approval locks (an accepted stage attempt)
  // are enforced server-side by editArtifactContent, which returns a clear
  // error if an accepted stage's artifact is edited.
  const isActiveEditable = useMemo(() => {
    if (!active) return false
    const status = (session as { status?: string }).status
    if (status === 'APPROVED' || status === 'COMPLETED') return false
    return true
  }, [active, session])
  const editArtifactMutation = useMutation({
    mutationFn: ({ id, content, reason }: { id: string; content: string; reason?: string }) =>
      api.editArtifact(session.id, id, { content, reason }),
    onSuccess: (nextSession) => {
      onSession(nextSession)
      setEditingId(null)
      setDraft('')
      setEditReason('')
      setEditError(null)
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : 'Failed to save edit.'
      setEditError(message)
    },
  })
  const startEdit = (artifactId: string, initialContent: string) => {
    setEditingId(artifactId)
    setDraft(initialContent)
    setEditReason('')
    setEditError(null)
  }
  const cancelEdit = () => {
    setEditingId(null)
    setDraft('')
    setEditReason('')
    setEditError(null)
  }
  const saveEdit = () => {
    if (!active) return
    editArtifactMutation.mutate({ id: active.id, content: draft, reason: editReason.trim() || undefined })
  }
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
            <div className="artifact-reader-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <h3 style={{ margin: 0 }}>{active?.title}</h3>
              {/* M82 S1 — Edit affordance. Only shown when the workflow's
                  loopDefinition declares this artifact kind editable.
                  Read-only artifacts (security findings, qa receipts)
                  don't get a button at all. */}
              {active && isActiveEditable && editingId !== active.id && (
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => startEdit(active.id, active.content ?? '')}
                  disabled={editArtifactMutation.isPending}
                >
                  Edit
                </button>
              )}
            </div>
            {active && editingId === active.id ? (
              <div className="artifact-editor" style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
                <textarea
                  value={draft}
                  onChange={e => setDraft(e.target.value)}
                  rows={24}
                  spellCheck={false}
                  style={{ width: '100%', fontFamily: 'var(--font-mono, monospace)', fontSize: 13, padding: 8 }}
                  disabled={editArtifactMutation.isPending}
                />
                <input
                  type="text"
                  value={editReason}
                  onChange={e => setEditReason(e.target.value)}
                  placeholder="Optional: short reason for the edit (audit trail)"
                  maxLength={500}
                  style={{ width: '100%', padding: 6 }}
                  disabled={editArtifactMutation.isPending}
                />
                {editError && (
                  <p className="form-error" role="alert" style={{ color: 'var(--danger, #c33)' }}>
                    {editError}
                  </p>
                )}
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    type="button"
                    className="primary-button"
                    onClick={saveEdit}
                    disabled={editArtifactMutation.isPending || draft.trim().length === 0}
                  >
                    {editArtifactMutation.isPending ? 'Saving…' : 'Save'}
                  </button>
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={cancelEdit}
                    disabled={editArtifactMutation.isPending}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <MarkdownView
                content={renderArtifact(active)}
                kind={active?.kind}
                title={active?.title}
              />
            )}
          </article>
        </div>
      )}
    </section>
  )
}

// ─── M83 S1 — Worktree file browser ──────────────────────────────────────
// Lazy directory tree + read-only file viewer for the workitem's wi/<code>
// branch. Hits /api/blueprint/sessions/:id/worktree/{tree,file}, which the
// backend proxies to mcp-server. Per the M83 spec, this is the foundation
// slice — subsequent slices add editing (S2), test runner (S3), and
// API caller (S4) without touching this component's surface.
//
// M83 task #172/#173 (2026-05-26): per-stage gating. The whole overlay
// is mounted on any stage (operators benefit from "see the code" even
// on read-only review stages), but the mutating affordances downstream
// are scoped to the active stage's toolPolicy:
//   • Edit button → MUTATION only (dev stages)
//   • Run tests + API caller → MUTATION || VERIFICATION (dev/qa/test-cert)
//   • Tree + read-only file viewer → always
function WorktreeBrowser({ sessionId, stage }: { sessionId: string; stage: LoopStage | undefined }) {
  const canEdit = stage?.toolPolicy === 'MUTATION'
  const canRunTools = stage?.toolPolicy === 'MUTATION' || stage?.toolPolicy === 'VERIFICATION'
  // M83.z2 — manual bind state. The operator can paste a workItemCode
  // (or full UUID) to recover when the workflow didn't auto-bind.
  // Local-only state; result triggers a tree reload via key bump.
  const [bindInput, setBindInput] = useState('')
  const [bindBusy, setBindBusy] = useState(false)
  const [bindResult, setBindResult] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  // Track which directories are expanded — keyed by their absolute path
  // inside the workitem root. We keep a tree of cached entries here too
  // so re-expanding doesn't re-fetch.
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['']))
  const [cache, setCache] = useState<Record<string, Array<{ name: string; type: 'dir' | 'file' | 'other' }>>>({})
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [rootMeta, setRootMeta] = useState<{ workItemCode: string; workItemRoot: string } | null>(null)
  const [rootError, setRootError] = useState<string | null>(null)
  const [loadingPath, setLoadingPath] = useState<string | null>(null)

  // Fetch root on mount. After that, dir loads happen lazily on
  // expansion.
  useEffect(() => {
    let cancelled = false
    setLoadingPath('')
    api.worktreeTree(sessionId, '').then(res => {
      if (cancelled) return
      setRootMeta({ workItemCode: res.workItemCode, workItemRoot: res.workItemRoot })
      setCache(prev => ({ ...prev, '': res.entries }))
      setRootError(null)
    }).catch((err: unknown) => {
      if (cancelled) return
      const msg = err instanceof Error ? err.message : String(err)
      setRootError(msg)
    }).finally(() => {
      if (!cancelled) setLoadingPath(null)
    })
    return () => { cancelled = true }
  }, [sessionId, reloadKey])

  const loadDir = async (path: string) => {
    if (cache[path]) return
    setLoadingPath(path)
    try {
      const res = await api.worktreeTree(sessionId, path)
      setCache(prev => ({ ...prev, [path]: res.entries }))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // Surface as a phantom entry so the tree renders SOMETHING and
      // doesn't silently hide the failure.
      setCache(prev => ({ ...prev, [path]: [{ name: `! ${msg.slice(0, 120)}`, type: 'other' }] }))
    } finally {
      setLoadingPath(null)
    }
  }

  // M83.z2 — perform the bind. Either workItemCode (e.g. "WRK-984AD")
  // or a full UUID is accepted; server enforces exactly one. On
  // success we clear local cache + bump reloadKey so the tree refetch
  // sees the new binding.
  const bindWorkItem = async () => {
    const trimmed = bindInput.trim()
    if (!trimmed) return
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)
    setBindBusy(true)
    setBindResult(null)
    try {
      const res = await api.bindWorkItem(sessionId, isUuid
        ? { workItemId: trimmed }
        : { workItemCode: trimmed })
      setBindResult(
        `Bound to ${res.workItem.workCode} — ${res.workItem.title}`
        + (res.replacedPrevious ? ` (replaced ${res.replacedPrevious})` : ''),
      )
      // Reset every cached piece so the next render fetches fresh.
      setExpanded(new Set(['']))
      setCache({})
      setSelectedPath(null)
      setRootMeta(null)
      setRootError(null)
      setReloadKey(k => k + 1)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setBindResult(`Bind failed: ${msg}`)
    } finally {
      setBindBusy(false)
    }
  }

  const toggle = (path: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
        void loadDir(path)
      }
      return next
    })
  }

  const joinPath = (parent: string, name: string) => (parent ? `${parent}/${name}` : name)

  // Recursive tree render. Depth caps at a reasonable bound; very deep
  // trees would just need more vertical room.
  const renderTree = (parent: string, depth: number): React.ReactNode => {
    const entries = cache[parent]
    if (!entries) {
      return loadingPath === parent
        ? <div style={{ paddingLeft: depth * 14, color: 'var(--muted, #888)' }}>Loading…</div>
        : null
    }
    return entries.map(entry => {
      const full = joinPath(parent, entry.name)
      if (entry.type === 'dir') {
        const isOpen = expanded.has(full)
        return (
          <div key={full}>
            <button
              type="button"
              onClick={() => toggle(full)}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                paddingLeft: depth * 14 + 4,
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                fontFamily: 'var(--font-mono, monospace)',
                fontSize: 13,
                lineHeight: '20px',
                color: 'inherit',
              }}
            >
              {isOpen ? '▾' : '▸'} {entry.name}/
            </button>
            {isOpen && renderTree(full, depth + 1)}
          </div>
        )
      }
      if (entry.type === 'file') {
        const isSelected = selectedPath === full
        return (
          <button
            key={full}
            type="button"
            onClick={() => setSelectedPath(full)}
            style={{
              display: 'block',
              width: '100%',
              textAlign: 'left',
              paddingLeft: depth * 14 + 18,
              background: isSelected ? 'var(--selection, #1e3a5c)' : 'none',
              color: isSelected ? '#fff' : 'inherit',
              border: 'none',
              cursor: 'pointer',
              fontFamily: 'var(--font-mono, monospace)',
              fontSize: 13,
              lineHeight: '20px',
            }}
          >
            {entry.name}
          </button>
        )
      }
      // 'other' — symlinks, sockets, the error phantom. Render greyed.
      return (
        <div
          key={full}
          style={{
            paddingLeft: depth * 14 + 18,
            color: 'var(--danger, #c33)',
            fontFamily: 'var(--font-mono, monospace)',
            fontSize: 13,
            lineHeight: '20px',
          }}
        >
          {entry.name}
        </div>
      )
    })
  }

  return (
    <div style={{ display: 'flex', gap: 12, height: '100%', minHeight: 480 }}>
      <aside
        style={{
          flex: '0 0 320px',
          overflowY: 'auto',
          borderRight: '1px solid var(--border, #2a2a2a)',
          paddingRight: 8,
        }}
      >
        {rootMeta && (
          <div style={{ fontSize: 12, color: 'var(--muted, #888)', padding: '4px 0 8px 4px' }}>
            <strong>{rootMeta.workItemCode}</strong>
            <div style={{ fontSize: 11, opacity: 0.7 }}>{rootMeta.workItemRoot}</div>
          </div>
        )}
        {rootError ? (
          <div style={{ padding: 4 }}>
            <p style={{ color: 'var(--danger, #c33)', fontSize: 13, margin: '0 0 12px 0' }}>{rootError}</p>
            {/* M83.z2 — operator recovery: paste a workItemCode
                (e.g. "WRK-984AD") or a UUID to bind this session.
                The bind handler picks the right endpoint shape based
                on whether the input looks like a UUID. */}
            <div style={{ fontSize: 12, color: 'var(--muted, #888)', marginBottom: 6 }}>
              Bind to a WorkItem:
            </div>
            <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
              <input
                type="text"
                value={bindInput}
                onChange={e => setBindInput(e.target.value)}
                placeholder="WRK-984AD or UUID"
                disabled={bindBusy}
                onKeyDown={e => { if (e.key === 'Enter' && !bindBusy) void bindWorkItem() }}
                style={{
                  flex: 1,
                  padding: 4,
                  fontSize: 12,
                  fontFamily: 'var(--font-mono, monospace)',
                  minWidth: 0,
                }}
              />
              <button
                type="button"
                className="primary-button"
                onClick={() => void bindWorkItem()}
                disabled={bindBusy || !bindInput.trim()}
                style={{ fontSize: 12, padding: '4px 10px' }}
              >
                {bindBusy ? '…' : 'Bind'}
              </button>
            </div>
            {bindResult && (
              <div style={{
                fontSize: 11,
                padding: '4px 6px',
                color: bindResult.startsWith('Bound') ? 'var(--success, #6c6)' : 'var(--danger, #c66)',
              }}>
                {bindResult}
              </div>
            )}
          </div>
        ) : renderTree('', 0)}
      </aside>
      <section style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
        <div style={{ flex: 1, overflow: 'auto' }}>
          {selectedPath ? (
            <WorktreeFileView sessionId={sessionId} path={selectedPath} canEdit={canEdit} />
          ) : (
            <p style={{ color: 'var(--muted, #888)', padding: 12 }}>
              Select a file from the tree to view its contents.
            </p>
          )}
        </div>
        {/* M83 S3 — Test runner. Only shown on stages whose
            toolPolicy permits real tool execution (MUTATION =
            develop, VERIFICATION = qa-review/test-cert). On
            read-only review stages this panel is hidden — the
            operator can browse the code but not spawn runner
            containers from a stage that's supposed to be a
            structural review.
            M83.z (2026-05-27) — also gate on rootMeta: the runner
            + API caller can't function without a workspace bound
            to the session (worktree resolver returns 400 with the
            "no resolved workItemCode" message), and rendering them
            in that state was misleading — they look operational
            but every click hits the same backend error. */}
        {canRunTools && rootMeta && <WorktreeTestRunner sessionId={sessionId} />}
        {/* M83 S4 v1 — API caller. Same gating: only shown when
            the stage permits tool execution AND the session is
            bound to a workspace. */}
        {canRunTools && rootMeta && <WorkitemApiCaller sessionId={sessionId} />}
        {/* M83.z — when there's no worktree yet, surface a clear
            explanation that names the path forward. This is the
            common state when the operator clicked Code on a
            session whose WORKBENCH_TASK node hasn't activated
            (workflow hasn't reached the develop/qa stage yet), or
            on a standalone session that was never wired into a
            workflow. */}
        {canRunTools && !rootMeta && (
          <div style={{
            borderTop: '1px solid var(--border, #2a2a2a)',
            padding: '12px 16px',
            fontSize: 12,
            color: 'var(--warn, #fa6)',
            fontStyle: 'italic',
          }}>
            Test runner + API caller are hidden because this session isn't
            bound to a worktree yet.
            {rootError ? ` Worktree lookup said: "${rootError}"` : ''}
            {' '}They appear once the workflow's WORKBENCH_TASK node activates
            and binds a WorkItem (typically when the workflow reaches the
            develop stage).
          </div>
        )}
        {/* When tools are gated off by stage policy (not by missing
            worktree), give the operator a hint so they understand
            WHY the panels are missing rather than silently
            rendering an empty area. */}
        {!canRunTools && stage && (
          <div style={{
            borderTop: '1px solid var(--border, #2a2a2a)',
            padding: '12px 16px',
            fontSize: 12,
            color: 'var(--muted, #888)',
            fontStyle: 'italic',
          }}>
            Test runner + API caller are hidden on this stage
            ({stage.label} · toolPolicy={stage.toolPolicy ?? 'unknown'}).
            They render on stages with toolPolicy=MUTATION or VERIFICATION.
          </div>
        )}
      </section>
    </div>
  )
}

// ─── M83 S3 — Test runner panel ──────────────────────────────────────────
// Posts to /api/blueprint/sessions/:id/worktree/run-test, which proxies
// SSE through mcp-server. The browser EventSource API only supports GET,
// so we use fetch + ReadableStream + a hand-rolled SSE parser. Three
// event types: started, stdout/stderr, finished.
// M83 S3.3 — `interrupted` covers the case where the SSE stream
// closes (network blip, container restart, nginx reload) before the
// runner emits its `finished` frame. We surface it distinctly so the
// operator knows the test almost-certainly didn't complete — no
// receipt gets attached and a one-click Re-run is offered.
type TestRunStatus = 'idle' | 'running' | 'done' | 'error' | 'interrupted'

function WorktreeTestRunner({ sessionId }: { sessionId: string }) {
  const [command, setCommand] = useState<string>('mvn')
  const [argsText, setArgsText] = useState<string>('-B test')
  const [status, setStatus] = useState<TestRunStatus>('idle')
  const [lines, setLines] = useState<Array<{ stream: 'stdout' | 'stderr' | 'meta'; text: string }>>([])
  const [summary, setSummary] = useState<{ exitCode: number | null; passed: boolean; durationMs: number; error?: string } | null>(null)
  // M83 S3.2 — persisted-receipt state. After the run ends, we POST a
  // human-origin VerificationReceipt to the attempt; this flag drives
  // the inline banner so the operator sees "captured" vs "capture
  // failed" rather than guessing whether the run got recorded.
  const [persistState, setPersistState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [persistMessage, setPersistMessage] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const tailRef = useRef<HTMLDivElement | null>(null)
  // Expand the runner to a full-screen overlay on demand so long test
  // output (stack traces, mvn reactor logs) is readable without scrolling
  // a 240px box. Esc / the ✕ button collapses back to the inline panel.
  const [expanded, setExpanded] = useState(false)
  useEffect(() => {
    if (!expanded) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setExpanded(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [expanded])

  // Auto-scroll the terminal pane while a run is active. Snaps off
  // when the operator scrolls up to read earlier output.
  useEffect(() => {
    if (status === 'running' && tailRef.current) {
      tailRef.current.scrollTop = tailRef.current.scrollHeight
    }
  }, [lines, status])

  const presets = useMemo(() => ([
    { label: 'mvn -B test', command: 'mvn', args: ['-B', 'test'] },
    { label: 'pytest -q', command: 'pytest', args: ['-q'] },
    { label: 'npm test --silent', command: 'npm', args: ['test', '--silent'] },
    { label: 'gradle test', command: 'gradle', args: ['test'] },
    { label: 'go test ./...', command: 'go', args: ['test', './...'] },
  ]), [])

  const runTest = async () => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setStatus('running')
    setLines([{ stream: 'meta', text: `$ ${command} ${argsText}` }])
    setSummary(null)
    setPersistState('idle')
    setPersistMessage(null)
    const args = argsText.split(/\s+/).filter(Boolean)
    const fullCommand = `${command} ${argsText}`.trim()
    const startedAt = Date.now()
    // M83 S3.2 — accumulate raw output so we can persist a meaningful
    // excerpt with the receipt. We keep only the tail (~16KB) here
    // since the backend slices to 4KB anyway and unbounded buffers
    // on long runs would just pin memory.
    let outputBuf = ''
    const appendOutput = (text: string) => {
      outputBuf += text + '\n'
      if (outputBuf.length > 16_384) outputBuf = outputBuf.slice(-16_384)
    }
    // M83 S3.3 — flip to true only when the SSE 'finished' frame
    // arrives. If the stream closes before that, we know the run was
    // interrupted (network drop, container bounce) and the runner
    // never told us the real exit code.
    let gotFinished = false
    const onFinished = async (payload: { exitCode: number | null; passed: boolean; durationMs: number; error?: string }) => {
      gotFinished = true
      // Fire-and-forget — the test result is what the operator cares
      // about; the receipt is bookkeeping. Surface the outcome inline
      // so they can re-trigger or contact us if persistence keeps
      // failing.
      setPersistState('saving')
      setPersistMessage(null)
      try {
        const res = await api.worktreeAttachVerification(sessionId, {
          command: fullCommand,
          passed: payload.passed,
          exitCode: payload.exitCode,
          durationMs: payload.durationMs,
          toolName: 'run_test_human',
          output: outputBuf,
          notes: payload.error,
        })
        setPersistState('saved')
        setPersistMessage(`Receipt attached to attempt ${res.attemptId.slice(0, 8)}… (${res.totalReceipts} total).`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        setPersistState('error')
        setPersistMessage(`Receipt not attached: ${msg}`)
      }
    }
    try {
      const resp = await fetch(`${import.meta.env.BASE_URL.replace(/\/$/, '')}/api/blueprint/sessions/${encodeURIComponent(sessionId)}/worktree/run-test`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          // Use the canonical token getter (portal session → workgraph-auth),
          // same as the shared request() helper. The old getAuthToken() read
          // 'workbench.token'/'token' — keys nothing writes — so it sent an
          // empty Bearer and workgraph-api rejected with 401 UNAUTHORIZED.
          authorization: `Bearer ${getToken() ?? ''}`,
        },
        body: JSON.stringify({ command, args }),
        signal: controller.signal,
      })
      if (!resp.ok || !resp.body) {
        const text = await resp.text().catch(() => '')
        throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`)
      }
      const reader = resp.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        // SSE frames are separated by blank lines.
        let nl = buf.indexOf('\n\n')
        while (nl >= 0) {
          const frame = buf.slice(0, nl)
          buf = buf.slice(nl + 2)
          handleSseFrame(frame, setLines, setStatus, setSummary, startedAt, appendOutput, onFinished)
          nl = buf.indexOf('\n\n')
        }
      }
      // M83 S3.3 — clean stream close without a 'finished' frame =
      // interrupt. Mark the run distinctly and prompt for re-run. We
      // deliberately don't auto-retry: most test commands are
      // non-idempotent (compile state, db rows, port allocations) so
      // a silent retry could double-execute. The operator decides.
      if (!gotFinished) {
        const durationMs = Date.now() - startedAt
        setLines(prev => [...prev, {
          stream: 'meta',
          text: `— stream interrupted at ${Math.round(durationMs / 100) / 10}s before runner reported completion. Click Re-run. —`,
        }])
        setStatus('interrupted')
        setSummary({
          exitCode: null,
          passed: false,
          durationMs,
          error: 'Stream interrupted before runner reported completion',
        })
      }
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') {
        setLines(prev => [...prev, { stream: 'meta', text: '— aborted by operator —' }])
        setStatus('idle')
      } else {
        const msg = err instanceof Error ? err.message : String(err)
        setLines(prev => [...prev, { stream: 'stderr', text: msg }])
        setStatus('error')
        setSummary({ exitCode: null, passed: false, durationMs: Date.now() - startedAt, error: msg })
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null
    }
  }

  const abort = () => {
    abortRef.current?.abort()
  }

  return (
    <div style={expanded
      ? { position: 'fixed', inset: 16, zIndex: 1000, background: 'var(--surface, #0b0b0b)', border: '1px solid var(--border, #2a2a2a)', borderRadius: 10, padding: 12, display: 'flex', flexDirection: 'column', gap: 8, boxShadow: '0 24px 80px rgba(0,0,0,0.6)' }
      : { borderTop: '1px solid var(--border, #2a2a2a)', padding: 8, display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 360 }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 12 }}>Run tests</strong>
        <select
          value={`${command} ${argsText}`}
          onChange={e => {
            const preset = presets.find(p => `${p.command} ${p.args.join(' ')}` === e.target.value)
            if (preset) { setCommand(preset.command); setArgsText(preset.args.join(' ')) }
          }}
          disabled={status === 'running'}
          style={{ fontSize: 12, padding: 4 }}
        >
          {presets.map(p => (
            <option key={p.label} value={`${p.command} ${p.args.join(' ')}`}>{p.label}</option>
          ))}
        </select>
        <input
          type="text"
          value={command}
          onChange={e => setCommand(e.target.value)}
          disabled={status === 'running'}
          style={{ width: 80, fontSize: 12, fontFamily: 'var(--font-mono, monospace)', padding: 4 }}
          placeholder="cmd"
        />
        <input
          type="text"
          value={argsText}
          onChange={e => setArgsText(e.target.value)}
          disabled={status === 'running'}
          style={{ flex: 1, fontSize: 12, fontFamily: 'var(--font-mono, monospace)', padding: 4, minWidth: 200 }}
          placeholder="args (space-separated)"
        />
        {status === 'running' ? (
          <button type="button" className="ghost-button" onClick={abort}>Stop</button>
        ) : (
          <button
            type="button"
            className="primary-button"
            onClick={runTest}
            disabled={!command.trim()}
            // M83 S3.3 — relabel after an interrupted stream so the
            // operator's path forward is obvious.
            title={status === 'interrupted' ? 'Re-run after stream interruption' : undefined}
          >
            {status === 'interrupted' || status === 'error' ? 'Re-run' : 'Run'}
          </button>
        )}
        <button
          type="button"
          className="ghost-button"
          onClick={() => setExpanded(e => !e)}
          title={expanded ? 'Collapse (Esc)' : 'Expand output to full screen'}
          aria-label={expanded ? 'Collapse test output' : 'Expand test output'}
          style={{ marginLeft: 'auto', fontSize: 12 }}
        >
          {expanded ? '✕ Close' : '⤢ Expand'}
        </button>
      </div>
      {summary && (
        <div style={{
          fontSize: 12,
          color: status === 'interrupted' ? 'var(--warn, #fa6)'
            : summary.passed ? 'var(--success, #6c6)'
              : 'var(--danger, #c66)',
        }}>
          {status === 'interrupted' ? '⚠ interrupted'
            : summary.passed ? '✓ passed'
              : '✗ failed'}
          {summary.exitCode !== null && ` · exit ${summary.exitCode}`}
          {` · ${Math.round(summary.durationMs / 100) / 10}s`}
          {summary.error && ` · ${summary.error}`}
        </div>
      )}
      {/* M83 S3.2 — receipt-persist banner. The receipt rides the
          approval gate alongside the agent's, so failure to attach
          would silently break the human-verification path. Surfacing
          the outcome inline lets the operator notice + retry. */}
      {persistState !== 'idle' && (
        <div style={{
          fontSize: 11,
          color: persistState === 'saved' ? 'var(--success, #6c6)'
            : persistState === 'error' ? 'var(--danger, #c66)'
              : 'var(--muted, #888)',
          fontStyle: persistState === 'saving' ? 'italic' : undefined,
        }}>
          {persistState === 'saving' && '↑ attaching verification receipt…'}
          {persistState === 'saved' && `✓ ${persistMessage}`}
          {persistState === 'error' && persistMessage}
        </div>
      )}
      <div
        ref={tailRef}
        style={{
          flex: 1,
          minHeight: 120,
          maxHeight: expanded ? 'none' : 240,
          overflow: 'auto',
          background: 'var(--code-bg, #0a0a0a)',
          border: '1px solid var(--border, #2a2a2a)',
          padding: 6,
          fontFamily: 'var(--font-mono, monospace)',
          fontSize: 11,
          lineHeight: 1.4,
          whiteSpace: 'pre-wrap',
        }}
      >
        {lines.length === 0 ? (
          <span style={{ color: 'var(--muted, #888)' }}>Output appears here.</span>
        ) : (
          lines.map((line, i) => (
            <div
              key={i}
              style={{
                color:
                  line.stream === 'stderr' ? 'var(--danger, #c66)'
                    : line.stream === 'meta' ? 'var(--muted, #888)'
                      : undefined,
              }}
            >
              {line.text}
            </div>
          ))
        )}
      </div>
    </div>
  )
}

function handleSseFrame(
  frame: string,
  setLines: React.Dispatch<React.SetStateAction<Array<{ stream: 'stdout' | 'stderr' | 'meta'; text: string }>>>,
  setStatus: React.Dispatch<React.SetStateAction<TestRunStatus>>,
  setSummary: React.Dispatch<React.SetStateAction<{ exitCode: number | null; passed: boolean; durationMs: number; error?: string } | null>>,
  startedAt: number,
  // M83 S3.2 — optional sinks for the run-completion receipt path.
  // appendOutput captures the streaming bytes into a closure buffer
  // for later inclusion in the receipt; onFinished fires once the
  // SSE 'finished' frame arrives so the caller can POST the receipt.
  appendOutput?: (text: string) => void,
  onFinished?: (payload: { exitCode: number | null; passed: boolean; durationMs: number; error?: string }) => void,
) {
  // Minimal SSE parser. Expects:
  //   event: <name>\n
  //   data: <json>\n
  // (possibly preceded by other fields we don't use).
  let event = 'message'
  let data = ''
  for (const rawLine of frame.split('\n')) {
    const line = rawLine.trimEnd()
    if (!line) continue
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) data += (data ? '\n' : '') + line.slice(5).trim()
  }
  if (!data) return
  let payload: unknown
  try { payload = JSON.parse(data) } catch { payload = data }
  const obj = (payload && typeof payload === 'object') ? (payload as Record<string, unknown>) : {}
  if (event === 'stdout') {
    const text = String(obj.line ?? '')
    setLines(prev => [...prev, { stream: 'stdout', text }])
    appendOutput?.(text)
  } else if (event === 'stderr') {
    const text = String(obj.line ?? '')
    setLines(prev => [...prev, { stream: 'stderr', text }])
    appendOutput?.(text)
  } else if (event === 'started') {
    setLines(prev => [...prev, { stream: 'meta', text: `running… (${String(obj.commandPreview ?? '')})` }])
  } else if (event === 'finished') {
    const exitCode = obj.exitCode === null || obj.exitCode === undefined ? null : Number(obj.exitCode)
    const passed = obj.passed === true
    const durationMs = typeof obj.durationMs === 'number' ? obj.durationMs : Date.now() - startedAt
    const error = typeof obj.error === 'string' ? obj.error : undefined
    setSummary({ exitCode, passed, durationMs, error })
    setStatus(passed ? 'done' : 'error')
    onFinished?.({ exitCode, passed, durationMs, error })
  }
}

// Read the auth token from localStorage the same way the rest of the
// workbench API client does. Inlined here so the run-test fetch can
// pass it via Authorization header (the api.ts request() helper does
// this automatically but we need raw fetch for SSE).
// ─── M83 S4 v1 — Postman-style API caller ────────────────────────────────
// Hits any private/loopback URL through workgraph-api's proxy. The
// operator brings the app up themselves (host JVM, sibling container,
// docker-compose); this panel does method + URL + headers + body and
// renders the response. The backend refuses public hosts so the proxy
// can't be used as an exfiltration vector.
function WorkitemApiCaller({ sessionId }: { sessionId: string }) {
  const [method, setMethod] = useState<string>('GET')
  const [url, setUrl] = useState<string>('http://host.docker.internal:8080/')
  const [headersText, setHeadersText] = useState<string>('Content-Type: application/json')
  const [bodyText, setBodyText] = useState<string>('')
  const [sending, setSending] = useState(false)
  const [response, setResponse] = useState<{
    ok: boolean
    status: number
    statusText?: string
    headers?: Record<string, string>
    body?: string
    durationMs: number
    error?: string
    truncated?: boolean
  } | null>(null)

  const parseHeaders = (): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const line of headersText.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const idx = trimmed.indexOf(':')
      if (idx < 0) continue
      const key = trimmed.slice(0, idx).trim()
      const value = trimmed.slice(idx + 1).trim()
      if (key) out[key] = value
    }
    return out
  }

  const send = async () => {
    setSending(true)
    setResponse(null)
    try {
      const res = await api.workitemApiCall(sessionId, {
        method,
        url,
        headers: parseHeaders(),
        body: method !== 'GET' && method !== 'HEAD' ? bodyText : undefined,
      })
      setResponse(res)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setResponse({ ok: false, status: 0, error: msg, durationMs: 0 })
    } finally {
      setSending(false)
    }
  }

  return (
    <div style={{ borderTop: '1px solid var(--border, #2a2a2a)', padding: 8, display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 420 }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <strong style={{ fontSize: 12 }}>API call</strong>
        <select
          value={method}
          onChange={e => setMethod(e.target.value)}
          disabled={sending}
          style={{ fontSize: 12, padding: 4 }}
        >
          {['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map(m => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
        <input
          type="text"
          value={url}
          onChange={e => setUrl(e.target.value)}
          disabled={sending}
          placeholder="http://host.docker.internal:8080/operators/containsACharacter"
          style={{ flex: 1, fontSize: 12, fontFamily: 'var(--font-mono, monospace)', padding: 4, minWidth: 200 }}
        />
        <button
          type="button"
          className="primary-button"
          onClick={send}
          disabled={sending || !url.trim()}
        >
          {sending ? 'Sending…' : 'Send'}
        </button>
      </div>
      <details>
        <summary style={{ fontSize: 11, color: 'var(--muted, #888)', cursor: 'pointer' }}>
          Headers ({Object.keys(parseHeaders()).length}) + body
        </summary>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }}>
          <textarea
            value={headersText}
            onChange={e => setHeadersText(e.target.value)}
            disabled={sending}
            rows={3}
            spellCheck={false}
            placeholder="Header-Name: value (one per line)"
            style={{ width: '100%', fontSize: 11, fontFamily: 'var(--font-mono, monospace)', padding: 4 }}
          />
          {method !== 'GET' && method !== 'HEAD' && (
            <textarea
              value={bodyText}
              onChange={e => setBodyText(e.target.value)}
              disabled={sending}
              rows={4}
              spellCheck={false}
              placeholder='{ "key": "value" }'
              style={{ width: '100%', fontSize: 11, fontFamily: 'var(--font-mono, monospace)', padding: 4 }}
            />
          )}
        </div>
      </details>
      {response && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{
            fontSize: 12,
            color: response.error ? 'var(--danger, #c66)'
              : response.ok ? 'var(--success, #6c6)'
                : 'var(--warn, #fa6)',
          }}>
            {response.error
              ? `✗ ${response.error}`
              : `${response.ok ? '✓' : '✗'} ${response.status}${response.statusText ? ' ' + response.statusText : ''} · ${Math.round(response.durationMs)}ms${response.truncated ? ' · truncated' : ''}`
            }
          </div>
          {response.headers && Object.keys(response.headers).length > 0 && (
            <details>
              <summary style={{ fontSize: 11, color: 'var(--muted, #888)', cursor: 'pointer' }}>
                Response headers ({Object.keys(response.headers).length})
              </summary>
              <pre style={{
                fontSize: 10,
                fontFamily: 'var(--font-mono, monospace)',
                padding: 4,
                margin: 0,
                background: 'var(--code-bg, #0a0a0a)',
                border: '1px solid var(--border, #2a2a2a)',
                maxHeight: 80,
                overflow: 'auto',
              }}>
                {Object.entries(response.headers).map(([k, v]) => `${k}: ${v}`).join('\n')}
              </pre>
            </details>
          )}
          {response.body !== undefined && (
            <pre style={{
              fontSize: 11,
              fontFamily: 'var(--font-mono, monospace)',
              padding: 6,
              margin: 0,
              background: 'var(--code-bg, #0a0a0a)',
              border: '1px solid var(--border, #2a2a2a)',
              maxHeight: 200,
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
            }}>
              {response.body || '(empty body)'}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}

function WorktreeFileView({ sessionId, path, canEdit }: { sessionId: string; path: string; canEdit: boolean }) {
  const [content, setContent] = useState<string | null>(null)
  const [meta, setMeta] = useState<{ sizeBytes: number; modifiedAt: string; encoding: 'utf-8' | 'base64'; blobSha: string | null } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  // M83 S2 — edit mode + buffer. We keep editing/draft outside the
  // load-effect so flipping fields doesn't clobber an in-flight edit.
  // The commit-message input is optional; when blank, the backend
  // generates a sensible default ("Human edit by <email>: <path>").
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [commitMessage, setCommitMessage] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveResult, setSaveResult] = useState<string | null>(null)
  // M83 S2.3 — toggle the in-editor view between the live Monaco
  // editor and a side-by-side diff against the on-disk content.
  // Off by default; flipping it doesn't lose the draft buffer.
  const [showDiff, setShowDiff] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setContent(null)
    setEditing(false)
    setDraft('')
    setCommitMessage('')
    setSaveResult(null)
    api.worktreeFile(sessionId, path).then(res => {
      if (cancelled) return
      setContent(res.content)
      setMeta({ sizeBytes: res.sizeBytes, modifiedAt: res.modifiedAt, encoding: res.encoding, blobSha: res.blobSha })
    }).catch((err: unknown) => {
      if (cancelled) return
      setError(err instanceof Error ? err.message : String(err))
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [sessionId, path])

  const startEdit = () => {
    setDraft(content ?? '')
    setEditing(true)
    setSaveResult(null)
  }
  const cancelEdit = () => {
    setEditing(false)
    setDraft('')
    setCommitMessage('')
    setSaveResult(null)
    setShowDiff(false)
  }
  const saveEdit = async () => {
    if (!meta) return
    setSaving(true)
    setSaveResult(null)
    try {
      const res = await api.worktreeWriteFile(sessionId, path, {
        content: draft,
        message: commitMessage.trim() || undefined,
        // expectedSha = the blob sha we got at fetch time. If an agent
        // attempt landed a parallel commit on this file while we were
        // editing, the backend returns 409 STALE_EDIT and the operator
        // re-fetches.
        expectedSha: meta.blobSha ?? undefined,
      })
      if (!res.edited) {
        setSaveResult('No-op: content matched HEAD.')
        setEditing(false)
        return
      }
      setSaveResult(
        `Committed ${res.commitSha?.slice(0, 7) ?? '???'} on ${res.branch ?? 'wi/<code>'} ` +
        `(+${res.linesAdded ?? '?'}/-${res.linesRemoved ?? '?'} by ${res.author?.email ?? 'operator'})`,
      )
      setContent(draft)
      setMeta(prev => prev ? { ...prev, blobSha: res.blobSha ?? prev.blobSha, modifiedAt: new Date().toISOString() } : prev)
      setEditing(false)
      setCommitMessage('')
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setSaveResult(msg)
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <p style={{ padding: 12, color: 'var(--muted, #888)' }}>Loading {path}…</p>
  if (error) return <p style={{ padding: 12, color: 'var(--danger, #c33)' }}>{error}</p>

  const isBinary = meta?.encoding === 'base64'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 8 }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: 12, gap: 8 }}>
        <strong style={{ wordBreak: 'break-all' }}>{path}</strong>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          {meta && (
            <span style={{ color: 'var(--muted, #888)' }}>
              {meta.sizeBytes.toLocaleString()} bytes · {meta.encoding}
              {meta.blobSha && ` · ${meta.blobSha.slice(0, 7)}`}
            </span>
          )}
          {/* M83 S2 — Edit button. Hidden for binary files (no useful
              text edit). Save commits to wi/<code> attributed to the
              operator's IAM identity (workgraph-api injects the
              author from req.user).
              M83 task #172 — gated on canEdit so non-develop stages
              (intake/design/qa) get read-only browsing. */}
          {!isBinary && !editing && canEdit && (
            <button type="button" className="ghost-button" onClick={startEdit}>
              Edit
            </button>
          )}
          {!isBinary && !editing && !canEdit && (
            <span style={{ fontSize: 11, color: 'var(--muted, #888)', fontStyle: 'italic' }}>
              read-only on this stage
            </span>
          )}
        </div>
      </header>
      {saveResult && (
        <div style={{
          fontSize: 12,
          padding: '6px 8px',
          background: saveResult.startsWith('Committed') ? 'var(--success-bg, #16331e)' : 'var(--warn-bg, #3a2a1a)',
          color: saveResult.startsWith('Committed') ? 'var(--success, #8a8)' : 'var(--warn, #fa6)',
          borderRadius: 4,
        }}>
          {saveResult}
        </div>
      )}
      {isBinary ? (
        <p style={{ color: 'var(--muted, #888)', fontStyle: 'italic' }}>
          (Binary file. Content is base64-encoded; open on disk for the real bytes.)
        </p>
      ) : editing ? (
        <>
          {/* M83 S2.2 — Monaco editor. Lazy-loaded; Suspense
              fallback keeps the layout from collapsing during the
              first-open ~200ms chunk fetch. Read-only is disabled
              by toggling the wrapping editing branch (we only
              render Monaco when the operator clicked Edit). */}
          <Suspense fallback={
            <div style={{
              minHeight: 320,
              padding: 12,
              background: 'var(--code-bg, #0a0a0a)',
              border: '1px solid var(--border, #2a2a2a)',
              color: 'var(--muted, #888)',
              fontSize: 12,
              fontFamily: 'var(--font-mono, monospace)',
            }}>
              Loading editor…
            </div>
          }>
            <div style={{
              border: '1px solid var(--border, #2a2a2a)',
              borderRadius: 4,
              overflow: 'hidden',
              height: 'calc(100vh - 360px)',
              minHeight: 320,
            }}>
              {showDiff ? (
                /* M83 S2.3 — diff against on-disk content. Editing
                   is disabled in diff view; flip back to Editor to
                   keep typing. The "original" side is `content`
                   (the last fetched body) and the "modified" side
                   is the live draft. */
                <MonacoDiffEditor
                  original={content ?? ''}
                  modified={draft}
                  language={monacoLanguageForPath(path)}
                  theme="vs-dark"
                  options={{
                    readOnly: true,
                    renderSideBySide: true,
                    minimap: { enabled: false },
                    fontSize: 12,
                    automaticLayout: true,
                  }}
                />
              ) : (
                <MonacoEditor
                  value={draft}
                  language={monacoLanguageForPath(path)}
                  theme="vs-dark"
                  onChange={(v) => setDraft(v ?? '')}
                  options={{
                    readOnly: saving,
                    minimap: { enabled: false },
                    fontSize: 12,
                    lineNumbers: 'on',
                    scrollBeyondLastLine: false,
                    tabSize: 2,
                    wordWrap: 'off',
                    renderWhitespace: 'selection',
                    automaticLayout: true,
                  }}
                />
              )}
            </div>
          </Suspense>
          <input
            type="text"
            value={commitMessage}
            onChange={e => setCommitMessage(e.target.value)}
            placeholder={`Optional commit message (default: "Human edit by <you>: ${path}")`}
            maxLength={500}
            disabled={saving}
            style={{ width: '100%', padding: 6, fontSize: 12 }}
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              className="primary-button"
              onClick={saveEdit}
              disabled={saving || draft === content}
            >
              {saving ? 'Saving…' : 'Save & commit'}
            </button>
            {/* M83 S2.3 — flip between Editor and DiffEditor so the
                operator can review the change before clicking
                Save. Disabled when there's nothing to diff. */}
            <button
              type="button"
              className="ghost-button"
              onClick={() => setShowDiff(s => !s)}
              disabled={saving || draft === content}
              title="Side-by-side diff vs. on-disk content"
            >
              {showDiff ? 'Edit mode' : 'Show diff'}
            </button>
            <button
              type="button"
              className="ghost-button"
              onClick={cancelEdit}
              disabled={saving}
            >
              Cancel
            </button>
            {draft !== content && (
              <span style={{ fontSize: 12, color: 'var(--muted, #888)', alignSelf: 'center' }}>
                {draft.length - (content?.length ?? 0) >= 0 ? '+' : ''}
                {draft.length - (content?.length ?? 0)} chars
              </span>
            )}
          </div>
        </>
      ) : (
        <pre
          style={{
            margin: 0,
            padding: 8,
            background: 'var(--code-bg, #0a0a0a)',
            border: '1px solid var(--border, #2a2a2a)',
            fontFamily: 'var(--font-mono, monospace)',
            fontSize: 12,
            lineHeight: 1.5,
            overflow: 'auto',
            maxHeight: 'calc(100vh - 240px)',
          }}
        >
          {content}
        </pre>
      )}
    </div>
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
  // M70.7 — When the parent workflow is RESTARTED (NODE_RESTARTED on
  // Start), the Workbench node goes ACTIVE again even though the
  // blueprint session is already APPROVED + finalPack is set. The old
  // disable rule trapped the operator: "Finalize + send" was greyed out
  // because finalPack existed, so they had no way to re-emit the
  // handoff event and advance the workflow past Workbench. Now we keep
  // the button enabled in this case with a "Re-send to workflow" label;
  // the backend's idempotent finalize path re-attaches the existing
  // pack and re-calls advance, which is the only thing the workflow
  // needs to move on.
  const hasPack = Boolean(session.finalPack)
  const canReSend = hasPack && workflowLinked
  const title = hasPack
    ? canReSend ? 'Final pack ready — re-send to workflow if it was reset' : 'Final pack sent'
    : green ? 'Ready for final handoff' : 'Final handoff locked'
  const summary = canReSend
    ? 'Your blueprint is already finalized. If the workflow node is still waiting on this Workbench (e.g. after a workflow restart), click below to re-attach the existing pack and advance the node.'
    : session.finalPack?.summary
      ?? (green
        ? workflowLinked
          ? 'All required gates are green. Finalize sends artifacts, consumables, and the final pack back to the workflow, then advances the Workbench node.'
          : 'All required gates are green. Finalize creates the final implementation pack for this standalone session.'
        : 'Pass or accept risk on every required stage before sending the final pack back to the workflow.')

  const buttonLabel = canReSend
    ? 'Re-send to workflow'
    : workflowLinked ? 'Finalize + send' : 'Finalize'

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
          disabled={(!green && !canReSend) || finalizeMutation.isPending}
          onClick={() => finalizeMutation.mutate()}
        >
          {finalizeMutation.isPending ? <Loader2 className="spin" size={15} /> : <BadgeCheck size={15} />}
          {buttonLabel}
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

/**
 * M60 Slice 2 — Parse the operator's free-text annotations into the
 * structured shape the API expects.
 *
 * Each non-empty line is parsed as:
 *   <path>:<startLine>[-<endLine>]  [severity]  <comment...>
 *
 * Whitespace between columns is flexible (one or more spaces/tabs).
 * Severity is the literal token must-fix | suggestion | question; any
 * other word is treated as the start of the comment.
 *
 * Lines that don't match (no colon-line-number) are silently dropped.
 * The caller surfaces a count of unparseable lines to the operator.
 */
function parseSendBackAnnotations(text: string): SendBackAnnotation[] {
  const out: SendBackAnnotation[] = []
  if (!text) return out
  const sevSet = new Set(['must-fix', 'suggestion', 'question'])
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    // Capture path + line span: "path:NN" or "path:NN-MM".
    const m = line.match(/^(.+?):(\d+)(?:-(\d+))?\s+(.+)$/)
    if (!m) continue
    const file = m[1].trim()
    const startLine = Number.parseInt(m[2], 10)
    const endLine = m[3] ? Number.parseInt(m[3], 10) : undefined
    const rest = m[4].trim()
    if (!file || !Number.isFinite(startLine) || startLine <= 0) continue
    // Pick off an optional severity token from the start of the rest.
    let severity: SendBackAnnotation['severity'] | undefined
    let comment = rest
    const firstSpace = rest.search(/\s/)
    if (firstSpace > 0) {
      const head = rest.slice(0, firstSpace)
      if (sevSet.has(head)) {
        severity = head as SendBackAnnotation['severity']
        comment = rest.slice(firstSpace).trim()
      }
    }
    if (!comment) continue
    out.push({
      file,
      startLine,
      ...(endLine && endLine > startLine ? { endLine } : {}),
      comment: comment.slice(0, 800),
      ...(severity ? { severity } : {}),
    })
    if (out.length >= 50) break // server-side cap
  }
  return out
}

function attemptsFor(session: BlueprintSession, stageKey: string) {
  return (session.stageAttempts ?? []).filter(attempt => attempt.stageKey === stageKey)
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
