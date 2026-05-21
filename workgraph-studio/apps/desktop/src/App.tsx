import React, { useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { detectCopilotCli, SingularityLaptopSdk } from '@singularity/laptop-sdk'
import './styles.css'

type Session = {
  id: string
  workItemId: string
  status: string
  mode: string
  prompt: string
}

function App() {
  const [apiBaseUrl, setApiBaseUrl] = useState('http://localhost:8080')
  const [token, setToken] = useState('')
  const [workItemId, setWorkItemId] = useState('')
  const [agentTemplateId, setAgentTemplateId] = useState('')
  const [sessions, setSessions] = useState<Session[]>([])
  const [events, setEvents] = useState<string[]>([])

  const sdk = useMemo(() => new SingularityLaptopSdk({
    apiBaseUrl,
    tokenProvider: () => token,
  }), [apiBaseUrl, token])

  async function startSession() {
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
    const copilot = await detectCopilotCli()
    setEvents(prev => [
      `Copilot CLI: ${copilot.available ? `available ${copilot.version ?? ''}` : 'missing'}${copilot.warning ? ` (${copilot.warning})` : ''}`,
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
          <input value={token} onChange={e => setToken(e.target.value)} type="password" />
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
          <button onClick={startSession} disabled={!token || !workItemId}>Start</button>
          <button onClick={runDoctor}>Doctor</button>
        </div>
      </aside>
      <section className="content">
        <div className="tabs">
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
