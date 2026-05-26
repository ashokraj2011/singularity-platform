/**
 * M41.1 — Live Cockpit.
 *
 * Right-column real-time view of what the agent is doing RIGHT NOW.
 *
 * Originally (M41.1) this component proxied workgraph-api's
 *   GET /api/workflow-instances/:runId/events/stream
 * which in turn pulled from context-fabric's legacy CallLog store.
 * After the M71 governed-loop cutover, context-fabric no longer writes
 * to CallLog — every per-turn event lands in audit-gov instead.
 * Subscribing to the legacy endpoint produced a permanent "no trace
 * recorded" 404 and the cockpit stayed blank for every real run.
 *
 * Today the cockpit subscribes to audit-gov directly, the same path the
 * M69 Loop Theater uses:
 *   - GET  /audit-gov/api/v1/audit/search?traceIdPrefix=blueprint-<sid>
 *     for the catch-up of the most recent ~100 events
 *   - GET  /audit-gov/api/v1/audit/stream
 *     for the live tail (filtered client-side on trace_id prefix)
 *
 * Renders three sections:
 *   - "Now" — the most recent LLM turn / tool call (animated)
 *   - "Activity" — chronological stream of LLM / tool / phase / commit
 *     events
 *   - "Receipts" — cumulative token / cost / latency rollup
 *
 * Closes streams on unmount.
 */
import { useEffect, useMemo, useRef, useState } from 'react'

interface CockpitEvent {
  id: string
  kind: string
  trace_id?: string | null
  created_at?: string
  occurred_at?: string
  // legacy fields kept so an old-style payload still renders
  timestamp?: string
  capability_id?: string | null
  source_service?: string | null
  payload?: Record<string, unknown> | null
}

type CockpitStatus = 'connecting' | 'streaming' | 'reconnecting' | 'idle' | 'error'

const AUDIT_GOV_BASE = '/audit-gov'
const EVENT_CAP = 200      // ring buffer; oldest drops when exceeded

// Event kinds we render. Anything not in here is filtered out so the
// noisy per-turn debug events (governed.llm_request etc.) don't drown
// the user-facing narrative.
const RENDERABLE_KINDS = new Set<string>([
  // governed loop (M71 cutover) — the modern path
  'governed.llm_response',
  'governed.tool_dispatched',
  'governed.tool_refused',
  'governed.phase_completed',
  'governed.phase_output_invalid',
  'governed.stage_aborted',
  'governed.auto_verify_completed',
  'governed.path_coverage_gap',
  'governed.pii_masked',
  // legacy mcp-server / workgraph events — still surface when present
  'llm.call.completed',
  'tool.invocation.completed',
  'code_change.detected',
  'code_change.applied',
  'workspace.branch.created',
  'git.commit.created',
  'agent.phase.transitioned',
  'blueprint.stage.run.completed',
])

function isToolEvent(k: string): boolean {
  return k === 'governed.tool_dispatched' || k === 'governed.tool_refused' || k.startsWith('tool.invocation')
}
function isLlmEvent(k: string): boolean {
  return k === 'governed.llm_response' || k === 'llm.call.completed' || k === 'llm.call.started' || k === 'llm.stream.delta'
}
function isCodeEvent(k: string): boolean {
  return k === 'code_change.detected' || k === 'code_change.applied' || k === 'workspace.branch.created' || k === 'git.commit.created'
}
function isPhaseEvent(k: string): boolean {
  return k === 'governed.phase_completed' || k === 'agent.phase.transitioned'
}
function isApprovalEvent(k: string): boolean {
  return k.startsWith('approval.')
}

function eventGlyph(k: string): string {
  if (isToolEvent(k))     return '🔧'
  if (isLlmEvent(k))      return '💬'
  if (isCodeEvent(k))     return '📝'
  if (isPhaseEvent(k))    return '➤'
  if (isApprovalEvent(k)) return '🛂'
  if (k.startsWith('governance.')) return '⚖️'
  if (k.startsWith('artifact.'))   return '📄'
  if (k.startsWith('governed.'))   return '·'
  return '·'
}

function eventTimestamp(ev: CockpitEvent): string | undefined {
  return ev.created_at ?? ev.occurred_at ?? ev.timestamp
}

function eventLabel(ev: CockpitEvent): string {
  const p = ev.payload ?? {}
  if (ev.kind === 'governed.tool_dispatched') {
    const name = stringValue(p.tool_name) ?? '?'
    const ok = p.tool_success === false ? '✗' : '✓'
    return `${ok} ${name}`
  }
  if (ev.kind === 'governed.tool_refused') {
    const name = stringValue(p.tool_name) ?? '?'
    return `⊘ ${name} (refused)`
  }
  if (ev.kind === 'governed.phase_completed') {
    const from = stringValue(p.from_phase) ?? '?'
    const to = stringValue(p.to_phase) ?? '?'
    return `${from} → ${to}`
  }
  if (ev.kind === 'governed.phase_output_invalid') {
    return 'phase output invalid'
  }
  if (ev.kind === 'governed.stage_aborted') {
    return 'stage aborted'
  }
  if (ev.kind === 'governed.llm_response') {
    const modelAlias = stringValue(p.model_alias ?? p.modelAlias) ?? stringValue(p.provider) ?? 'gateway'
    const inTok = numberValue(p.input_tokens)
    const outTok = numberValue(p.output_tokens)
    const cost = numberValue(p.estimated_cost ?? p.estimatedCost)
    const tokens = inTok + outTok
    return `LLM ${modelAlias} · ${tokens.toLocaleString()} tok${cost ? ` · ${money(cost)}` : ''}`
  }
  if (isToolEvent(ev.kind)) {
    const name = stringValue(p.tool_name) ?? '?'
    const ok = p.success === false ? '✗' : '✓'
    return `${ok} ${name}`
  }
  if (ev.kind === 'llm.call.completed') {
    const modelAlias = stringValue(p.model_alias ?? p.modelAlias) ?? stringValue(p.provider) ?? 'gateway'
    const tokens = numberValue(p.total_tokens)
    const cost = numberValue(p.estimated_cost ?? p.estimatedCost)
    return `LLM ${modelAlias} · ${tokens.toLocaleString()} tok${cost ? ` · ${money(cost)}` : ''}`
  }
  if (ev.kind === 'code_change.detected' || ev.kind === 'code_change.applied') {
    const paths = (p.paths_touched as string[] | undefined) ?? (p.changed_paths as string[] | undefined) ?? []
    return `${paths.length} file${paths.length === 1 ? '' : 's'} changed`
  }
  if (ev.kind === 'workspace.branch.created') {
    return `branch ${stringValue(p.branch) ?? 'created'}`
  }
  if (ev.kind === 'git.commit.created') {
    return `commit ${(stringValue(p.commit_sha) ?? '').slice(0, 7)}`
  }
  if (ev.kind === 'agent.phase.transitioned') {
    return `→ ${stringValue(p.to_phase) ?? stringValue(p.phase) ?? '?'}`
  }
  if (ev.kind === 'blueprint.stage.run.completed') {
    return `stage ${stringValue(p.verdict) ?? 'completed'}`
  }
  if (ev.kind === 'governed.auto_verify_completed') {
    return p.passed === false ? 'auto-verify failed' : 'auto-verify passed'
  }
  if (ev.kind === 'governed.path_coverage_gap') {
    return 'path coverage gap'
  }
  if (ev.kind === 'governed.pii_masked') {
    return 'pii masked'
  }
  return ev.kind.replaceAll('.', ' › ')
}

function eventDetail(ev: CockpitEvent): string {
  const p = ev.payload ?? {}
  if (ev.kind === 'governed.tool_dispatched' || ev.kind === 'governed.tool_refused') {
    const reason = stringValue(p.reason)
    const latency = numberValue(p.latency_ms ?? p.latencyMs)
    const paths = (p.paths_touched as string[] | undefined) ?? []
    const phase = stringValue(p.phase)
    return [phase, reason, paths.slice(0, 2).join(', '), latency ? `${latency} ms` : undefined]
      .filter(Boolean).join(' · ')
  }
  if (ev.kind === 'governed.phase_completed') {
    const receipt = stringValue(p.receipt_kind)
    const pending = p.approval_pending === true ? 'awaiting approval' : undefined
    return [receipt, pending].filter(Boolean).join(' · ')
  }
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
  if (ev.kind === 'governed.llm_response' || ev.kind === 'llm.call.completed' || ev.kind === 'llm.response') {
    const provider = stringValue(p.provider)
    const model = stringValue(p.model)
    const finish = stringValue(p.finish_reason ?? p.finishReason)
    const latency = numberValue(p.latency_ms ?? p.latencyMs)
    const cost = numberValue(p.estimated_cost ?? p.estimatedCost)
    return [provider, model, finish, latency ? `${latency} ms` : undefined, cost ? money(cost) : undefined].filter(Boolean).join(' · ')
  }
  if (ev.kind === 'code_change.detected' || ev.kind === 'code_change.applied') {
    const paths = (p.paths_touched as string[] | undefined) ?? (p.changed_paths as string[] | undefined) ?? []
    return paths.slice(0, 3).join(', ')
  }
  if (ev.kind === 'governance.denied') {
    return stringValue(p.reason) ?? ''
  }
  return stringValue(p.phase ?? p.finishReason ?? p.finish_reason ?? p.error_code) ?? ''
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
  sessionId,
  workflowInstanceId,
}: {
  /** BlueprintSession id — used to build the audit-gov trace prefix
   *  `blueprint-<sessionId>`. When null/undefined the cockpit shows
   *  the "not linked" empty state because there's no trace to follow. */
  sessionId: string | null
  /** Kept for the empty-state heuristic: a session that is workflow-linked
   *  but doesn't have its trace populated yet looks different than a
   *  standalone session that will never have one. */
  workflowInstanceId: string | null
  // legacy prop kept for backward compat — the new path doesn't need a
  // bearer token because the audit-gov proxy in vite.config.ts is open
  // in dev. Prod will replace it with a workgraph-api passthrough.
  authToken?: string | null
}) {
  const [events, setEvents] = useState<CockpitEvent[]>([])
  const [status, setStatus] = useState<CockpitStatus>('connecting')
  const [error, setError] = useState<string | null>(null)
  const seenIds = useRef<Set<string>>(new Set())

  // Standalone Workbench sessions without a linked session show a friendly
  // empty state. Workflow-scoped sessions with no session id yet are rare
  // (the workbench creates a session row before mounting), but treat them
  // the same way.
  if (!sessionId) {
    return (
      <section className="neo-cockpit unlinked" aria-label="Live agent activity">
        <header className="cockpit-head">
          <span className="cockpit-title">Live cockpit</span>
          <span className="cockpit-status idle">○ not linked</span>
        </header>
        <p className="cockpit-empty">
          {workflowInstanceId
            ? 'Loading session…'
            : "This session isn't linked to a workflow run, so there's no live event stream to subscribe to. Open the Workbench from an active workflow task to see tools and tokens flow in real time."}
        </p>
      </section>
    )
  }

  const tracePrefix = `blueprint-${sessionId}`

  function push(ev: CockpitEvent) {
    if (!ev.id || seenIds.current.has(ev.id)) return
    if (!RENDERABLE_KINDS.has(ev.kind)) return
    const tid = ev.trace_id ?? ''
    if (!tid.startsWith(tracePrefix)) return
    seenIds.current.add(ev.id)
    setEvents(prev => {
      const next = [...prev, ev]
      return next.length > EVENT_CAP ? next.slice(next.length - EVENT_CAP) : next
    })
  }

  useEffect(() => {
    // Reset state when the session/trace changes.
    seenIds.current = new Set()
    setEvents([])
    setStatus('connecting')
    setError(null)

    let closed = false
    let es: EventSource | undefined
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined

    // Catch-up: pull the most recent ~100 events for this trace so the
    // cockpit lights up the moment it opens, even if no new event fires
    // for a while. Without it, opening the workbench mid-run shows a
    // blank "Waiting for activity..." that reads as broken.
    async function catchUp() {
      try {
        const res = await fetch(`${AUDIT_GOV_BASE}/api/v1/audit/search`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ traceIdPrefix: tracePrefix, limit: 100 }),
        })
        if (closed || !res.ok) return
        const data = await res.json() as { items?: CockpitEvent[] }
        const items = (data.items ?? []).slice()
        // Oldest first so they read chronologically when the rollup
        // sorts by arrival.
        items.sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''))
        for (const ev of items) push(ev)
      } catch {
        // Catch-up is best-effort; live path still tries to connect.
      }
    }

    function connect() {
      if (closed) return
      // audit-gov SSE supports filtering by exact trace_id but not by
      // prefix, so we subscribe wide and filter on the client (same
      // pattern as useLiveLoopEventStream).
      const url = `${AUDIT_GOV_BASE}/api/v1/audit/stream`
      es = new EventSource(url)
      es.onopen = () => {
        if (closed) return
        setStatus('streaming')
        setError(null)
      }
      es.addEventListener('hello', () => {
        if (closed) return
        setStatus('streaming')
      })
      // audit-gov tags data frames as `event: audit`. Assigning
      // onmessage alone would never deliver them (only unnamed events
      // hit onmessage). Subscribe explicitly.
      const handleAuditFrame = (event: MessageEvent) => {
        if (closed) return
        try {
          const parsed = JSON.parse(event.data) as CockpitEvent
          push(parsed)
        } catch {
          // Keepalive `:` frames never reach onmessage; anything that
          // lands here and fails to parse is malformed — drop silently.
        }
      }
      es.addEventListener('audit', handleAuditFrame as EventListener)
      es.onmessage = handleAuditFrame
      es.onerror = () => {
        if (closed) return
        setStatus('reconnecting')
        setError('stream interrupted — retrying')
        es?.close()
        es = undefined
        if (!closed) {
          reconnectTimer = setTimeout(connect, 1500)
        }
      }
    }

    // Browser-state-aware reconnect — same pattern as
    // useLiveLoopEventStream.ts. macOS App Nap / Chrome tab freezing /
    // laptop sleep all leave EventSource in a zombie state; the standard
    // visibilitychange + online events tell us the user's back so we
    // force a fresh connect. Idempotent — when es is live we no-op.
    function reviveIfNeeded() {
      if (closed) return
      if (!es || es.readyState === EventSource.CLOSED) {
        setStatus('reconnecting')
        if (reconnectTimer) clearTimeout(reconnectTimer)
        connect()
      }
    }
    function onVisibility() {
      if (document.visibilityState === 'visible') reviveIfNeeded()
    }
    function onOnline() { reviveIfNeeded() }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('online', onOnline)

    catchUp().then(() => {
      if (!closed) connect()
    })

    return () => {
      closed = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('online', onOnline)
      if (es) es.close()
      setStatus('idle')
    }
  }, [sessionId])

  const totals = useMemo(() => {
    let tokens = 0
    let toolCalls = 0
    let llmCalls = 0
    let codeChanges = 0
    let cost = 0
    for (const ev of events) {
      const p = ev.payload ?? {}
      const inTok = numberValue(p.input_tokens)
      const outTok = numberValue(p.output_tokens)
      if (typeof p.total_tokens === 'number') tokens += p.total_tokens
      else if (inTok || outTok) tokens += inTok + outTok
      cost += numberValue(p.estimated_cost ?? p.estimatedCost)
      if (isToolEvent(ev.kind)) toolCalls += 1
      if (isLlmEvent(ev.kind)) llmCalls += 1
      if (isCodeEvent(ev.kind)) codeChanges += 1
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
            {status === 'streaming' ? 'Waiting for activity…' : status === 'idle' ? 'No active run.' : status === 'reconnecting' ? 'Reconnecting…' : 'Connecting…'}
          </p>
        )}
        {recent.map(ev => (
          <div key={ev.id} className={`cockpit-row ${highlightClass(ev.kind)}`}>
            <span className="row-glyph" aria-hidden>{eventGlyph(ev.kind)}</span>
            <span className="row-copy">
              <span className="row-label">{eventLabel(ev)}</span>
              {eventDetail(ev) && <span className="row-detail">{eventDetail(ev)}</span>}
            </span>
            <time className="row-time">{shortTime(eventTimestamp(ev))}</time>
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
  if (isToolEvent(kind))   return 'tool'
  if (isLlmEvent(kind))    return 'llm'
  if (isCodeEvent(kind))   return 'code'
  if (isPhaseEvent(kind))  return 'governance'
  if (kind.startsWith('approval.'))       return 'approval'
  if (kind.startsWith('governance.') || kind.startsWith('governed.')) return 'governance'
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
    case 'streaming':    return '● live'
    case 'reconnecting': return '○ reconnecting'
    case 'connecting':   return '● connecting'
    case 'idle':         return '○ idle'
    case 'error':        return '✗ error'
  }
}
