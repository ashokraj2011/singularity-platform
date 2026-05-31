/**
 * M69 Loop Theater — Replay-mode event loader.
 *
 * Phase 1: replay-only. Queries audit-gov via the Vite dev proxy
 * (/audit-gov/api/v1/audit/search) for all events tagged with the
 * given trace_id prefix, sorted oldest-first, and yields them in
 * order with a small delay so the theater animates rather than
 * dumping everything at once.
 *
 * Phase 2 will add live SSE via /audit-gov/api/v1/audit/stream/tail.
 * Keeping replay as the foundation: live is "replay buffer + open
 * stream", so the same scene mapper handles both.
 */
import { useEffect, useRef, useState } from 'react'
import { eventToScene, deriveToolCallScene, type AuditEvent, type SceneAction } from './eventToScene'

// In dev, audit-gov is reachable via the Vite proxy added in vite.config.ts.
// In prod, the nginx `/audit-gov/` location proxies to audit-gov.
//
// M100 P0 (2026-05-31) — security hardening. The audit-gov service token is
// no longer held in the browser bundle. Both the dev Vite proxy and the prod
// nginx config inject the Authorization header server-side from an env var, so
// the same-origin `/audit-gov` requests the browser makes carry no credential.
// This removes the "service token baked into a browser build" exposure flagged
// in the M100 plan. See vite.config.ts + Dockerfile for the injection sites.
// M100 P1 — base-relative so it resolves under the edge-gateway prefix
// (/workbench/audit-gov) and standalone (/audit-gov). Mirrors src/base.ts.
const AUDIT_GOV_BASE = `${import.meta.env.BASE_URL.replace(/\/$/, '')}/audit-gov`

interface UseLoopEventStreamOptions {
  /** Trace ID prefix to filter events by. The audit-gov /search endpoint
   * accepts a `trace_id` field that does a startsWith match. */
  traceIdPrefix: string
  /** Delay between successive scene actions (ms). Higher = more theatrical,
   * lower = faster scrub. Default 250ms = readable pace. */
  stepDelayMs?: number
  /** When true, the theater plays scenes one-by-one with stepDelayMs.
   * When false, all scenes load at once (useful for scrubbing). */
  paced?: boolean
}

interface UseLoopEventStreamResult {
  /** Scenes rendered so far, in chronological order. Grows as the
   * pacer steps through events. */
  scenes: SceneAction[]
  /** Total scenes available (after filtering). When scenes.length ===
   * totalScenes, replay is done. */
  totalScenes: number
  /** True while the initial fetch is in flight. */
  loading: boolean
  /** Last error message if anything failed. */
  error: string | null
  /** True when the pacer has caught up to the loaded scene list. */
  done: boolean
}

export function useLoopEventStream(opts: UseLoopEventStreamOptions): UseLoopEventStreamResult {
  const { traceIdPrefix, stepDelayMs = 250, paced = true } = opts
  const [allScenes, setAllScenes] = useState<SceneAction[]>([])
  const [scenes, setScenes] = useState<SceneAction[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const cancelled = useRef(false)

  // Fetch + scene-mapping pass. Runs once when traceIdPrefix changes.
  useEffect(() => {
    cancelled.current = false
    setLoading(true)
    setError(null)
    setAllScenes([])
    setScenes([])

    const url = `${AUDIT_GOV_BASE}/api/v1/audit/search`
    // M69 — audit-gov's schema uses camelCase. The 500 cap is server-side;
    // the theater paginates when a session exceeds that (rare —
    // most stages emit ~50–100 events). traceIdPrefix is a server-side
    // LIKE match added in M69: lets us pull every stage trace_id
    // (blueprint-<sessionId>-{design,develop,…}) in one call.
    const body = JSON.stringify({
      traceIdPrefix,
      limit: 500,
    })

    fetch(url, {
      method: 'POST',
      // M100 P0 — no Authorization header here on purpose. The same-origin
      // `/audit-gov` proxy (Vite in dev, nginx in prod) injects the service
      // token server-side so it never reaches the browser bundle.
      headers: {
        'content-type': 'application/json',
      },
      body,
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`audit-gov returned ${res.status}`)
        const data = await res.json() as { items?: AuditEvent[] }
        const items = data.items ?? []
        // Oldest first — audit-gov returns newest-first by default.
        items.sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''))
        const built: SceneAction[] = []
        for (const event of items) {
          const scene = eventToScene(event)
          if (!scene) continue
          // For tool-result scenes, synthesise the preceding tool-call so
          // the theater shows the call going right BEFORE the result
          // comes back. The mapper is idempotent — Phase 2 will replace
          // this once mcp-server emits dedicated tool-call events.
          if (scene.kind === 'tool-result') {
            const call = deriveToolCallScene(scene)
            if (call) built.push(call)
          }
          built.push(scene)
        }
        if (cancelled.current) return
        setAllScenes(built)
        setLoading(false)
      })
      .catch((err) => {
        if (cancelled.current) return
        setError(err instanceof Error ? err.message : String(err))
        setLoading(false)
      })

    return () => {
      cancelled.current = true
    }
  }, [traceIdPrefix])

  // Pacer. Reveals scenes one at a time, stepDelayMs apart.
  useEffect(() => {
    if (!paced) {
      setScenes(allScenes)
      return
    }
    if (allScenes.length === 0) {
      setScenes([])
      return
    }
    let i = 0
    setScenes([allScenes[0]])
    i = 1
    const id = window.setInterval(() => {
      if (i >= allScenes.length) {
        window.clearInterval(id)
        return
      }
      setScenes((prev) => [...prev, allScenes[i]])
      i += 1
    }, stepDelayMs)
    return () => window.clearInterval(id)
  }, [allScenes, paced, stepDelayMs])

  return {
    scenes,
    totalScenes: allScenes.length,
    loading,
    error,
    done: !loading && scenes.length === allScenes.length,
  }
}
