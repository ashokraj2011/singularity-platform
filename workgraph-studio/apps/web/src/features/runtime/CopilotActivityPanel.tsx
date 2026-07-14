/**
 * CopilotActivityPanel — the run viewer's "live cockpit" for copilot workflows.
 *
 * Merges TWO live sources into one dedup'd, time-sorted feed:
 *   1. Governed audit-gov events — GET /workflow-instances/:id/copilot-activity
 *      (~2.5s poll), folded from the run's trace prefix (wf-<instanceId>): LLM
 *      calls, tools, commits, phases as the server-side run works.
 *   2. Live run mirror — off-platform Copilot phase progress over SSE
 *      (GET .../copilot-progress/events/stream), so an operator running the
 *      exported playbook on their own machine shows up here phase-by-phase in
 *      real time. Falls back to polling GET .../copilot-progress if the stream
 *      drops (mirrors LiveEventsPanel).
 *
 * Both sources emit the same row envelope ({ id, kind, timestamp, severity,
 * payload }), so they render through one path. Self-contained, dedupes by id.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuthStore } from '../../store/auth.store'
import { workgraphApiPath } from '../../lib/api'
import { sharedAuthToken } from '../../lib/sharedAuth'
import { readJsonResponse, responseEvents } from '../../lib/httpJson'

type ActivityRow = {
  id: string
  kind: string
  timestamp: string
  severity: string
  trace_id?: string | null
  capability_id?: string | null
  payload?: Record<string, unknown>
}

// Governed audit-gov kinds are dotted (governed.tool.*, governed.llm.*, cf.execute.*, git.*);
// live-mirror progress is copilot.progress.*. Tint by family so the feed reads at a glance.
function kindTint(kind: string): string {
  const k = kind.toLowerCase()
  if (k.includes('llm') || k.includes('model')) return 'rgba(99,102,241,0.12)'
  if (k.includes('tool')) return 'rgba(34,197,94,0.12)'
  if (k.includes('artifact') || k.includes('consumable')) return 'rgba(245,158,11,0.14)'
  if (k.includes('approval') || k.includes('govern')) return 'rgba(239,68,68,0.12)'
  if (k.includes('git') || k.includes('code') || k.includes('commit')) return 'rgba(168,85,247,0.14)'
  if (k.includes('phase') || k.includes('run.')) return 'rgba(14,165,233,0.12)'
  return 'transparent'
}

const SEV_COLORS: Record<string, string> = { info: '#b4b4bd', warn: '#f5c451', warning: '#f5c451', error: '#f77b7b' }

function previewPayload(p?: Record<string, unknown>): string {
  if (!p) return ''
  return Object.entries(p).slice(0, 4).map(([k, v]) => {
    let s: string
    if (typeof v === 'string') s = v.length > 48 ? `${v.slice(0, 48)}…` : v
    else if (v === null || v === undefined) s = String(v)
    else s = JSON.stringify(v)
    return `${k}=${s}`
  }).join(', ')
}

function timeOnly(iso: string): string {
  try { return new Date(iso).toLocaleTimeString() } catch { return iso }
}

export function CopilotActivityPanel({ instanceId }: { instanceId: string }) {
  const legacyToken = useAuthStore(s => s.token)
  const token = sharedAuthToken() ?? legacyToken
  const [events, setEvents] = useState<ActivityRow[]>([])
  const [status, setStatus] = useState<'connecting' | 'live' | 'error'>('connecting')
  const seen = useRef<Set<string>>(new Set())

  // Merge fresh rows from either source into one dedup'd, time-sorted feed.
  const addRows = useCallback((rows: ActivityRow[]) => {
    const fresh: ActivityRow[] = []
    for (const ev of rows) {
      if (!ev?.id || seen.current.has(ev.id)) continue
      seen.current.add(ev.id)
      fresh.push(ev)
    }
    if (fresh.length) {
      setEvents(prev => [...prev, ...fresh].sort((a, b) => a.timestamp.localeCompare(b.timestamp)))
    }
  }, [])

  // Source 1 — governed audit-gov events (poll ~2.5s), tab-visibility aware.
  useEffect(() => {
    if (!instanceId || !token) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined

    async function poll() {
      if (stopped) return
      // Don't poll while the tab is hidden — cheap reschedule; resume on focus.
      if (typeof document !== 'undefined' && document.hidden) {
        timer = setTimeout(poll, 2500)
        return
      }
      try {
        const url = new URL(workgraphApiPath(`/workflow-instances/${instanceId}/copilot-activity`), window.location.origin)
        const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
        if (!r.ok) {
          setStatus('error')
        } else {
          const d = await readJsonResponse<unknown>(r, 'copilot activity')
          addRows(responseEvents<ActivityRow>(d))
          setStatus(prev => (prev === 'connecting' ? 'live' : prev))
        }
      } catch {
        setStatus('error')
      }
      if (!stopped) timer = setTimeout(poll, 2500)
    }
    const onVisible = () => {
      if (!stopped && typeof document !== 'undefined' && !document.hidden) {
        if (timer) clearTimeout(timer)
        poll()
      }
    }
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)
    poll()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible)
    }
  }, [instanceId, token, addRows])

  // Source 2 — live run mirror: off-platform Copilot phase progress over SSE,
  // with a poll fallback (mirrors LiveEventsPanel). EventSource can't set an
  // Authorization header, so the JWT rides as ?access_token (middleware/auth.ts
  // honours it for /events/stream paths).
  useEffect(() => {
    if (!instanceId || !token) return
    let stopped = false
    let pollTimer: ReturnType<typeof setTimeout> | undefined
    let es: EventSource | undefined

    async function poll() {
      if (stopped) return
      try {
        const url = new URL(workgraphApiPath(`/workflow-instances/${instanceId}/copilot-progress`), window.location.origin)
        const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
        if (r.ok) {
          const d = await readJsonResponse<unknown>(r, 'copilot progress')
          addRows(responseEvents<ActivityRow>(d))
        }
      } catch {
        // best-effort — the audit poll keeps the panel alive regardless.
      }
      if (!stopped) pollTimer = setTimeout(poll, 3000)
    }

    const streamUrl = new URL(workgraphApiPath(`/workflow-instances/${instanceId}/copilot-progress/events/stream`), window.location.origin)
    streamUrl.searchParams.set('access_token', token)
    streamUrl.searchParams.set('max_ms', '600000')
    es = new EventSource(streamUrl.toString())
    es.onopen = () => { if (!stopped) setStatus('live') }
    es.onmessage = (event) => {
      if (stopped) return
      setStatus('live')
      try {
        addRows([JSON.parse(event.data) as ActivityRow])
      } catch {
        // SSE heartbeats are `:` comments and never reach onmessage; ignore malformed.
      }
    }
    es.addEventListener('done', () => {
      if (stopped) return
      es?.close()
      poll()
    })
    es.onerror = () => {
      if (stopped) return
      es?.close()
      poll()
    }

    return () => {
      stopped = true
      if (pollTimer) clearTimeout(pollTimer)
      if (es) es.close()
    }
  }, [instanceId, token, addRows])

  return (
    <div style={{ width: 380, flexShrink: 0, background: '#0c0c0f', borderLeft: '1px solid rgba(255,255,255,0.07)', color: '#f2f2f5', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
        <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 4, background: status === 'live' ? '#52d788' : status === 'error' ? '#f77b7b' : '#f5c451' }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 620, color: '#f2f2f5' }}>Live activity</div>
          <div style={{ fontSize: 10, color: '#82828e' }}>{events.length} events · {status}</div>
        </div>
      </div>
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        {events.length === 0 ? (
          <div style={{ padding: 18, fontSize: 12, color: '#82828e', textAlign: 'center', lineHeight: 1.5 }}>
            No activity yet. Governed copilot events (LLM calls, tools, phases, commits) stream here as the run works — including live phase progress from an operator running the exported playbook on their own machine.
          </div>
        ) : events.map(ev => (
          <div key={ev.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 12px', borderBottom: '1px solid rgba(255,255,255,0.05)', background: kindTint(ev.kind) }}>
            <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 10, color: '#82828e', minWidth: 64, flexShrink: 0 }}>{timeOnly(ev.timestamp)}</span>
            <span style={{ fontSize: 11, fontWeight: 600, color: SEV_COLORS[ev.severity] ?? '#b4b4bd', minWidth: 150, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ev.kind}</span>
            <span style={{ fontSize: 11, color: '#b4b4bd', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{previewPayload(ev.payload)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
