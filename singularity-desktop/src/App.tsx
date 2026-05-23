import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { detectCopilotCli, SingularityLaptopSdk } from './laptopClient'
import './styles.css'

const DEFAULT_API_BASE_URL = import.meta.env.VITE_SINGULARITY_API_URL ?? 'http://localhost:8080'
const DEFAULT_WORKBENCH_URL = import.meta.env.VITE_BLUEPRINT_WORKBENCH_URL ?? 'http://localhost:5176/?ui=neo'
const DEFAULT_EMAIL = import.meta.env.VITE_SINGULARITY_EMAIL ?? 'admin@singularity.local'
const DEFAULT_PASSWORD = import.meta.env.VITE_SINGULARITY_PASSWORD ?? 'Admin1234!'

type Surface = 'workbench' | 'copilot'
type Section = 'workitems' | 'sessions' | 'workbench' | 'copilot' | 'questions' | 'evidence' | 'doctor' | 'settings'

type LaptopStart = {
  invocation: { id: string; workItemId: string; status: string; client: string; mode: string }
  agentRun: { id: string }
  mcp: { url: string; token: string; tokenJti: string; expiresAt: string; scopes: string[] }
  prompt: { assemblyId: string | null; content: string; warnings: string[] }
}

type LaptopQuestion = {
  id: string
  question: string
  answer?: string | null
  status: string
  createdAt?: string
}

type Session = {
  id: string
  workItemId: string
  status: string
  mode: string
  prompt: string
  heartbeatStartedAt?: string
  questions?: LaptopQuestion[]
}

type WorkItemTarget = {
  id: string
  targetCapabilityId: string
  status: string
  childWorkflowInstanceId?: string | null
  childWorkflowNodeId?: string | null
}

type WorkItem = {
  id: string
  workCode: string
  title: string
  description?: string | null
  status: string
  workItemTypeKey?: string | null
  routingMode?: string | null
  routingState?: string | null
  sourceWorkflowInstanceId?: string | null
  sourceWorkflowNodeId?: string | null
  originType?: string
  input?: Record<string, unknown>
  targets?: WorkItemTarget[]
}

type DoctorResult = {
  api?: string
  token?: string
  copilot?: string
  git?: string
  repo?: string
  workbench?: string
}

function clean(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

function statusTone(status?: string): string {
  const normalized = (status ?? '').toUpperCase()
  if (['COMPLETED', 'APPROVED', 'ANSWERED'].includes(normalized)) return 'ok'
  if (['FAILED', 'CANCELLED', 'ROUTE_FAILED'].includes(normalized)) return 'bad'
  if (['RUNNING', 'STARTED', 'IN_PROGRESS'].includes(normalized)) return 'live'
  return 'neutral'
}

function buildWorkbenchUrl(item: WorkItem | null, baseUrl: string): string {
  if (!item) return ''
  const workflowInstanceId = clean(item.sourceWorkflowInstanceId) || clean(item.targets?.[0]?.childWorkflowInstanceId)
  const workflowNodeId = clean(item.sourceWorkflowNodeId) || clean(item.targets?.[0]?.childWorkflowNodeId)
  const url = new URL(baseUrl || DEFAULT_WORKBENCH_URL, window.location.href)
  url.searchParams.set('ui', 'neo')
  if (workflowInstanceId) url.searchParams.set('workflowInstanceId', workflowInstanceId)
  if (workflowNodeId) url.searchParams.set('workflowNodeId', workflowNodeId)
  url.searchParams.set('goal', item.title)
  if (item.targets?.[0]?.targetCapabilityId) url.searchParams.set('capabilityId', item.targets[0].targetCapabilityId)
  return url.toString()
}

function App() {
  const [section, setSection] = useState<Section>('workitems')
  const [surface, setSurface] = useState<Surface>('copilot')
  const [apiBaseUrl, setApiBaseUrl] = useState(() => localStorage.getItem('singularityDesk.apiBaseUrl') ?? DEFAULT_API_BASE_URL)
  const [workbenchBaseUrl, setWorkbenchBaseUrl] = useState(() => localStorage.getItem('singularityDesk.workbenchUrl') ?? DEFAULT_WORKBENCH_URL)
  const [repoDir, setRepoDir] = useState(() => localStorage.getItem('singularityDesk.repoDir') ?? '')
  const [copilotCommand, setCopilotCommand] = useState(() => localStorage.getItem('singularityDesk.copilotCommand') ?? 'copilot')
  const [token, setToken] = useState(() => localStorage.getItem('singularityDesk.token') ?? import.meta.env.VITE_SINGULARITY_TOKEN ?? '')
  const [agentTemplateId, setAgentTemplateId] = useState('')
  const [workItems, setWorkItems] = useState<WorkItem[]>([])
  const [selectedWorkItemId, setSelectedWorkItemId] = useState('')
  const [sessions, setSessions] = useState<Session[]>([])
  const [activeSessionId, setActiveSessionId] = useState('')
  const [terminalInput, setTerminalInput] = useState('')
  const [events, setEvents] = useState<string[]>([])
  const [doctor, setDoctor] = useState<DoctorResult>({})
  const [evidence, setEvidence] = useState<EvidenceResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [copilotRunning, setCopilotRunning] = useState(false)

  const terminalHostRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const heartbeatStopsRef = useRef<Map<string, () => void>>(new Map())
  const activeCopilotSessionRef = useRef('')

  const selectedWorkItem = workItems.find(item => item.id === selectedWorkItemId) ?? null
  const activeSession = sessions.find(session => session.id === activeSessionId) ?? null
  const workbenchUrl = useMemo(() => buildWorkbenchUrl(selectedWorkItem, workbenchBaseUrl), [selectedWorkItem, workbenchBaseUrl])

  const sdk = useMemo(() => new SingularityLaptopSdk({
    apiBaseUrl,
    tokenProvider: () => token,
  }), [apiBaseUrl, token])

  function log(message: string) {
    setEvents(prev => [`${new Date().toLocaleTimeString()}  ${message}`, ...prev].slice(0, 200))
  }

  function remember(patch: Partial<DeskConfig> = {}) {
    const next = {
      apiBaseUrl: patch.apiBaseUrl ?? apiBaseUrl,
      token: patch.token ?? token,
      repoDir: patch.repoDir ?? repoDir,
      workbenchUrl: patch.workbenchUrl ?? workbenchBaseUrl,
      copilotCommand: patch.copilotCommand ?? copilotCommand,
      preferredMode: patch.preferredMode ?? surface,
    }
    localStorage.setItem('singularityDesk.apiBaseUrl', next.apiBaseUrl ?? '')
    localStorage.setItem('singularityDesk.workbenchUrl', next.workbenchUrl ?? '')
    localStorage.setItem('singularityDesk.repoDir', next.repoDir ?? '')
    localStorage.setItem('singularityDesk.copilotCommand', next.copilotCommand ?? '')
    if (next.token) localStorage.setItem('singularityDesk.token', next.token)
    void window.singularityDesk?.setConfig(next)
  }

  async function signInWithDevDefaults(): Promise<string> {
    remember({ token: '' })
    const res = await fetch(`${apiBaseUrl.replace(/\/+$/, '')}/api/auth/iam-login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: DEFAULT_EMAIL, password: DEFAULT_PASSWORD }),
    })
    const body = await res.json().catch(() => ({})) as { access_token?: string; token?: string; message?: string }
    if (!res.ok) throw new Error(body.message ?? `default IAM login failed (${res.status})`)
    const nextToken = body.access_token ?? body.token
    if (!nextToken) throw new Error('default IAM login did not return an access token')
    setToken(nextToken)
    remember({ token: nextToken })
    log(`Signed in with dev IAM user ${DEFAULT_EMAIL}`)
    return nextToken
  }

  async function activeToken(): Promise<string> {
    if (token) {
      remember({ token })
      return token
    }
    return signInWithDevDefaults()
  }

  async function authedFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
    const bearer = await activeToken()
    const res = await fetch(`${apiBaseUrl.replace(/\/+$/, '')}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error((body as { message?: string; code?: string }).message ?? (body as { code?: string }).code ?? `${path} failed (${res.status})`)
    return body as T
  }

  async function loadWorkItems() {
    setBusy(true)
    try {
      const body = await authedFetch<{ items?: WorkItem[] }>('/api/work-items?limit=100&includeArchived=false')
      const items = body.items ?? []
      setWorkItems(items)
      if (!selectedWorkItemId && items[0]) setSelectedWorkItemId(items[0].id)
      log(`Loaded ${items.length} WorkItems`)
    } finally {
      setBusy(false)
    }
  }

  async function refreshSessions(workItemId = selectedWorkItemId) {
    if (!workItemId || !token) return
    const body = await authedFetch<{ items?: Array<Session & { renderedPrompt?: string }> }>(`/api/work-items/${encodeURIComponent(workItemId)}/laptop-invocations`)
    setSessions(prev => {
      const existing = new Map(prev.map(session => [session.id, session]))
      for (const item of body.items ?? []) {
        existing.set(item.id, {
          id: item.id,
          workItemId: item.workItemId,
          status: item.status,
          mode: item.mode,
          prompt: item.prompt || item.renderedPrompt || existing.get(item.id)?.prompt || '',
          questions: item.questions ?? [],
          heartbeatStartedAt: existing.get(item.id)?.heartbeatStartedAt,
        })
      }
      return [...existing.values()].sort((a, b) => a.id < b.id ? 1 : -1)
    })
  }

  async function startSession(mode: 'direct-copilot' | 'server-runtime' = 'direct-copilot'): Promise<LaptopStart> {
    if (!selectedWorkItemId) throw new Error('Select a WorkItem first')
    remember()
    const started = await sdk.startInvocation(selectedWorkItemId, {
      client: 'singularity-desk',
      mode,
      agentTemplateId: agentTemplateId || undefined,
      repoUrl: repoDir || undefined,
    }) as LaptopStart
    const stop = sdk.startHeartbeat(started.invocation.id)
    heartbeatStopsRef.current.set(started.invocation.id, stop)
    setActiveSessionId(started.invocation.id)
    setSessions(prev => [{
      id: started.invocation.id,
      workItemId: selectedWorkItemId,
      status: started.invocation.status,
      mode: started.invocation.mode,
      prompt: started.prompt.content,
      heartbeatStartedAt: new Date().toISOString(),
      questions: [],
    }, ...prev])
    log(`Started ${started.invocation.id} (${mode})`)
    return started
  }

  async function startCopilot() {
    setSurface('copilot')
    setSection('copilot')
    if (!repoDir.trim()) {
      terminalRef.current?.writeln('\r\nChoose a repository directory before starting Copilot.')
      log('Copilot start blocked: repository directory is missing')
      return
    }
    try {
      const started = selectedWorkItem ? activeSession ?? await startSession('direct-copilot') : null
      const isNewInvocation = Boolean(started && 'invocation' in started)
      const invocationId = started
        ? isNewInvocation
          ? (started as LaptopStart).invocation.id
          : (started as Session).id
        : `local-${Date.now()}`
      const prompt = started
        ? isNewInvocation
          ? (started as LaptopStart).prompt.content
          : (started as Session).prompt
        : 'You are running in Singularity Desktop local Copilot mode. Inspect this repository, help with coding tasks, run useful checks when asked, and summarize any changes.'
      activeCopilotSessionRef.current = invocationId
      terminalRef.current?.clear()
      terminalRef.current?.writeln(`Starting Copilot in ${repoDir}`)
      if (!selectedWorkItem) {
        terminalRef.current?.writeln('Local mode: no WorkItem selected, so this session will not upload Singularity audit evidence.')
      }
      const result = await window.singularityDesk?.startCopilot({
        sessionId: invocationId,
        command: copilotCommand || 'copilot',
        cwd: repoDir,
        args: [],
        initialInput: prompt,
      })
      setCopilotRunning(true)
      log(`Copilot process started${result?.pid ? ` pid=${result.pid}` : ''}`)
    } catch (err) {
      const message = (err as Error).message
      terminalRef.current?.writeln(`\r\nCopilot failed to start: ${message}`)
      log(`Copilot failed to start: ${message}`)
    }
  }

  async function sendTerminalInput() {
    if (!terminalInput.trim()) return
    if (!activeCopilotSessionRef.current || !copilotRunning) {
      terminalRef.current?.writeln('\r\nStart Copilot first, then send input.')
      log('Input not sent: Copilot is not running')
      return
    }
    await window.singularityDesk?.sendCopilotInput(activeCopilotSessionRef.current, `${terminalInput}\n`)
    terminalRef.current?.writeln(`\r\n> ${terminalInput}`)
    setTerminalInput('')
  }

  async function stopCopilot() {
    if (!activeCopilotSessionRef.current) return
    await window.singularityDesk?.stopCopilot(activeCopilotSessionRef.current)
    setCopilotRunning(false)
    log('Copilot process stopped')
  }

  async function pickRepo() {
    const picked = await window.singularityDesk?.pickRepoDirectory()
    if (picked) {
      setRepoDir(picked)
      remember({ repoDir: picked })
      log(`Repo directory set to ${picked}`)
    }
  }

  async function collectEvidence() {
    const result = await window.singularityDesk?.collectEvidence({ workdir: repoDir || undefined })
    if (!result) return
    setEvidence(result)
    setSection('evidence')
    log(`Collected evidence for ${result.changedFiles.length} changed file(s)`)
  }

  async function completeActiveSession(status: 'COMPLETED' | 'FAILED' | 'CANCELLED' = 'COMPLETED') {
    if (!activeSessionId) throw new Error('No active laptop session')
    const result = evidence ?? await window.singularityDesk?.collectEvidence({ workdir: repoDir || undefined })
    await sdk.complete(activeSessionId, status, {
      evidence: result,
      correlation: result?.correlation,
      completedFrom: 'singularity-desk',
    })
    heartbeatStopsRef.current.get(activeSessionId)?.()
    heartbeatStopsRef.current.delete(activeSessionId)
    setSessions(prev => prev.map(session => session.id === activeSessionId ? { ...session, status } : session))
    log(`Completed ${activeSessionId} as ${status}`)
  }

  async function answerQuestion(questionId: string) {
    const answer = window.prompt('Answer question')
    if (!answer) return
    await sdk.answer(questionId, answer)
    log(`Answered question ${questionId}`)
    await refreshSessions()
  }

  async function runDoctor() {
    const next: DoctorResult = {}
    try {
      const res = await fetch(`${apiBaseUrl.replace(/\/+$/, '')}/health`)
      next.api = res.ok ? 'ok' : `failed ${res.status}`
    } catch (err) {
      next.api = (err as Error).message
    }
    next.token = token ? 'configured' : 'missing'
    const copilot = window.singularityDesk
      ? await window.singularityDesk.detectCopilotCli()
      : await detectCopilotCli()
    next.copilot = copilot.available ? `available ${copilot.version ?? ''}` : `missing${copilot.warning ? `: ${copilot.warning}` : ''}`
    next.repo = repoDir ? 'configured' : 'missing'
    next.workbench = workbenchBaseUrl || DEFAULT_WORKBENCH_URL
    setDoctor(next)
    setSection('doctor')
    log('Doctor checks completed')
  }

  useEffect(() => {
    void (async () => {
      const cfg = await window.singularityDesk?.getConfig()
      if (!cfg) return
      if (cfg.apiBaseUrl) setApiBaseUrl(cfg.apiBaseUrl)
      if (cfg.token) setToken(cfg.token)
      if (cfg.repoDir) setRepoDir(cfg.repoDir)
      if (cfg.workbenchUrl) setWorkbenchBaseUrl(cfg.workbenchUrl)
      if (cfg.copilotCommand) setCopilotCommand(cfg.copilotCommand)
      if (cfg.preferredMode) setSurface(cfg.preferredMode)
    })()
  }, [])

  useEffect(() => {
    if (section !== 'copilot') return
    const host = terminalHostRef.current
    if (!host || terminalRef.current) return
    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily: 'JetBrains Mono, SFMono-Regular, Menlo, monospace',
      fontSize: 12,
      theme: { background: '#07111f', foreground: '#dbeafe', cursor: '#93c5fd' },
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(host)
    fit.fit()
    terminal.writeln('Singularity Copilot terminal ready.')
    terminal.onData(data => {
      if (activeCopilotSessionRef.current) void window.singularityDesk?.sendCopilotInput(activeCopilotSessionRef.current, data)
    })
    terminalRef.current = terminal
    fitRef.current = fit
    const onResize = () => fit.fit()
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      terminal.dispose()
      terminalRef.current = null
      fitRef.current = null
    }
  }, [section])

  useEffect(() => {
    const unsubscribe = window.singularityDesk?.onCopilotOutput(payload => {
      terminalRef.current?.write(payload.data)
      if (payload.exitCode !== undefined) {
        setCopilotRunning(false)
        setSessions(prev => prev.map(session => session.id === payload.sessionId ? { ...session, status: `EXITED_${payload.exitCode}` } : session))
      }
    })
    return () => unsubscribe?.()
  }, [])

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const data = event.data
      if (data && typeof data === 'object' && data.type === 'blueprintWorkbench.auth.request') {
        if (token && event.source && 'postMessage' in event.source) {
          ;(event.source as Window).postMessage({ type: 'blueprintWorkbench.auth', token }, '*')
          log('Supplied Workbench auth token')
        }
        return
      }
      if (data && typeof data === 'object' && data.type === 'blueprintWorkbench.finalized') {
        log(`Workbench finalized session ${clean(data.sessionId) || 'unknown'}`)
        void window.singularityDesk?.notify({ title: 'Workbench finalized', body: 'Final pack was produced.' })
        if (activeSessionId) {
          void sdk.complete(activeSessionId, 'COMPLETED', {
            workbenchFinalized: data,
            completedFrom: 'singularity-desk-workbench',
          }).catch(err => log(`Workbench completion upload failed: ${(err as Error).message}`))
        }
      }
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [activeSessionId, sdk, token])

  useEffect(() => {
    if (!selectedWorkItemId || !token) return
    void refreshSessions(selectedWorkItemId)
    const timer = window.setInterval(() => void refreshSessions(selectedWorkItemId), 10_000)
    return () => window.clearInterval(timer)
  }, [selectedWorkItemId, token])

  const openQuestions = sessions.flatMap(session => (session.questions ?? []).filter(q => q.status === 'OPEN').map(question => ({ ...question, sessionId: session.id })))

  return (
    <main className="deskShell">
      <aside className="rail">
        <div className="brand">S</div>
        {[
          ['workitems', 'WorkItems'],
          ['sessions', 'Sessions'],
          ['workbench', 'Workbench'],
          ['copilot', 'Copilot'],
          ['questions', 'Questions'],
          ['evidence', 'Evidence'],
          ['doctor', 'Doctor'],
          ['settings', 'Settings'],
        ].map(([key, label]) => (
          <button key={key} className={section === key ? 'railButton active' : 'railButton'} onClick={() => setSection(key as Section)}>{label}</button>
        ))}
      </aside>

      <section className="mainPane">
        <header className="topbar">
          <div>
            <p className="eyebrow">Singularity Desktop Workbench</p>
            <h1>{selectedWorkItem ? selectedWorkItem.title : 'Choose a WorkItem'}</h1>
          </div>
          <div className="segmented">
            <button className={surface === 'workbench' ? 'active' : ''} onClick={() => { setSurface('workbench'); setSection('workbench'); remember({ preferredMode: 'workbench' }) }}>Workbench Neo</button>
            <button className={surface === 'copilot' ? 'active' : ''} onClick={() => { setSurface('copilot'); setSection('copilot'); remember({ preferredMode: 'copilot' }) }}>Copilot Embedded</button>
          </div>
        </header>

        <div className="workspace">
          <section className="leftPane">
            {(section === 'workitems' || !selectedWorkItem) && (
              <Panel title="WorkItems" action={<button onClick={loadWorkItems} disabled={busy}>{busy ? 'Loading' : 'Refresh'}</button>}>
                <div className="workitemList">
                  {workItems.map(item => (
                    <button key={item.id} className={item.id === selectedWorkItemId ? 'workitem selected' : 'workitem'} onClick={() => setSelectedWorkItemId(item.id)}>
                      <span className={`dot ${statusTone(item.status)}`} />
                      <strong>{item.workCode}</strong>
                      <small>{item.workItemTypeKey ?? item.originType ?? 'WORKITEM'} · {item.status}</small>
                      <p>{item.title}</p>
                    </button>
                  ))}
                  {workItems.length === 0 && <Empty text="Load WorkItems to begin." />}
                </div>
              </Panel>
            )}

            {section === 'sessions' && (
              <Panel title="Active Sessions" action={<button onClick={() => selectedWorkItemId && refreshSessions()}>Refresh</button>}>
                <div className="cards">
                  {sessions.map(session => (
                    <button key={session.id} className={session.id === activeSessionId ? 'sessionCard selected' : 'sessionCard'} onClick={() => setActiveSessionId(session.id)}>
                      <strong>{session.id.slice(0, 8)}</strong>
                      <span>{session.mode} · {session.status}</span>
                      <small>{session.questions?.filter(q => q.status === 'OPEN').length ?? 0} open questions</small>
                    </button>
                  ))}
                  {sessions.length === 0 && <Empty text="Start a Workbench or Copilot session." />}
                </div>
              </Panel>
            )}

            {section === 'workbench' && (
              <Panel title="Workbench Neo" action={<button onClick={() => window.singularityDesk?.openExternal(workbenchUrl)} disabled={!workbenchUrl}>Open External</button>}>
                {!selectedWorkItem ? <Empty text="Select a WorkItem first." /> : (
                  <div className="embeddedFrameWrap">
                    <div className="frameBar">
                      <span>{clean(selectedWorkItem.sourceWorkflowInstanceId) ? 'Workflow-linked' : 'Standalone launch'}</span>
                      <code>{workbenchUrl}</code>
                    </div>
                    <iframe title="Workbench Neo" src={workbenchUrl} className="embeddedFrame" />
                  </div>
                )}
              </Panel>
            )}

            {section === 'copilot' && (
              <Panel title="Copilot Embedded" action={<div className="buttonRow"><button onClick={startCopilot} disabled={copilotRunning}>{copilotRunning ? 'Running' : 'Start Copilot'}</button><button className="secondary" onClick={stopCopilot} disabled={!copilotRunning}>Stop</button></div>}>
                <div className="terminalTools">
                  <input value={repoDir} onChange={e => setRepoDir(e.target.value)} placeholder="Repository directory" />
                  <button className="secondary" onClick={pickRepo}>Choose Repo</button>
                </div>
                <div className={copilotRunning ? 'terminalStatus live' : 'terminalStatus'}>
                  {copilotRunning ? `Connected to ${copilotCommand || 'copilot'} in ${repoDir}` : selectedWorkItem ? 'Choose a repo, start Copilot, then send instructions to the Copilot CLI process.' : 'Choose a repo and start Copilot for local mode. Select a WorkItem first if you want Singularity audit/evidence upload.'}
                </div>
                <div className="terminalHost" ref={terminalHostRef} />
                <div className="terminalTools">
                  <input value={terminalInput} onChange={e => setTerminalInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void sendTerminalInput() }} placeholder="Send input to Copilot" />
                  <button onClick={sendTerminalInput}>Send</button>
                </div>
              </Panel>
            )}

            {section === 'questions' && (
              <Panel title="Questions">
                <div className="cards">
                  {openQuestions.map(question => (
                    <div key={question.id} className="questionCard">
                      <small>{question.sessionId.slice(0, 8)}</small>
                      <p>{question.question}</p>
                      <button onClick={() => answerQuestion(question.id)}>Answer</button>
                    </div>
                  ))}
                  {openQuestions.length === 0 && <Empty text="No open laptop questions." />}
                </div>
              </Panel>
            )}

            {section === 'evidence' && (
              <Panel title="Evidence" action={<div className="buttonRow"><button onClick={collectEvidence}>Collect</button><button className="secondary" onClick={() => completeActiveSession('COMPLETED')} disabled={!activeSessionId}>Complete</button></div>}>
                {evidence ? (
                  <div className="evidence">
                    <strong>{evidence.changedFiles.length} changed file(s)</strong>
                    <pre>{evidence.diffStat || 'No diff stat.'}</pre>
                    <details>
                      <summary>Patch excerpt</summary>
                      <pre>{evidence.patchExcerpt || 'No patch.'}</pre>
                    </details>
                    {evidence.correlation && <p className="warning">Verification receipts are not captured automatically in this v1 panel. Runs with code changes still need a verification receipt or accepted-risk approval downstream.</p>}
                  </div>
                ) : <Empty text="Collect evidence from the selected repository." />}
              </Panel>
            )}

            {section === 'doctor' && (
              <Panel title="Doctor" action={<button onClick={runDoctor}>Run Doctor</button>}>
                <div className="doctorGrid">
                  {Object.entries(doctor).map(([key, value]) => <Field key={key} label={key} value={value ?? '-'} />)}
                  {Object.keys(doctor).length === 0 && <Empty text="Run Doctor to validate API, token, Copilot, repo, and Workbench config." />}
                </div>
              </Panel>
            )}

            {section === 'settings' && (
              <Panel title="Settings" action={<button onClick={() => { remember(); log('Settings saved') }}>Save</button>}>
                <div className="settingsGrid">
                  <FieldInput label="API URL" value={apiBaseUrl} onChange={setApiBaseUrl} />
                  <FieldInput label="Workbench URL" value={workbenchBaseUrl} onChange={setWorkbenchBaseUrl} />
                  <FieldInput label="Repo Directory" value={repoDir} onChange={setRepoDir} action={<button className="secondary" onClick={pickRepo}>Choose</button>} />
                  <FieldInput label="Copilot Command" value={copilotCommand} onChange={setCopilotCommand} />
                  <label className="formField full">
                    IAM Token
                    <textarea value={token} onChange={e => setToken(e.target.value)} placeholder="IAM bearer token" />
                  </label>
                  <FieldInput label="Agent Template ID" value={agentTemplateId} onChange={setAgentTemplateId} />
                  <button onClick={signInWithDevDefaults}>Dev Login</button>
                </div>
              </Panel>
            )}
          </section>

          <aside className="rightPane">
            <Panel title="Selected WorkItem">
              {selectedWorkItem ? (
                <div className="summary">
                  <strong>{selectedWorkItem.workCode}</strong>
                  <span className={`badge ${statusTone(selectedWorkItem.status)}`}>{selectedWorkItem.status}</span>
                  <p>{selectedWorkItem.description || selectedWorkItem.title}</p>
                  <Field label="type" value={selectedWorkItem.workItemTypeKey ?? 'GENERAL'} />
                  <Field label="routing" value={`${selectedWorkItem.routingMode ?? '-'} / ${selectedWorkItem.routingState ?? '-'}`} />
                  <Field label="target" value={selectedWorkItem.targets?.[0]?.targetCapabilityId ?? '-'} />
                </div>
              ) : <Empty text="No WorkItem selected." />}
            </Panel>

            <Panel title="Session">
              {activeSession ? (
                <div className="summary">
                  <strong>{activeSession.id.slice(0, 12)}</strong>
                  <span className={`badge ${statusTone(activeSession.status)}`}>{activeSession.status}</span>
                  <Field label="mode" value={activeSession.mode} />
                  <Field label="heartbeat" value={activeSession.heartbeatStartedAt ? 'running' : 'not started'} />
                  <details>
                    <summary>Prompt</summary>
                    <pre>{activeSession.prompt}</pre>
                  </details>
                </div>
              ) : <Empty text="No active session." />}
            </Panel>

            <Panel title="Events">
              <div className="eventList">
                {events.map((event, index) => <div key={`${event}-${index}`}>{event}</div>)}
                {events.length === 0 && <Empty text="No desktop events yet." />}
              </div>
            </Panel>
          </aside>
        </div>
      </section>
    </main>
  )
}

function Panel({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="panel">
      <div className="panelHeader">
        <h2>{title}</h2>
        {action}
      </div>
      {children}
    </section>
  )
}

function Empty({ text }: { text: string }) {
  return <p className="empty">{text}</p>
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="field">
      <span>{label}</span>
      <strong>{value || '-'}</strong>
    </div>
  )
}

function FieldInput({ label, value, onChange, action }: { label: string; value: string; onChange: (value: string) => void; action?: React.ReactNode }) {
  return (
    <label className="formField">
      {label}
      <div className="inputAction">
        <input value={value} onChange={e => onChange(e.target.value)} />
        {action}
      </div>
    </label>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
