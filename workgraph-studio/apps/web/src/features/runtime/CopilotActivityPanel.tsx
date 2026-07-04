/**
 * CopilotActivityPanel — the run viewer's "live cockpit" for copilot workflows.
 *
 * Polls GET /workflow-instances/:id/copilot-activity (~2s), which folds every governed audit-gov
 * event under the run's trace prefix (wf-<instanceId>), into a colourised chronological feed —
 * the run-viewer analog of the blueprint-workbench LiveCockpit. Poll-based (the backend feed is
 * poll-friendly and fail-soft); exported/handoff runs show an idle empty-state until results post
 * back. Self-contained, dedupes by event id.
 */
import { useEffect, useRef, useState } from 'react'
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

// Governed audit-gov kinds are dotted (governed.tool.*, governed.llm.*, cf.execute.*, git.*).
// Tint by family so the feed reads at a glance.
function kindTint(kind: string): string {
  const k = kind.toLowerCase()
  if (k.includes('llm') || k.includes('model')) return 'rgba(99,102,241,0.12)'
  if (k.includes('tool')) return 'rgba(34,197,94,0.12)'
  if (k.includes('artifact') || k.includes('consumable')) return 'rgba(245,158,11,0.14)'
  if (k.includes('approval') || k.includes('govern')) return 'rgba(239,68,68,0.12)'
  if (k.includes('git') || k.includes('code') || k.includes('commit')) return 'rgba(168,85,247,0.14)'
  if (k.includes('phase')) return 'rgba(14,165,233,0.12)'
  return 'transparent'
}

const SEV_COLORS: Record<string, string> = { info: '#475569', warn: '#a16207', warning: '#a16207', error: '#b91c1c' }

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

  useEffect(() => {
    if (!instanceId || !token) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined

    async function poll() {
      if (stopped) return
      // Don't poll while the tab is hidden — cheap reschedule; resume immediately on focus
      // (visibilitychange below). Keeps background run-viewer tabs from hammering the feed.
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
          const fresh: ActivityRow[] = []
          for (const ev of responseEvents<ActivityRow>(d)) {
            if (seen.current.has(ev.id)) continue
            seen.current.add(ev.id)
            fresh.push(ev)
          }
          if (fresh.length) setEvents(prev => [...prev, ...fresh].sort((a, b) => a.timestamp.localeCompare(b.timestamp)))
          setStatus('live')
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
  }, [instanceId, token])

  return (
    <div style={{ width: 380, flexShrink: 0, background: '#fff', borderLeft: '1px solid #e2e8f0', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px', borderBottom: '1px solid #e2e8f0' }}>
        <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 4, background: status === 'live' ? '#16a34a' : status === 'error' ? '#ef4444' : '#f59e0b' }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: '#0f172a' }}>Live activity</div>
          <div style={{ fontSize: 10, color: '#64748b' }}>{events.length} governed events · {status}</div>
        </div>
      </div>
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        {events.length === 0 ? (
          <div style={{ padding: 18, fontSize: 12, color: '#94a3b8', textAlign: 'center', lineHeight: 1.5 }}>
            No activity yet. Governed copilot events (LLM calls, tools, phases, commits) stream here as the run works; for exported handoff runs, activity appears once results post back.
          </div>
        ) : events.map(ev => (
          <div key={ev.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 12px', borderBottom: '1px solid #f1f5f9', background: kindTint(ev.kind) }}>
            <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 10, color: '#94a3b8', minWidth: 64, flexShrink: 0 }}>{timeOnly(ev.timestamp)}</span>
            <span style={{ fontSize: 11, fontWeight: 600, color: SEV_COLORS[ev.severity] ?? '#475569', minWidth: 150, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ev.kind}</span>
            <span style={{ fontSize: 11, color: '#475569', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{previewPayload(ev.payload)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
