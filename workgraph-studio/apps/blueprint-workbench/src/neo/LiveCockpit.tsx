/**
 * M41.1 — Live Cockpit.
 *
 * Right-column real-time view of what the agent is doing RIGHT NOW.
 * Subscribes to workgraph-api's SSE endpoint at
 *   GET /api/workflow-instances/:runId/events/stream
 * (same endpoint LiveEventsPanel.tsx in workgraph-web uses).
 *
 * Renders three sections:
 *   - "Now" — the most recent LLM stream / tool call (animated)
 *   - "Activity" — chronological stream of tool calls, LLM responses,
 *     artifact creations, branch commits
 *   - "Receipts" — cumulative token / cost / latency rollup
 *
 * Auto-falls-back to polling /events if SSE is unavailable (same pattern
 * as LiveEventsPanel). Closes streams on unmount.
 */
import { useEffect, useMemo, useRef, useState } from 'react'

interface CockpitEvent {
  id: string
  kind: string
  timestamp: string
  capability_id?: string | null
  trace_id?: string | null
  source_service?: string | null
  payload?: Record<string, unknown> | null
}

type CockpitStatus = 'connecting' | 'streaming' | 'polling' | 'idle' | 'error'

const EVENT_CAP = 200      // ring buffer; oldest drops when exceeded
const POLL_INTERVAL_MS = 2500

function isToolEvent(k: string): boolean {
  return k.startsWith('tool.invocation')
}
function isLlmEvent(k: string): boolean {
  return k === 'llm.call.completed' || k === 'llm.call.started' || k === 'llm.stream.delta'
}
function isCodeEvent(k: string): boolean {
  return k === 'code_change.detected' || k === 'workspace.branch.created' || k === 'git.commit.created'
}
function isApprovalEvent(k: string): boolean {
  return k.startsWith('approval.')
}

function eventGlyph(k: string): string {
  if (isToolEvent(k))     return '🔧'
  if (isLlmEvent(k))      return '💬'
  if (isCodeEvent(k))     return '📝'
  if (isApprovalEvent(k)) return '🛂'
  if (k.startsWith('governance.')) return '⚖️'
  if (k.startsWith('artifact.'))   return '📄'
  return '·'
}

function eventLabel(ev: CockpitEvent): string {
  const p = ev.payload ?? {}
  if (isToolEvent(ev.kind)) {
    const name = (p.tool_name as string) ?? '?'
    const ok = p.success === false ? '✗' : '✓'
    return `${ok} ${name}`
  }
  if (ev.kind === 'llm.call.completed') {
    const modelAlias = stringValue(p.model_alias ?? p.modelAlias) ?? stringValue(p.provider) ?? 'gateway'
    const tokens = numberValue(p.total_tokens)
    const cost = numberValue(p.estimated_cost ?? p.estimatedCost)
    return `LLM ${modelAlias} · ${tokens.toLocaleString()} tok${cost ? ` · ${money(cost)}` : ''}`
  }
  if (ev.kind === 'code_change.detected') {
    const paths = (p.changed_paths as string[] | undefined) ?? []
    return `${paths.length} file${paths.length === 1 ? '' : 's'} changed`
  }
  if (ev.kind === 'workspace.branch.created') {
    return `branch ${(p.branch as string) ?? 'created'}`
  }
  if (ev.kind === 'git.commit.created') {
    return `commit ${((p.commit_sha as string) ?? '').slice(0, 7)}`
  }
  return ev.kind.replaceAll('.', ' › ')
}

function eventDetail(ev: CockpitEvent): string {
  const p = ev.payload ?? {}
  if (isToolEvent(ev.kind)) {
    const duration = numberValue(p.latency_ms ?? p.latencyMs)
    const risk = stringValue(p.risk_level ?? p.riskLevel)
    const target = stringValue(p.execution_target ?? p.executionTarget)
    const mode = stringValue(p.execution_mode ?? p.executionMode)
    const image = stringValue(p.container_image ?? p.containerImage)
    const network = stringValue(p.network_mode ?? p.networkMode)
    const runner = typeof p.isolation === 'object' && p.isolation
      ? stringValue((p.isolation as Record<string, unknown>).runner)
      : undefined
    return [target, risk, mode, image, network ? `network ${network}` : undefined, runner, duration ? `${duration} ms` : undefined]
      .filter(Boolean)
      .join(' · ')
  }
  if (ev.kind === 'llm.call.completed' || ev.kind === 'llm.response') {
    const provider = stringValue(p.provider)
    const model = stringValue(p.model)
    const finish = stringValue(p.finish_reason ?? p.finishReason)
    const latency = numberValue(p.latency_ms ?? p.latencyMs)
    const cost = numberValue(p.estimated_cost ?? p.estimatedCost)
    return [provider, model, finish, latency ? `${latency} ms` : undefined, cost ? money(cost) : undefined].filter(Boolean).join(' · ')
  }
  if (ev.kind === 'code_change.detected') {
    const paths = (p.paths_touched as string[] | undefined) ?? (p.changed_paths as string[] | undefined) ?? []
    return paths.slice(0, 3).join(', ')
  }
  if (ev.kind === 'governance.denied') {
    return stringValue(p.reason) ?? ''
  }
  return stringValue(p.phase ?? p.finishReason ?? p.finish_reason) ?? ''
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function money(value: number): string {
  if (!value) return '$0.00'
  if (value < 0.01) return `$${value.toFixed(4)}`
  return `$${value.toFixed(2)}`
}

export function LiveCockpit({
  workflowInstanceId,
  authToken,
}: {
  workflowInstanceId: string | null
  authToken: string | null
}) {
  const [events, setEvents] = useState<CockpitEvent[]>([])
  const [status, setStatus] = useState<CockpitStatus>('connecting')
  const [error, setError] = useState<string | null>(null)
  const seenIds = useRef<Set<string>>(new Set())

  // Standalone Workbench sessions aren't tied to a workflow run, so the
  // SSE stream has nothing to subscribe to. Show a friendly empty state
  // instead of a permanent connection error.
  if (!workflowInstanceId) {
    return (
      <section className="neo-cockpit unlinked" aria-label="Live agent activity">
        <header className="cockpit-head">
          <span className="cockpit-title">Live cockpit</span>
          <span className="cockpit-status idle">○ not linked</span>
        </header>
        <p className="cockpit-empty">
          This session isn't linked to a workflow run, so there's no live
          event stream to subscribe to. Open the Workbench from an active
          workflow task to see tools and tokens flow in real time.
        </p>
      </section>
    )
  }

  function push(ev: CockpitEvent) {
    if (!ev.id || seenIds.current.has(ev.id)) return
    seenIds.current.add(ev.id)
    setEvents(prev => {
      const next = [...prev, ev]
      // ring buffer — drop oldest if cap exceeded
      return next.length > EVENT_CAP ? next.slice(next.length - EVENT_CAP) : next
    })
  }

  useEffect(() => {
    if (!workflowInstanceId || !authToken) {
      setStatus('idle')
      return
    }
    let stopped = false
    let pollTimer: ReturnType<typeof setTimeout> | undefined
    let es: EventSource | undefined

    function startPolling(sinceId?: string) {
      if (!stopped) pollTimer = setTimeout(() => poll(sinceId), 250)
    }

    async function poll(sinceId?: string) {
      if (stopped) return
      try {
        const url = new URL(`/api/workflow-instances/${workflowInstanceId}/events`, window.location.origin)
        if (sinceId) url.searchParams.set('since_id', sinceId)
        const r = await fetch(url, { headers: { Authorization: `Bearer ${authToken}` } })
        if (!r.ok) {
          setStatus('error')
          // 403/404 are terminal — the run is gone or not ours. Stop the
          // polling loop instead of grinding a request every 2.5s forever.
          if (r.status === 403 || r.status === 404) {
            setError(r.status === 403 ? 'workflow run not accessible' : 'workflow run not found')
            stopped = true
            return
          }
          setError(`HTTP ${r.status}`)
        } else {
          const d = await r.json() as { events?: CockpitEvent[]; tail_id?: string | null }
          if (d.events?.length) for (const ev of d.events) push(ev)
          setStatus('polling')
          setError(null)
          sinceId = d.tail_id ?? sinceId
        }
      } catch (err) {
        setStatus('error')
        setError((err as Error).message)
      }
      if (!stopped) pollTimer = setTimeout(() => poll(sinceId), POLL_INTERVAL_MS)
    }

    // SSE first; fall back to polling on error / done
    const streamUrl = new URL(`/api/workflow-instances/${workflowInstanceId}/events/stream`, window.location.origin)
    streamUrl.searchParams.set('access_token', authToken)
    streamUrl.searchParams.set('max_idle_seconds', '120')
    es = new EventSource(streamUrl.toString())
    es.onopen = () => { if (!stopped) { setStatus('streaming'); setError(null) } }
    es.onmessage = (event) => {
      try { push(JSON.parse(event.data) as CockpitEvent) } catch { /* heartbeat */ }
    }
    es.addEventListener('done', () => {
      if (stopped) return
      setStatus('idle')
      es?.close()
      const last = Array.from(seenIds.current).at(-1)
      startPolling(last)
    })
    es.onerror = () => {
      if (stopped) return
      setStatus('polling')
      setError('stream unavailable; polling')
      es?.close()
      const last = Array.from(seenIds.current).at(-1)
      startPolling(last)
    }

    return () => {
      stopped = true
      if (pollTimer) clearTimeout(pollTimer)
      if (es) es.close()
    }
  }, [workflowInstanceId, authToken])

  const totals = useMemo(() => {
    let tokens = 0
    let toolCalls = 0
    let llmCalls = 0
    let codeChanges = 0
    let cost = 0
    for (const ev of events) {
      const p = ev.payload ?? {}
      if (typeof p.total_tokens === 'number') tokens += p.total_tokens
      cost += numberValue(p.estimated_cost ?? p.estimatedCost)
      if (isToolEvent(ev.kind)) toolCalls += 1
      if (ev.kind === 'llm.call.completed') llmCalls += 1
      if (ev.kind === 'code_change.detected') codeChanges += 1
    }
    return { tokens, toolCalls, llmCalls, codeChanges, cost }
  }, [events])

  const recent = events.slice(-40).reverse()
  const now = events.at(-1)

  return (
    <section className="neo-cockpit" aria-label="Live agent activity">
      <header className="cockpit-head">
        <span className="cockpit-title">Live cockpit</span>
        <span className={`cockpit-status ${status}`}>{statusLabel(status)}</span>
      </header>

      {now && (
        <div className="cockpit-now">
          <span className="now-glyph" aria-hidden>{eventGlyph(now.kind)}</span>
          <span className="now-label">{eventLabel(now)}</span>
          <span className="now-pulse" aria-hidden />
        </div>
      )}

      <div className="cockpit-totals">
        <Metric label="tokens" value={totals.tokens.toLocaleString()} />
        <Metric label="cost" value={money(totals.cost)} />
        <Metric label="LLM calls" value={String(totals.llmCalls)} />
        <Metric label="tools" value={String(totals.toolCalls)} />
        <Metric label="commits" value={String(totals.codeChanges)} />
      </div>

      <div className="cockpit-stream" role="log" aria-live="polite">
        {recent.length === 0 && (
          <p className="cockpit-empty">
            {status === 'streaming' ? 'Waiting for activity…' : status === 'idle' ? 'No active run.' : 'Connecting…'}
          </p>
        )}
        {recent.map(ev => (
          <div key={ev.id} className={`cockpit-row ${highlightClass(ev.kind)}`}>
            <span className="row-glyph" aria-hidden>{eventGlyph(ev.kind)}</span>
            <span className="row-copy">
              <span className="row-label">{eventLabel(ev)}</span>
              {eventDetail(ev) && <span className="row-detail">{eventDetail(ev)}</span>}
            </span>
            <time className="row-time">{shortTime(ev.timestamp)}</time>
          </div>
        ))}
      </div>

      {error && <p className="cockpit-error" role="status">{error}</p>}
    </section>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="cockpit-metric">
      <span className="metric-value">{value}</span>
      <span className="metric-label">{label}</span>
    </div>
  )
}

function highlightClass(kind: string): string {
  if (kind.startsWith('tool.invocation')) return 'tool'
  if (kind.startsWith('llm.'))            return 'llm'
  if (kind.startsWith('code_change.') || kind.startsWith('git.') || kind.startsWith('workspace.')) return 'code'
  if (kind.startsWith('approval.'))       return 'approval'
  if (kind.startsWith('governance.'))     return 'governance'
  return ''
}

function shortTime(iso?: string): string {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  } catch {
    return ''
  }
}

function statusLabel(s: CockpitStatus): string {
  switch (s) {
    case 'streaming': return '● live'
    case 'polling':   return '● polling'
    case 'connecting': return '● connecting'
    case 'idle':      return '○ idle'
    case 'error':     return '✗ error'
  }
}
