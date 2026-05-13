/**
 * LiveEventsPanel (M9.y) — streams MCP-emitted events for a single workflow
 * instance via SSE through workgraph-api → context-fabric.
 *
 * Behaviour:
 *   1. On mount, opens an EventSource to /api/workflow-instances/:runId/events/stream
 *   2. Falls back to polling /api/workflow-instances/:runId/events every 1.5s
 *      if EventSource fails (e.g. browsers behind HTTP/1.1 proxies that drop
 *      long connections, or the server has no trace_id yet).
 *   3. Renders a colourised chronological list with kind, timestamp, and a
 *      compact payload preview.
 *   4. De-duplicates by event id.
 *
 * Self-contained — no Redux, no React Query. Drop into any page with a runId.
 */
import { useEffect, useRef, useState } from 'react'
import { useAuthStore } from '../../store/auth.store'

type EventRow = {
  id: string
  kind: string
  timestamp: string
  severity: string
  trace_id?: string | null
  run_id?: string | null
  run_step_id?: string | null
  agent_id?: string | null
  capability_id?: string | null
  mcp_invocation_id?: string | null
  tool_invocation_id?: string | null
  artifact_id?: string | null
  llm_call_id?: string | null
  payload?: Record<string, unknown>
}

const KIND_BG: Record<string, string> = {
  'llm.request':              'rgba(99,102,241,0.10)',
  'llm.response':             'rgba(99,102,241,0.18)',
  'llm.stream.delta':         'rgba(99,102,241,0.10)',
  'tool.invocation.created':  'rgba(34,197,94,0.10)',
  'tool.invocation.updated':  'rgba(34,197,94,0.18)',
  'artifact.created':         'rgba(245,158,11,0.18)',
  'artifact.updated':         'rgba(245,158,11,0.10)',
  'approval.wait.created':    'rgba(239,68,68,0.18)',
  'approval.wait.resolved':   'rgba(34,197,94,0.18)',
  'code_change.detected':     'rgba(168,85,247,0.18)',
  'git.commit.created':       'rgba(168,85,247,0.18)',
  'git.session.updated':      'rgba(168,85,247,0.10)',
  'run.event':                'rgba(100,116,139,0.18)',
}

const SEV_COLORS: Record<string, string> = {
  info:  '#475569',
  warn:  '#a16207',
  error: '#b91c1c',
}

function previewPayload(p?: Record<string, unknown>): string {
  if (!p) return ''
  const entries = Object.entries(p).slice(0, 4)
  return entries.map(([k, v]) => {
    let s: string
    if (typeof v === 'string') s = v.length > 40 ? `${v.slice(0, 40)}…` : v
    else if (v === null || v === undefined) s = String(v)
    else s = JSON.stringify(v)
    return `${k}=${s}`
  }).join(', ')
}

function deltaText(p?: Record<string, unknown>): string {
  const raw = p?.content
  return typeof raw === 'string' ? raw : ''
}

function timeOnly(iso: string): string {
  try { return new Date(iso).toISOString().slice(11, 23) } catch { return iso }
}

export function LiveEventsPanel({ runId }: { runId: string }) {
  const token = useAuthStore((s) => s.token)
  const [events, setEvents] = useState<EventRow[]>([])
  const [liveText, setLiveText] = useState('')
  const [status, setStatus] = useState<'connecting' | 'streaming' | 'polling' | 'idle' | 'error'>('connecting')
  const [error, setError] = useState<string | null>(null)
  const seenIds = useRef<Set<string>>(new Set())

  function pushEvent(ev: EventRow) {
    if (seenIds.current.has(ev.id)) return
    seenIds.current.add(ev.id)
    if (ev.kind === 'llm.stream.delta') {
      const chunk = deltaText(ev.payload)
      if (chunk) setLiveText((prev) => `${prev}${chunk}`)
    }
    setEvents((prev) => [...prev, ev].sort((a, b) => a.timestamp.localeCompare(b.timestamp)))
  }

  useEffect(() => {
    if (!runId || !token) return
    let stopped = false
    let pollTimer: ReturnType<typeof setTimeout> | undefined
    let es: EventSource | undefined

    function startPolling(sinceId?: string) {
      if (!stopped) pollTimer = setTimeout(() => poll(sinceId), 250)
    }

    async function poll(sinceId?: string) {
      if (stopped) return
      try {
        const url = new URL(`/api/workflow-instances/${runId}/events`, window.location.origin)
        if (sinceId) url.searchParams.set('since_id', sinceId)
        const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
        if (!r.ok) {
          setStatus('error')
          setError(`HTTP ${r.status}`)
        } else {
          const d = await r.json() as { events?: EventRow[]; tail_id?: string | null }
          if (d.events?.length) for (const ev of d.events) pushEvent(ev)
          setStatus('polling')
          setError(null)
          sinceId = d.tail_id ?? sinceId
        }
      } catch (err) {
        setStatus('error')
        setError((err as Error).message)
      }
      if (!stopped) pollTimer = setTimeout(() => poll(sinceId), 1500)
    }

    const streamUrl = new URL(`/api/workflow-instances/${runId}/events/stream`, window.location.origin)
    streamUrl.searchParams.set('access_token', token)
    streamUrl.searchParams.set('max_idle_seconds', '120')
    es = new EventSource(streamUrl.toString())
    es.onopen = () => {
      if (stopped) return
      setStatus('streaming')
      setError(null)
    }
    es.onmessage = (event) => {
      try {
        pushEvent(JSON.parse(event.data) as EventRow)
      } catch {
        // Ignore malformed payloads. SSE heartbeats are comments and do not
        // reach this handler.
      }
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
  }, [runId, token])

  return (
    <div
      style={{
        marginTop: 32,
        padding: 16,
        border: '1px solid #e2e8f0',
        borderRadius: 12,
        background: '#f8fafc',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#0A2240' }}>
            Live agent events
          </div>
          <div style={{ fontSize: 11, color: '#64748b' }}>
            Streamed from MCP via context-fabric — each event carries the full correlation chain.
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: '#64748b' }}>
          <span style={{
            display: 'inline-block', width: 8, height: 8, borderRadius: 4,
            background: status === 'streaming' || status === 'polling' ? '#16a34a'
              : status === 'connecting' ? '#f59e0b'
              : status === 'error' ? '#ef4444' : '#94a3b8',
          }} />
          <span>{status}{error ? ` — ${error}` : ''}</span>
          <span style={{ marginLeft: 8 }}>{events.length} events</span>
        </div>
      </div>

      {events.length === 0 ? (
        <div style={{
          padding: 18, textAlign: 'center', fontSize: 12, color: '#94a3b8',
          background: '#fff', borderRadius: 8, border: '1px dashed #cbd5e1',
        }}>
          No events yet. Run an AGENT_TASK to populate.
        </div>
      ) : (
        <>
          {liveText && (
            <div style={{
              whiteSpace: 'pre-wrap', fontSize: 12, lineHeight: 1.55, color: '#0f172a',
              background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8,
              padding: 12, marginBottom: 10, maxHeight: 220, overflowY: 'auto',
            }}>
              {liveText}
            </div>
          )}
          <div style={{ maxHeight: 380, overflowY: 'auto', background: '#fff', borderRadius: 8 }}>
            {events.map((ev) => (
              <div
                key={ev.id}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '6px 10px',
                  borderBottom: '1px solid #f1f5f9',
                  background: KIND_BG[ev.kind] ?? 'transparent',
                }}
              >
                <span style={{
                  fontFamily: 'ui-monospace, SFMono-Regular, monospace',
                  fontSize: 10.5, color: '#64748b', minWidth: 86, flexShrink: 0,
                }}>
                  {timeOnly(ev.timestamp)}
                </span>
                <span style={{
                  fontSize: 11, fontWeight: 600, color: SEV_COLORS[ev.severity] ?? '#475569',
                  minWidth: 200, flexShrink: 0,
                }}>
                  {ev.kind}
                </span>
                <span style={{
                  fontSize: 11, color: '#475569', overflow: 'hidden',
                  textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
                }}>
                  {previewPayload(ev.payload)}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
