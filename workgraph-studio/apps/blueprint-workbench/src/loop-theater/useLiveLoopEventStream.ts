/**
 * M69 — Live event subscription for the Loop Theater.
 *
 * Drops the replay/pacer model in favor of audit-gov's SSE stream.
 * Each event the server pushes lands in state immediately, no chrono-
 * logical buffering. The agent is "speaking" to you as it works.
 *
 * Why a fresh hook instead of extending useLoopEventStream:
 * - Replay needs ordering, pagination, and rate-limited rendering;
 *   live needs none of those.
 * - SSE has connection lifecycle (open/error/close/reconnect) the
 *   replay code didn't model. Cleaner to have the two as siblings.
 *
 * Filter: audit-gov SSE supports `traceId` exact-match server-side.
 * Sessions span multiple stage trace_ids, so we subscribe wide and
 * filter prefix-style in the client. The volume is fine for dev (a
 * live run emits ~1 event/sec at peak). Production would benefit from
 * a `traceIdPrefix` server-side filter to cut traffic — left as a
 * follow-up alongside the workgraph-api SSE passthrough.
 */
import { useEffect, useRef, useState } from 'react'
import { eventToScene, deriveToolCallScene, type AuditEvent, type SceneAction } from './eventToScene'

const AUDIT_GOV_BASE = '/audit-gov'

export interface UseLiveLoopEventStreamOptions {
  /** Match every event whose trace_id starts with this. */
  traceIdPrefix: string
  /** Keep at most this many scenes in memory. Older scenes scroll out
   * of the DOM. Default 200 — enough for ~10 minutes of an active
   * stage at peak event rate. */
  maxScenes?: number
}

export interface UseLiveLoopEventStreamResult {
  scenes: SceneAction[]
  /** Connection status — drives the badge in the header. */
  status: 'connecting' | 'live' | 'reconnecting' | 'closed'
  /** Last error message if anything failed. */
  error: string | null
}

export function useLiveLoopEventStream(opts: UseLiveLoopEventStreamOptions): UseLiveLoopEventStreamResult {
  const { traceIdPrefix, maxScenes = 200 } = opts
  const [scenes, setScenes] = useState<SceneAction[]>([])
  const [status, setStatus] = useState<'connecting' | 'live' | 'reconnecting' | 'closed'>('connecting')
  const [error, setError] = useState<string | null>(null)
  const seenIds = useRef<Set<string>>(new Set())

  useEffect(() => {
    if (!traceIdPrefix) return
    // Reset state for the new prefix.
    seenIds.current = new Set()
    setScenes([])
    setStatus('connecting')
    setError(null)

    let closed = false
    let es: EventSource | undefined
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined

    function connect() {
      if (closed) return
      // No traceId filter sent — audit-gov SSE only does exact match.
      // Client filters by prefix below.
      const url = `${AUDIT_GOV_BASE}/api/v1/audit/stream`
      es = new EventSource(url)
      es.onopen = () => {
        if (closed) return
        setStatus('live')
        setError(null)
      }
      es.addEventListener('hello', () => {
        if (closed) return
        setStatus('live')
      })
      es.onmessage = (event) => {
        if (closed) return
        let parsed: AuditEvent | null = null
        try {
          parsed = JSON.parse(event.data) as AuditEvent
        } catch {
          // Keepalive frames are sent as comments (`: keepalive`) — they
          // never reach onmessage. Anything that lands here and fails to
          // parse is genuinely malformed; drop it silently.
          return
        }
        if (!parsed) return
        if (seenIds.current.has(parsed.id)) return
        const tid = parsed.trace_id ?? ''
        // Client-side prefix filter. Server-side traceIdPrefix on SSE is
        // a future enhancement; for now this is cheap.
        if (!tid.startsWith(traceIdPrefix)) return

        const scene = eventToScene(parsed)
        if (!scene) return
        seenIds.current.add(parsed.id)

        // Mirror the replay path: synthesise the tool-call bubble that
        // precedes a tool-result so the visual ping-pong still reads.
        const additions: SceneAction[] = []
        if (scene.kind === 'tool-result') {
          const call = deriveToolCallScene(scene)
          if (call) additions.push(call)
        }
        additions.push(scene)

        setScenes((prev) => {
          const next = prev.concat(additions)
          return next.length > maxScenes ? next.slice(-maxScenes) : next
        })
      }
      es.onerror = () => {
        if (closed) return
        // EventSource auto-retries by default. We still surface the
        // state change so the header badge reads "reconnecting".
        setStatus('reconnecting')
        setError('lost connection — retrying')
        // Force a fresh connect after a short backoff to avoid the
        // browser's default 3s implicit retry which can leave the
        // socket in a weird half-open state on some proxies.
        es?.close()
        es = undefined
        if (!closed) {
          reconnectTimer = setTimeout(connect, 1500)
        }
      }
    }

    connect()

    return () => {
      closed = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      es?.close()
      setStatus('closed')
    }
  }, [traceIdPrefix, maxScenes])

  return { scenes, status, error }
}
