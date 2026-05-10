import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  BadgeCheck, Boxes, Brain, CheckCircle2, ClipboardCheck, Code2, FileText,
  GitBranch, HardDrive, Loader2, Play, RefreshCw, ScanSearch, ShieldCheck,
  Sparkles, TriangleAlert, LogOut,
} from 'lucide-react'
import {
	  api, clearToken, getToken, pseudoLogin, type BlueprintSession,
	  type BlueprintSnapshot, type CreateSessionRequest, type LookupAgent,
	  type LookupCapability, type SourceType, type Stage, type DecisionAnswer,
	} from './api'

const stageMeta: Record<Stage, { label: string; icon: typeof Brain }> = {
  ARCHITECT: { label: 'Architect', icon: Brain },
  DEVELOPER: { label: 'Developer', icon: Code2 },
  QA: { label: 'QA', icon: ClipboardCheck },
}

const artifactOrder = [
  'decision_tree',
  'stakeholder_answers',
  'implementation_contract',
  'agent_questions',
  'mental_model',
  'gaps',
  'solution_architecture',
  'approved_spec_draft',
  'developer_task_pack',
  'simulated_code_change',
  'qa_task_pack',
  'verification_rules',
  'traceability_matrix',
  'certification_receipt',
  'approval_receipt',
]

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
          <button className="icon-button" onClick={() => {
            clearToken()
            setAuthTick(authTick + 1)
            setActiveSession(null)
            queryClient.clear()
          }} title="Sign out">
            <LogOut size={16} />
          </button>
        </div>
      </header>

      <section className="workspace-grid">
        <WorkbenchForm onCreated={refreshSession} />
        <PipelinePanel session={activeSession} onSession={refreshSession} />
        <ArtifactPanel session={activeSession} onSession={refreshSession} />
        <EvidencePanel session={activeSession} sessions={sessions} onSelect={setActiveSession} />
      </section>
    </main>
  )
}

function AuthGate({ onAuthed }: { onAuthed: () => void }) {
  const loginMutation = useMutation({
    mutationFn: pseudoLogin,
    onSuccess: onAuthed,
  })
  return (
    <main className="auth-empty">
      <div>
        <Sparkles size={28} />
        <h1>Blueprint Workbench</h1>
        <p>This standalone MVP uses the same Workgraph API, but it needs its own browser token on port 5176.</p>
        <button className="primary-action" onClick={() => loginMutation.mutate()} disabled={loginMutation.isPending}>
          {loginMutation.isPending ? <Loader2 className="spin" size={16} /> : <ShieldCheck size={16} />}
          Continue as super admin
        </button>
        {loginMutation.isError && <p className="error-text">{loginMutation.error.message}</p>}
      </div>
    </main>
  )
}

function WorkbenchForm({ onCreated }: { onCreated: (session: BlueprintSession) => void }) {
  const [sourceType, setSourceType] = useState<SourceType>('localdir')
  const [sourceUri, setSourceUri] = useState('')
  const [sourceRef, setSourceRef] = useState('')
  const [goal, setGoal] = useState('Create a governed planning, solution architecture, coding, and QA flow for this codebase.')
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
    if (agents[0]) {
      setArchitectAgentTemplateId(v => v || agents[0].id)
      setDeveloperAgentTemplateId(v => v || agents[0].id)
      setQaAgentTemplateId(v => v || agents[0].id)
    }
  }, [agents])

  const createMutation = useMutation({
    mutationFn: (body: CreateSessionRequest) => api.createSession(body),
    onSuccess: onCreated,
  })

  const canCreate = goal.trim().length > 7 && sourceUri.trim() && capabilityId && architectAgentTemplateId && developerAgentTemplateId && qaAgentTemplateId

  return (
    <section className="panel setup-panel">
      <div className="panel-heading">
        <Boxes size={18} />
        <div>
          <h2>Session Context</h2>
          <p>Read-only source intake plus the three agent bindings.</p>
        </div>
      </div>

      <label>
        <span>Goal</span>
        <textarea value={goal} onChange={e => setGoal(e.target.value)} rows={4} />
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
          onChange={e => setSourceUri(e.target.value)}
          placeholder={sourceType === 'github' ? 'https://github.com/org/repo' : '/path/visible/to/workgraph-api'}
        />
      </label>

      <div className="two-col">
        <label>
          <span>Branch / ref</span>
          <input value={sourceRef} onChange={e => setSourceRef(e.target.value)} placeholder="optional" />
        </label>
        <label>
          <span>Include globs</span>
          <input value={includeGlobs} onChange={e => setIncludeGlobs(e.target.value)} placeholder="optional" />
        </label>
      </div>

      <label>
        <span>Exclude globs</span>
        <input value={excludeGlobs} onChange={e => setExcludeGlobs(e.target.value)} />
      </label>

      <label>
        <span>Capability</span>
        <select value={capabilityId} onChange={e => setCapabilityId(e.target.value)}>
          <option value="">{capabilitiesQuery.isLoading ? 'Loading...' : 'Select capability'}</option>
          {capabilities.map(cap => <option key={cap.id} value={cap.id}>{capLabel(cap)}</option>)}
        </select>
      </label>

      <div className="agent-grid">
        <AgentSelect label="Architect" agents={agents} value={architectAgentTemplateId} onChange={setArchitectAgentTemplateId} />
        <AgentSelect label="Developer" agents={agents} value={developerAgentTemplateId} onChange={setDeveloperAgentTemplateId} />
        <AgentSelect label="QA" agents={agents} value={qaAgentTemplateId} onChange={setQaAgentTemplateId} />
      </div>

      {createMutation.isError && <p className="error-text">{String(createMutation.error.message)}</p>}
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
        })}
      >
        {createMutation.isPending ? <Loader2 className="spin" size={16} /> : <Sparkles size={16} />}
        Create Workbench Session
      </button>
    </section>
  )
}

function PipelinePanel({ session, onSession }: { session: BlueprintSession | null; onSession: (session: BlueprintSession) => void }) {
  const snapshotMutation = useMutation({ mutationFn: (id: string) => api.snapshot(id), onSuccess: onSession })
  const runMutation = useMutation({ mutationFn: (id: string) => api.run(id), onSuccess: onSession })
  const approveMutation = useMutation({ mutationFn: (id: string) => api.approve(id), onSuccess: onSession })
  const latestSnapshot = session?.snapshots[0]
  const stageStatus = useMemo(() => {
    const map = new Map<Stage, string>()
    for (const run of latestStageRuns(session)) map.set(run.stage, run.status)
    return map
  }, [session])
  const allStagesDone = ['ARCHITECT', 'DEVELOPER', 'QA'].every(stage => stageStatus.get(stage as Stage) === 'COMPLETED')
  const canRunAgents = Boolean(latestSnapshot) && session?.status !== 'RUNNING' && session?.status !== 'COMPLETED' && session?.status !== 'APPROVED'

  return (
    <section className="panel pipeline-panel">
      <div className="panel-heading">
        <ScanSearch size={18} />
        <div>
          <h2>Pipeline</h2>
          <p>Snapshot, architecture, simulated development, QA, approval.</p>
        </div>
      </div>

      {!session ? <p className="empty">Create a session to start the pipeline.</p> : (
        <>
          <div className="session-strip">
            <div>
              <span className={`status ${session.status.toLowerCase()}`}>{session.status}</span>
              <strong>{session.sourceType}</strong>
            </div>
            <h3>{session.goal}</h3>
            <p>{session.sourceUri}</p>
          </div>

          <div className="rail">
            <RailItem icon={ScanSearch} label="Snapshot" status={latestSnapshot?.status === 'COMPLETED' ? 'COMPLETED' : session.status === 'FAILED' ? 'FAILED' : 'PENDING'} />
            {(['ARCHITECT', 'DEVELOPER', 'QA'] as Stage[]).map(stage => {
              const Icon = stageMeta[stage].icon
              return <RailItem key={stage} icon={Icon} label={stageMeta[stage].label} status={stageStatus.get(stage) ?? 'PENDING'} />
            })}
            <RailItem icon={ShieldCheck} label="Approval" status={session.status === 'APPROVED' ? 'COMPLETED' : 'PENDING'} />
          </div>

          <div className="action-row">
            <button className="secondary-action" disabled={snapshotMutation.isPending} onClick={() => snapshotMutation.mutate(session.id)}>
              {snapshotMutation.isPending ? <Loader2 className="spin" size={15} /> : <ScanSearch size={15} />}
              Snapshot
            </button>
            <button className="secondary-action" disabled={!canRunAgents || runMutation.isPending} onClick={() => runMutation.mutate(session.id)}>
              {runMutation.isPending ? <Loader2 className="spin" size={15} /> : <Play size={15} />}
              Run Agents
            </button>
            <button className="secondary-action approve" disabled={!allStagesDone || session.status === 'APPROVED' || approveMutation.isPending} onClick={() => approveMutation.mutate(session.id)}>
              {approveMutation.isPending ? <Loader2 className="spin" size={15} /> : <BadgeCheck size={15} />}
              Approve
            </button>
          </div>

          <MutationError error={snapshotMutation.error ?? runMutation.error ?? approveMutation.error} />
          {latestSnapshot && <SnapshotSummary snapshot={latestSnapshot} />}
        </>
      )}
    </section>
  )
}

function ArtifactPanel({ session, onSession }: { session: BlueprintSession | null; onSession: (session: BlueprintSession) => void }) {
  const [activeKind, setActiveKind] = useState<string>('decision_tree')
  const artifacts = useMemo(() => {
    const latestByKind = new Map<string, BlueprintSession['artifacts'][number]>()
    for (const artifact of session?.artifacts ?? []) latestByKind.set(artifact.kind, artifact)
    const list = Array.from(latestByKind.values())
    list.sort((a, b) => artifactOrder.indexOf(a.kind) - artifactOrder.indexOf(b.kind))
    return list
  }, [session])
  const active = artifacts.find(a => a.kind === activeKind) ?? artifacts[0]

  useEffect(() => {
    if (artifacts[0] && !artifacts.some(a => a.kind === activeKind)) setActiveKind(artifacts[0].kind)
  }, [activeKind, artifacts])

  return (
    <section className="panel artifact-panel">
      <div className="panel-heading">
        <FileText size={18} />
        <div>
          <h2>Artifact Viewer</h2>
          <p>Contract-pack outputs from the staged agents.</p>
        </div>
      </div>
      {!session ? <p className="empty">Artifacts will appear after the pipeline runs.</p> : artifacts.length === 0 ? (
        <p className="empty">No artifacts yet. Run the snapshot and agent pipeline.</p>
      ) : (
        <div className="artifact-layout">
          <nav className="artifact-tabs">
            {artifacts.map(artifact => (
              <button key={artifact.id} className={active?.id === artifact.id ? 'active' : ''} onClick={() => setActiveKind(artifact.kind)}>
                {artifact.title}
              </button>
            ))}
          </nav>
	          <article>
	            <h3>{active?.title}</h3>
	            {active?.kind === 'decision_tree' ? (
	              <DecisionTree artifact={active} session={session} onSession={onSession} />
	            ) : active?.kind === 'implementation_contract' ? (
	              <ImplementationContract artifact={active} />
	            ) : (
	              <pre>{active?.content ?? JSON.stringify(active?.payload ?? {}, null, 2)}</pre>
	            )}
	          </article>
	        </div>
	      )}
    </section>
  )
}

type DecisionTreeNode = {
  id: string
  lane: string
  question: string
  recommended: string
  evidence: string
  options: Array<{ label: string; status: string; impact: string }>
  downstream: string[]
}

function DecisionTree({ artifact, session, onSession }: { artifact: BlueprintSession['artifacts'][number]; session: BlueprintSession | null; onSession: (session: BlueprintSession) => void }) {
  const tree = artifact.payload?.tree as { title?: string; goal?: string; nodes?: DecisionTreeNode[] } | undefined
  const nodes = tree?.nodes ?? []
  const persistedAnswers = useMemo(() => session?.metadata?.decisionAnswers ?? [], [session?.metadata?.decisionAnswers])
  const [answers, setAnswers] = useState<Record<string, DecisionAnswer>>({})
  const saveMutation = useMutation({
    mutationFn: (items: DecisionAnswer[]) => {
      if (!session) throw new Error('No active session')
      return api.saveDecisionAnswers(session.id, items)
    },
    onSuccess: onSession,
  })

  useEffect(() => {
    setAnswers(Object.fromEntries(persistedAnswers.map(answer => [answer.questionId, answer])))
  }, [persistedAnswers, session?.id])

  const answerList = Object.values(answers).filter(answer =>
    answer.selectedOptionLabel?.trim() || answer.customAnswer?.trim() || answer.notes?.trim(),
  )
  const hasDirtyAnswers = JSON.stringify(answerList) !== JSON.stringify(persistedAnswers)
  const setAnswer = (questionId: string, patch: Partial<DecisionAnswer>) => {
    setAnswers(current => {
      const previous = current[questionId] ?? { questionId, answerType: 'option' as const }
      return {
        ...current,
        [questionId]: {
          ...previous,
          ...patch,
          questionId,
        },
      }
    })
  }
  const clearAnswer = (questionId: string) => {
    setAnswers(current => {
      const next = { ...current }
      delete next[questionId]
      return next
    })
  }

  if (nodes.length === 0) return <pre>{artifact.content ?? 'No decision tree payload available.'}</pre>
  return (
    <div className="decision-tree">
      <div className="tree-summary">
        <Brain size={18} />
        <div>
          <strong>{tree?.title ?? 'Decision tree'}</strong>
          {tree?.goal && <span>{tree.goal}</span>}
        </div>
	        <button
	          className="secondary-action tree-save"
	          disabled={!session || !hasDirtyAnswers || saveMutation.isPending}
	          onClick={() => saveMutation.mutate(answerList)}
	        >
          {saveMutation.isPending ? <Loader2 className="spin" size={14} /> : <CheckCircle2 size={14} />}
          Save answers
        </button>
      </div>
      {saveMutation.isError && <p className="error-text">{saveMutation.error.message}</p>}
      <div className="tree-lanes">
        {nodes.map((node, index) => (
          <section className="tree-node" key={node.id}>
            <div className="node-index">{index + 1}</div>
            <div className="node-body">
              <div className="node-header">
                <span>{node.lane}</span>
                <code>{node.id}</code>
              </div>
              <h4>{node.question}</h4>
              <div className="recommended">
                <CheckCircle2 size={14} />
                <p>{node.recommended}</p>
              </div>
              <p className="evidence-text">{node.evidence}</p>
              <div className="option-grid">
                {node.options.map(option => (
                  <button
                    type="button"
                    className={`option-card ${option.status.replaceAll(' ', '-').toLowerCase()} ${answers[node.id]?.selectedOptionLabel === option.label ? 'selected' : ''}`}
                    key={option.label}
                    onClick={() => setAnswer(node.id, {
                      answerType: 'option',
                      selectedOptionLabel: option.label,
                      customAnswer: undefined,
                    })}
                  >
                    <strong>{option.label}</strong>
                    <span>{option.status}</span>
                    <p>{option.impact}</p>
                  </button>
                ))}
              </div>
              <div className="answer-editor">
                <label>
                  <span>Other / free-form answer</span>
                  <textarea
                    rows={2}
                    value={answers[node.id]?.customAnswer ?? ''}
                    onChange={event => setAnswer(node.id, {
                      answerType: 'freeform',
                      selectedOptionLabel: undefined,
                      customAnswer: event.target.value,
                    })}
                    placeholder="Capture the stakeholder answer when no option fits."
                  />
                </label>
                <label>
                  <span>Notes</span>
                  <textarea
	                    rows={2}
	                    value={answers[node.id]?.notes ?? ''}
	                    onChange={event => setAnswer(node.id, {
	                      answerType: answers[node.id]?.selectedOptionLabel ? 'option' : 'freeform',
	                      notes: event.target.value,
	                    })}
	                    placeholder="Reasoning, constraints, or approval conditions."
                  />
                </label>
                {answers[node.id] && (
                  <button type="button" className="clear-answer" onClick={() => clearAnswer(node.id)}>
                    Clear answer
                  </button>
                )}
              </div>
              <div className="downstream-row">
                {node.downstream.map(item => <span key={item}>{item}</span>)}
              </div>
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}

type ImplementationContractData = {
  title?: string
  status?: string
  goal?: string
  stakeholderInputs?: Array<{ role: string; contribution: string; outputs: string[] }>
  implementationUnits?: Array<{ id: string; title: string; owner: string; files: string[]; instructions: string; acceptance: string[] }>
  finalChecklist?: string[]
  handoffArtifacts?: string[]
}

function ImplementationContract({ artifact }: { artifact: BlueprintSession['artifacts'][number] }) {
  const contract = artifact.payload?.contract as ImplementationContractData | undefined
  if (!contract) return <pre>{artifact.content ?? 'No implementation contract payload available.'}</pre>
  return (
    <div className="implementation-contract">
      <div className="contract-hero">
        <FileText size={18} />
        <div>
          <strong>{contract.title ?? 'Final implementation contract'}</strong>
          {contract.goal && <span>{contract.goal}</span>}
        </div>
        {contract.status && <code>{contract.status}</code>}
      </div>

      <div className="stakeholder-grid">
        {(contract.stakeholderInputs ?? []).map(input => {
          const Icon = input.role === 'Architect' ? Brain : input.role === 'Developer' ? Code2 : ClipboardCheck
          return (
            <section className="stakeholder-card" key={input.role}>
              <div>
                <Icon size={16} />
                <strong>{input.role}</strong>
              </div>
              <p>{input.contribution}</p>
              <div className="downstream-row">
                {input.outputs.map(output => <span key={output}>{output}</span>)}
              </div>
            </section>
          )
        })}
      </div>

      <div className="contract-section">
        <h4>Implementation Units</h4>
        {(contract.implementationUnits ?? []).map(unit => (
          <section className="implementation-unit" key={unit.id}>
            <div className="unit-header">
              <code>{unit.id}</code>
              <strong>{unit.title}</strong>
              <span>{unit.owner}</span>
            </div>
            <p>{unit.instructions}</p>
            <div className="unit-files">
              {unit.files.map(file => <code key={file}>{file}</code>)}
            </div>
            <div className="downstream-row">
              {unit.acceptance.map(item => <span key={item}>{item}</span>)}
            </div>
          </section>
        ))}
      </div>

      <div className="contract-columns">
        <section className="contract-section">
          <h4>Final Checklist</h4>
          <ul>
            {(contract.finalChecklist ?? []).map(item => <li key={item}><CheckCircle2 size={14} /> {item}</li>)}
          </ul>
        </section>
        <section className="contract-section">
          <h4>Workflow Handoff</h4>
          <div className="handoff-list">
            {(contract.handoffArtifacts ?? []).map(item => <span key={item}>{item}</span>)}
          </div>
        </section>
      </div>
    </div>
  )
}

function EvidencePanel({ session, sessions, onSelect }: { session: BlueprintSession | null; sessions: BlueprintSession[]; onSelect: (session: BlueprintSession) => void }) {
  const correlations = latestStageRuns(session).filter(run => run.correlation)
  return (
    <section className="panel evidence-panel">
      <div className="panel-heading">
        <ShieldCheck size={18} />
        <div>
          <h2>Evidence</h2>
          <p>Prompt, Context Fabric, MCP, and code-change IDs.</p>
        </div>
      </div>
      {sessions.length > 0 && (
        <label>
          <span>Recent sessions</span>
          <select value={session?.id ?? ''} onChange={e => {
            const selected = sessions.find(s => s.id === e.target.value)
            if (selected) onSelect(selected)
          }}>
            {sessions.map(item => <option key={item.id} value={item.id}>{sessionOptionLabel(item)}</option>)}
          </select>
        </label>
      )}
      {!session ? <p className="empty">No evidence yet.</p> : correlations.length === 0 ? (
        <p className="empty">Run agents to capture Context Fabric and MCP evidence.</p>
      ) : (
        <div className="evidence-list">
          {correlations.map(run => (
            <div className="evidence-row" key={run.id}>
              <strong>{stageMeta[run.stage].label}</strong>
              <code>cf {short(run.correlation?.cfCallId)}</code>
              <code>prompt {short(run.correlation?.promptAssemblyId)}</code>
              <code>mcp {short(run.correlation?.mcpInvocationId)}</code>
              {(run.correlation?.codeChangeIds ?? []).length > 0 && <code>changes {(run.correlation?.codeChangeIds ?? []).map(short).join(', ')}</code>}
              {run.tokensUsed?.total !== undefined && <span>{run.tokensUsed.total} tokens</span>}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

function AgentSelect({ label, agents, value, onChange }: { label: string; agents: LookupAgent[]; value: string; onChange: (value: string) => void }) {
  return (
    <label>
      <span>{label}</span>
      <select value={value} onChange={e => onChange(e.target.value)}>
        <option value="">Select agent</option>
        {agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
      </select>
    </label>
  )
}

function RailItem({ icon: Icon, label, status }: { icon: typeof Brain; label: string; status: string }) {
  const normalized = status.toLowerCase()
  return (
    <div className={`rail-item ${normalized}`}>
      <Icon size={16} />
      <span>{label}</span>
      {status === 'COMPLETED' ? <CheckCircle2 size={14} /> : status === 'FAILED' ? <TriangleAlert size={14} /> : null}
    </div>
  )
}

function SnapshotSummary({ snapshot }: { snapshot: BlueprintSnapshot }) {
  const languages = Object.entries(snapshot.summary.languages ?? {}).slice(0, 5)
  return (
    <div className="snapshot-summary">
      <div>
        <strong>{snapshot.fileCount}</strong>
        <span>files</span>
      </div>
      <div>
        <strong>{formatBytes(snapshot.totalBytes)}</strong>
        <span>bounded scan</span>
      </div>
      <div>
        <strong>{short(snapshot.rootHash)}</strong>
        <span>root hash</span>
      </div>
      <div className="language-row">
        {languages.map(([name, count]) => <span key={name}>{name} {count}</span>)}
      </div>
    </div>
  )
}

function MutationError({ error }: { error: Error | null }) {
  if (!error) return null
  return <p className="error-text">{error.message}</p>
}

function capLabel(cap: LookupCapability) {
  return `${cap.name}${cap.capability_type ? ` · ${cap.capability_type}` : ''}${cap.source?.includes('agent-runtime') ? ' · Agent & Tools' : ''}`
}

function csv(value: string) {
  return value.split(',').map(item => item.trim()).filter(Boolean)
}

function short(value?: string) {
  if (!value) return 'n/a'
  return value.length > 12 ? `${value.slice(0, 8)}...` : value
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function sessionOptionLabel(session: BlueprintSession) {
  const goal = session.goal.length > 64 ? `${session.goal.slice(0, 61)}...` : session.goal
  return `${session.status} · ${goal}`
}

function latestStageRuns(session: BlueprintSession | null) {
  const latest = new Map<Stage, BlueprintSession['stageRuns'][number]>()
  for (const run of session?.stageRuns ?? []) latest.set(run.stage, run)
  return (['ARCHITECT', 'DEVELOPER', 'QA'] as Stage[])
    .map(stage => latest.get(stage))
    .filter((run): run is BlueprintSession['stageRuns'][number] => Boolean(run))
}
