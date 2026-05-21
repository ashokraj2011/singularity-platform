import React, { useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { detectCopilotCli, SingularityLaptopSdk } from '@singularity/laptop-sdk'
import './styles.css'

const DEFAULT_API_BASE_URL = import.meta.env.VITE_SINGULARITY_API_URL ?? 'http://localhost:8080'
const DEFAULT_EMAIL = import.meta.env.VITE_SINGULARITY_EMAIL ?? 'admin@singularity.local'
const DEFAULT_PASSWORD = import.meta.env.VITE_SINGULARITY_PASSWORD ?? 'Admin1234!'

type Session = {
  id: string
  workItemId: string
  status: string
  mode: string
  prompt: string
}

type WorkItem = {
  id: string
  workCode: string
  title: string
  description?: string | null
  status: string
  originType?: string
  targets?: Array<{ id: string; targetCapabilityId: string; status: string }>
}

function App() {
  const [apiBaseUrl, setApiBaseUrl] = useState(() => localStorage.getItem('singularityDesk.apiBaseUrl') ?? DEFAULT_API_BASE_URL)
  const [token, setToken] = useState(() => localStorage.getItem('singularityDesk.token') ?? import.meta.env.VITE_SINGULARITY_TOKEN ?? '')
  const [workItemId, setWorkItemId] = useState('')
  const [agentTemplateId, setAgentTemplateId] = useState('')
  const [sessions, setSessions] = useState<Session[]>([])
  const [workItems, setWorkItems] = useState<WorkItem[]>([])
  const [events, setEvents] = useState<string[]>([])

  const sdk = useMemo(() => new SingularityLaptopSdk({
    apiBaseUrl,
    tokenProvider: () => token,
  }), [apiBaseUrl, token])

  function remember(nextToken = token, nextApiBaseUrl = apiBaseUrl) {
    localStorage.setItem('singularityDesk.apiBaseUrl', nextApiBaseUrl)
    if (nextToken) localStorage.setItem('singularityDesk.token', nextToken)
  }

  async function signInWithDevDefaults(): Promise<string> {
    remember('', apiBaseUrl)
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
    remember(nextToken, apiBaseUrl)
    setEvents(prev => [`Signed in with dev default IAM user ${DEFAULT_EMAIL}`, ...prev])
    return nextToken
  }

  async function activeToken(): Promise<string> {
    if (token) {
      remember(token, apiBaseUrl)
      return token
    }
    return signInWithDevDefaults()
  }

  async function loadWorkItems() {
    const bearer = await activeToken()
    const res = await fetch(`${apiBaseUrl.replace(/\/+$/, '')}/api/work-items?limit=100&includeArchived=false`, {
      headers: { authorization: `Bearer ${bearer}` },
    })
    const body = await res.json().catch(() => ({})) as { items?: WorkItem[]; message?: string; code?: string }
    if (!res.ok) throw new Error(body.message ?? body.code ?? `WorkItem load failed (${res.status})`)
    setWorkItems(body.items ?? [])
    setEvents(prev => [`Loaded ${(body.items ?? []).length} WorkItems from ${apiBaseUrl}`, ...prev])
  }

  async function startSession() {
    remember(token, apiBaseUrl)
    const started = await sdk.startInvocation(workItemId, {
      client: 'singularity-desk',
      mode: 'direct-copilot',
      agentTemplateId: agentTemplateId || undefined,
    })
    sdk.startHeartbeat(started.invocation.id)
    setSessions(prev => [{
      id: started.invocation.id,
      workItemId,
      status: started.invocation.status,
      mode: started.invocation.mode,
      prompt: started.prompt.content,
    }, ...prev])
    setEvents(prev => [`Started ${started.invocation.id}`, ...prev])
  }

  async function runDoctor() {
    const copilot = window.singularityDesk
      ? await window.singularityDesk.detectCopilotCli()
      : await detectCopilotCli()
    setEvents(prev => [
      `Copilot CLI: ${copilot.available ? `available ${copilot.version ?? ''}` : 'missing'}${copilot.command ? ` via ${copilot.command}` : ''}${copilot.warning ? ` (${copilot.warning})` : ''}`,
      ...prev,
    ])
  }

  return (
    <main className="shell">
      <aside className="sidebar">
        <h1>Singularity Desk</h1>
        <label>
          API
          <input value={apiBaseUrl} onChange={e => setApiBaseUrl(e.target.value)} />
        </label>
        <label>
          Token
          <textarea value={token} onChange={e => setToken(e.target.value)} placeholder="IAM bearer token; dev login can fill this" />
        </label>
        <label>
          WorkItem
          <input value={workItemId} onChange={e => setWorkItemId(e.target.value)} />
        </label>
        <label>
          Agent Template
          <input value={agentTemplateId} onChange={e => setAgentTemplateId(e.target.value)} />
        </label>
        <div className="actions">
          <button onClick={signInWithDevDefaults}>Dev Login</button>
          <button onClick={loadWorkItems}>Load WorkItems</button>
          <button onClick={startSession} disabled={!token || !workItemId}>Start</button>
          <button onClick={runDoctor}>Doctor</button>
        </div>
      </aside>
      <section className="content">
        <div className="tabs">
          <section className="workitems">
            <div className="sectionHeader">
              <h2>WorkItems</h2>
              <span>{workItems.length}</span>
            </div>
            <div className="workitemList">
              {workItems.map(item => (
                <button
                  key={item.id}
                  className={item.id === workItemId ? 'workitem selected' : 'workitem'}
                  onClick={() => setWorkItemId(item.id)}
                >
                  <strong>{item.workCode}</strong>
                  <span>{item.status}</span>
                  <p>{item.title}</p>
                </button>
              ))}
              {workItems.length === 0 && <p className="empty">Load WorkItems to select one.</p>}
            </div>
          </section>
          {sessions.map(session => (
            <article key={session.id} className="session">
              <div>
                <strong>{session.workItemId}</strong>
                <span>{session.mode} · {session.status}</span>
              </div>
              <pre>{session.prompt}</pre>
            </article>
          ))}
          {sessions.length === 0 && <p className="empty">No laptop sessions yet.</p>}
        </div>
        <aside className="events">
          <h2>Events</h2>
          {events.map((event, index) => <div key={`${event}-${index}`}>{event}</div>)}
        </aside>
      </section>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
