import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  ArrowDownLeft,
  BadgeCheck,
  BookOpen,
  Boxes,
  Brain,
  CheckCircle2,
  ClipboardCheck,
  Code2,
  GitBranch,
  HardDrive,
  Loader2,
  LogOut,
  Play,
  RefreshCw,
  Route,
  ScanSearch,
  ShieldCheck,
  Sparkles,
  Undo2,
} from 'lucide-react'
import {
  api,
  clearToken,
  getToken,
  pseudoLogin,
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
  type Stage,
  type StageAttempt,
} from './api'

const roleMeta: Record<Stage, { label: string; icon: typeof Brain }> = {
  ARCHITECT: { label: 'Architect', icon: Brain },
  DEVELOPER: { label: 'Developer', icon: Code2 },
  QA: { label: 'QA', icon: ClipboardCheck },
}

const verdictLabels: Record<LoopVerdict, string> = {
  PASS: 'Pass',
  NEEDS_REWORK: 'Needs rework',
  BLOCKED: 'Blocked',
  ACCEPTED_WITH_RISK: 'Accepted with risk',
}

export default function App() {
  const queryClient = useQueryClient()
  const [activeSession, setActiveSession] = useState<BlueprintSession | null>(null)
  const [authTick, setAuthTick] = useState(0)
  const hasToken = Boolean(getToken())

  const sessionsQuery = useQuery({
    queryKey: ['blueprintSessions'],
    queryFn: api.listSessions,
    enabled: hasToken,
  })
  const sessions = sessionsQuery.data?.items ?? []

  useEffect(() => {
    if (sessions.length === 0) return
    setActiveSession(current => {
      if (!current) return sessions[0]
      return sessions.find(session => session.id === current.id) ?? sessions[0]
    })
  }, [sessions])

  const refreshSession = (session: BlueprintSession) => {
    setActiveSession(session)
    void queryClient.invalidateQueries({ queryKey: ['blueprintSessions'] })
  }

  if (!hasToken) {
    return <AuthGate onAuthed={() => setAuthTick(v => v + 1)} />
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Singularity</p>
          <h1>Blueprint Workbench</h1>
        </div>
        <div className="topbar-actions">
          <button className="icon-button" onClick={() => sessionsQuery.refetch()} title="Refresh sessions">
            <RefreshCw size={16} />
          </button>
          <button
            className="icon-button"
            onClick={() => {
              clearToken()
              setAuthTick(authTick + 1)
              setActiveSession(null)
              queryClient.clear()
            }}
            title="Sign out"
          >
            <LogOut size={16} />
          </button>
        </div>
      </header>

      <section className="loop-shell">
        <WorkbenchSetup sessions={sessions} activeSession={activeSession} onSelect={setActiveSession} onCreated={refreshSession} />
        <LoopWorkbench session={activeSession} onSession={refreshSession} />
      </section>
    </main>
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
  const [sourceType, setSourceType] = useState<SourceType>('localdir')
  const [sourceUri, setSourceUri] = useState('')
  const [sourceRef, setSourceRef] = useState('')
  const [goal, setGoal] = useState('Create a governed planning, design, development, QA, and testing loop for this codebase.')
  const [gateMode, setGateMode] = useState<GateMode>(workflowDefaults.gateMode ?? 'manual')
  const [capabilityId, setCapabilityId] = useState('')
  const [architectAgentTemplateId, setArchitectAgentTemplateId] = useState('')
  const [developerAgentTemplateId, setDeveloperAgentTemplateId] = useState('')
  const [qaAgentTemplateId, setQaAgentTemplateId] = useState('')
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

  const canCreate = goal.trim().length > 7
    && sourceUri.trim()
    && capabilityId
    && architectAgentTemplateId
    && developerAgentTemplateId
    && qaAgentTemplateId

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
          architectAgentTemplateId,
          developerAgentTemplateId,
          qaAgentTemplateId,
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
        <Route size={30} />
        <h2>Create or select a session</h2>
        <p>The loop map, stage cockpit, artifact notebook, and evidence timeline will appear here.</p>
      </section>
    )
  }

  return (
    <section className="workbench-grid">
      <LoopMap session={session} activeStageKey={activeStage?.key ?? null} onStage={setActiveStageKey} onSession={onSession} />
      <StageCockpit session={session} stage={activeStage} onSession={onSession} />
      <ArtifactNotebook session={session} activeStageKey={activeStage?.key} onSession={onSession} />
      <EvidenceTimeline session={session} />
    </section>
  )
}

function LoopMap({
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
  return (
    <section className="panel loop-map-panel">
      <div className="panel-heading">
        <Route size={18} />
        <div>
          <h2>Loop Map</h2>
          <p>{session.loopDefinition?.name ?? 'Blueprint loop'} · {session.gateMode === 'auto' ? 'conservative auto gates' : 'manual gates'}</p>
        </div>
      </div>

      <div className="session-strip">
        <div>
          <span className={`status ${session.status.toLowerCase()}`}>{session.status}</span>
          <strong>{session.sourceType}</strong>
        </div>
        <h3>{session.goal}</h3>
        <p>{session.sourceUri}</p>
      </div>

      <div className="loop-actions">
        <button className="secondary-action" disabled={snapshotMutation.isPending} onClick={() => snapshotMutation.mutate(session.id)}>
          {snapshotMutation.isPending ? <Loader2 className="spin" size={15} /> : <ScanSearch size={15} />}
          Snapshot
        </button>
        {latestSnapshot && (
          <span className="snapshot-pill">{latestSnapshot.fileCount} files · {formatBytes(latestSnapshot.totalBytes)}</span>
        )}
      </div>
      {snapshotMutation.isError && <p className="error-text">{snapshotMutation.error.message}</p>}

      <div className="loop-map">
        {(session.loopDefinition?.stages ?? []).map((stage, index) => {
          const attempts = attemptsFor(session, stage.key)
          const latest = attempts.at(-1)
          const status = latestStatus(latest)
          const Icon = roleMeta[stage.agentRole].icon
          return (
            <button
              type="button"
              key={stage.key}
              className={`loop-node ${activeStageKey === stage.key ? 'active' : ''} ${session.currentStageKey === stage.key ? 'current' : ''} ${status}`}
              onClick={() => onStage(stage.key)}
            >
              <span className="node-number">{index + 1}</span>
              <span className="node-main">
                <strong><Icon size={14} /> {stage.label}</strong>
                <small>{roleMeta[stage.agentRole].label} · {attempts.length || 0} iteration{attempts.length === 1 ? '' : 's'}</small>
              </span>
              <span className="node-verdict">{latest?.verdict ? verdictLabels[latest.verdict] : latest?.status ?? 'Ready'}</span>
            </button>
          )
        })}
      </div>

      <div className="greenline">
        <div>
          <strong>{green ? 'Loop is green' : 'Loop is not green yet'}</strong>
          <span>{green ? 'Final pack can be generated.' : 'Each required stage needs a pass or accepted-risk verdict.'}</span>
        </div>
        <BadgeCheck size={18} />
      </div>
    </section>
  )
}

function StageCockpit({
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
    return <section className="panel cockpit-panel"><p className="empty">No stage selected.</p></section>
  }

  const latest = attemptsFor(session, stage.key).at(-1)
  const canRun = Boolean(session.snapshots[0]) && latest?.status !== 'RUNNING'
  const requiredMissing = (stage.questions ?? [])
    .filter(question => question.required && !hasAnswer(answers[question.id]))
    .map(question => question.id)

  return (
    <section className="panel cockpit-panel">
      <div className="panel-heading">
        {(() => {
          const Icon = roleMeta[stage.agentRole].icon
          return <Icon size={18} />
        })()}
        <div>
          <h2>Stage Cockpit</h2>
          <p>{stage.label} · {roleMeta[stage.agentRole].label}</p>
        </div>
      </div>

      <div className="stage-hero">
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

      <div className="attempt-card">
        <strong>Latest attempt</strong>
        {latest ? (
          <>
            <span className={`status ${latestStatus(latest)}`}>{latest.verdict ? verdictLabels[latest.verdict] : latest.status}</span>
            <p>{latest.gateRecommendation?.reason ?? latest.error ?? 'Awaiting human verdict.'}</p>
            {latest.correlation && <code>{latest.correlation.cfCallId ?? latest.correlation.traceId ?? latest.id}</code>}
          </>
        ) : (
          <p>No attempt yet. Run this stage to generate artifacts and a gate recommendation.</p>
        )}
      </div>

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
          <CheckCircle2 size={15} /> Pass
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
    </section>
  )
}

function ArtifactNotebook({ session, activeStageKey, onSession }: { session: BlueprintSession; activeStageKey?: string; onSession: (session: BlueprintSession) => void }) {
  const [activeArtifactId, setActiveArtifactId] = useState<string | null>(null)
  const finalizeMutation = useMutation({ mutationFn: () => api.finalize(session.id), onSuccess: onSession })
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
    <section className="panel artifact-panel">
      <div className="panel-heading">
        <BookOpen size={18} />
        <div>
          <h2>Artifact Notebook</h2>
          <p>Versioned stage outputs and the final implementation pack.</p>
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
          <article>
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

function EvidenceTimeline({ session }: { session: BlueprintSession }) {
  const events = [...(session.reviewEvents ?? [])].reverse()
  const attempts = [...(session.stageAttempts ?? [])].reverse()
  return (
    <section className="panel evidence-panel">
      <div className="panel-heading">
        <ShieldCheck size={18} />
        <div>
          <h2>Evidence Timeline</h2>
          <p>Review events, Context Fabric calls, MCP IDs, and tokens.</p>
        </div>
      </div>

      <div className="timeline">
        {events.length === 0 && attempts.length === 0 && <p className="empty">No loop events yet.</p>}
        {events.map(event => (
          <div className="timeline-row" key={event.id}>
            <span>{event.type.replaceAll('_', ' ')}</span>
            <strong>{event.message}</strong>
            <small>{new Date(event.createdAt).toLocaleString()}</small>
          </div>
        ))}
        {attempts.filter(attempt => attempt.correlation).map(attempt => (
          <div className="timeline-row evidence" key={attempt.id}>
            <span>{attempt.stageLabel} evidence</span>
            <strong>{attempt.correlation?.cfCallId ?? attempt.correlation?.traceId ?? attempt.id}</strong>
            <small>{attempt.tokensUsed?.total ? `${attempt.tokensUsed.total} tokens` : 'correlation captured'}</small>
          </div>
        ))}
      </div>
    </section>
  )
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
    gateMode,
    loopDefinition,
  }
}
