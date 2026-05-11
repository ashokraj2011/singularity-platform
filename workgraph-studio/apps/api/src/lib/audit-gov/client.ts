/**
 * M24 — audit-governance read-only client.
 *
 * Used by the run-insights composite endpoint to fold cost / token / event
 * data from audit-governance-service (port 8500) into the per-run view.
 * Fail-soft: any error returns a zeroed shape so the rest of the dashboard
 * still renders.
 */
import { config } from '../../config'

const TIMEOUT_MS = 5_000

async function getJson<T>(path: string, query: Record<string, string | undefined>): Promise<T | null> {
  const url = new URL(path, config.AUDIT_GOV_URL.replace(/\/?$/, '/'))
  for (const [k, v] of Object.entries(query)) if (v) url.searchParams.set(k, v)
  try {
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!res.ok) {
      console.warn(`audit-gov ${path} → ${res.status}`)
      return null
    }
    return (await res.json()) as T
  } catch (err) {
    console.warn(`audit-gov ${path} failed: ${(err as Error).message}`)
    return null
  }
}

export interface AuditEvent {
  id: string
  trace_id: string | null
  source_service: string
  kind: string
  subject_type: string | null
  subject_id: string | null
  actor_id: string | null
  capability_id: string | null
  severity: string
  payload: Record<string, unknown> | null
  created_at: string
}

export async function fetchEventsForInstance(instanceId: string, limit = 200): Promise<AuditEvent[]> {
  // Three lookups in parallel — workgraph events write subject_id=instanceId
  // via publishOutbox; cf / mcp events write trace_id=instanceId when callers
  // pass that through (best-effort).
  const [bySubject, byTrace] = await Promise.all([
    getJson<{ items: AuditEvent[] }>('api/v1/audit/timeline', { subject_id: instanceId, limit: String(limit) }),
    getJson<{ items: AuditEvent[] }>('api/v1/audit/timeline', { trace_id: instanceId, limit: String(limit) }),
  ])
  const seen = new Set<string>()
  const out: AuditEvent[] = []
  for (const row of [...(bySubject?.items ?? []), ...(byTrace?.items ?? [])]) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    out.push(row)
  }
  out.sort((a, b) => a.created_at.localeCompare(b.created_at))
  return out
}

export interface CostTotals {
  llm_calls: number
  total_tokens: number
  total_cost_usd: number
  governance_denied: number
  by_model: Array<{ provider: string; model: string; calls: number; total_tokens: number; cost_usd: number }>
}

export function rollupFromEvents(events: AuditEvent[]): CostTotals {
  let llmCalls = 0
  let totalTokens = 0
  let totalCost = 0
  let denied = 0
  const byModelMap = new Map<string, { provider: string; model: string; calls: number; total_tokens: number; cost_usd: number }>()

  for (const e of events) {
    const p = (e.payload ?? {}) as Record<string, unknown>
    if (e.kind === 'llm.call.completed') {
      llmCalls++
      const tokens = Number(p.total_tokens ?? 0)
      const cost   = Number(p.cost_usd ?? p.estimated_cost_usd ?? 0)
      totalTokens += isFinite(tokens) ? tokens : 0
      totalCost   += isFinite(cost)   ? cost   : 0
      const provider = String(p.provider ?? 'unknown')
      const model    = String(p.model    ?? 'unknown')
      const key = `${provider}|${model}`
      const row = byModelMap.get(key) ?? { provider, model, calls: 0, total_tokens: 0, cost_usd: 0 }
      row.calls += 1
      row.total_tokens += isFinite(tokens) ? tokens : 0
      row.cost_usd     += isFinite(cost)   ? cost   : 0
      byModelMap.set(key, row)
    }
    if (e.kind === 'governance.denied') denied++
  }

  return {
    llm_calls: llmCalls,
    total_tokens: totalTokens,
    total_cost_usd: Number(totalCost.toFixed(6)),
    governance_denied: denied,
    by_model: Array.from(byModelMap.values()).sort((a, b) => b.cost_usd - a.cost_usd),
  }
}
