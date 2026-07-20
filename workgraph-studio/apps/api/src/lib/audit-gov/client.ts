/**
 * M24 — audit-governance read-only client.
 *
 * Used by the run-insights composite endpoint to fold cost / token / event
 * data from audit-governance-service (port 8500) into the per-run view.
 * Fail-soft: any error returns a zeroed shape so the rest of the dashboard
 * still renders.
 */
import { config } from '../../config'
import { readUpstreamJsonBody, upstreamSnippet, type UpstreamJsonBody } from '../upstream-json'

const TIMEOUT_MS = 5_000

// M74 Phase 2B — audit-gov's engine + events routes are gated by
// requireServiceAuth (see audit-governance-service/src/routes-events.ts).
// We send AUDIT_GOV_SERVICE_TOKEN on every request so the GET / POST
// helpers actually authenticate. Without this, EvalGateExecutor's
// run-trace POSTs were silently returning null (the helper logs but
// the caller often treats null as "no eval data" rather than "auth
// failed"), and the new closed-loop /eval-feedback GET was 401-ing.
function authHeader(): Record<string, string> {
  const token = process.env.AUDIT_GOV_SERVICE_TOKEN ?? ''
  return token ? { authorization: `Bearer ${token}` } : {}
}

/**
 * Tenant scope for audit-gov's query surface (see its tenant-scope.ts).
 *
 * The service token says WHICH SERVICE is asking; it does not say whose rows
 * may be read. Every read here belongs to a specific workflow run, so the run's
 * tenant is what scopes it.
 *
 * Omitted when the run has no tenant: audit-gov is the authority on what an
 * unscoped read means (it logs one in shadow and refuses it under enforce).
 * Substituting a placeholder here would silently scope the read to the wrong
 * tenant, which is worse than a refusal the caller can see.
 */
function scopeHeader(tenantId?: string): Record<string, string> {
  const tenant = (tenantId ?? '').trim()
  return tenant ? { 'x-tenant-id': tenant } : {}
}

type AuditGovBody = UpstreamJsonBody

async function readAuditGovBody(res: Response): Promise<AuditGovBody> {
  return readUpstreamJsonBody(res)
}

function auditGovErrorText(path: string, status: number, body: AuditGovBody, max = 500): string {
  const text = body.raw.trim() || (typeof body.data === 'string' ? body.data : '')
  if (body.parseError && status >= 200 && status < 300) {
    return `audit-gov ${path} returned invalid JSON (${body.parseError}): ${upstreamSnippet(text, max) || 'empty response body'}`
  }
  return `audit-gov ${path} -> ${status}: ${upstreamSnippet(text, max) || 'empty response body'}`
}

async function getJson<T>(
  path: string,
  query: Record<string, string | undefined>,
  tenantId?: string,
): Promise<T | null> {
  const url = new URL(path, config.AUDIT_GOV_URL.replace(/\/?$/, '/'))
  for (const [k, v] of Object.entries(query)) if (v) url.searchParams.set(k, v)
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { ...authHeader(), ...scopeHeader(tenantId) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const body = await readAuditGovBody(res)
    if (!res.ok) {
      console.warn(auditGovErrorText(path, res.status, body, 200))
      return null
    }
    if (body.parseError) {
      console.warn(auditGovErrorText(path, res.status, body, 200))
      return null
    }
    return body.data as T
  } catch (err) {
    console.warn(`audit-gov ${path} failed: ${(err as Error).message}`)
    return null
  }
}

export async function postJson<T>(path: string, body: unknown): Promise<T | null> {
  const url = new URL(path, config.AUDIT_GOV_URL.replace(/\/?$/, '/'))
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader() },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const responseBody = await readAuditGovBody(res)
    if (!res.ok) {
      console.warn(auditGovErrorText(path, res.status, responseBody, 200))
      return null
    }
    if (responseBody.parseError) {
      console.warn(auditGovErrorText(path, res.status, responseBody, 200))
      return null
    }
    return responseBody.data as T
  } catch (err) {
    console.warn(`audit-gov ${path} failed: ${(err as Error).message}`)
    return null
  }
}

// Proxy helpers for the operator-curation UI (task #111). Unlike
// getJson/postJson, these forward the upstream HTTP status so the UI
// can distinguish "audit-gov is down" (502) from "this example was
// deleted" (404) from "you forgot reviewed_by" (400). The composite
// run-insights endpoint can afford to fail-soft; the curation UI
// can't — the operator needs to see which write succeeded.
export interface UpstreamResult<T> {
  ok: boolean
  status: number
  data: T | null
  errorText?: string
}

export async function getJsonStrict<T>(
  path: string,
  query: Record<string, string | undefined> = {},
  tenantId?: string,
): Promise<UpstreamResult<T>> {
  const url = new URL(path, config.AUDIT_GOV_URL.replace(/\/?$/, '/'))
  for (const [k, v] of Object.entries(query)) if (v) url.searchParams.set(k, v)
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { ...authHeader(), ...scopeHeader(tenantId) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const body = await readAuditGovBody(res)
    if (!res.ok) {
      return { ok: false, status: res.status, data: null, errorText: auditGovErrorText(path, res.status, body) }
    }
    if (body.parseError) {
      return { ok: false, status: 502, data: null, errorText: auditGovErrorText(path, res.status, body) }
    }
    return { ok: true, status: res.status, data: body.data as T }
  } catch (err) {
    return { ok: false, status: 502, data: null, errorText: (err as Error).message }
  }
}

export async function patchJsonStrict<T>(
  path: string,
  body: unknown,
): Promise<UpstreamResult<T>> {
  const url = new URL(path, config.AUDIT_GOV_URL.replace(/\/?$/, '/'))
  try {
    const res = await fetch(url, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...authHeader() },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const responseBody = await readAuditGovBody(res)
    if (!res.ok) {
      return { ok: false, status: res.status, data: null, errorText: auditGovErrorText(path, res.status, responseBody) }
    }
    if (responseBody.parseError) {
      return { ok: false, status: 502, data: null, errorText: auditGovErrorText(path, res.status, responseBody) }
    }
    return { ok: true, status: res.status, data: responseBody.data as T }
  } catch (err) {
    return { ok: false, status: 502, data: null, errorText: (err as Error).message }
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

export async function fetchEventsForInstance(instanceId: string, limit = 200, tenantId?: string): Promise<AuditEvent[]> {
  // Three lookups in parallel — workgraph events write subject_id=instanceId
  // via publishOutbox; cf / mcp events write trace_id=instanceId when callers
  // pass that through (best-effort).
  const [bySubject, byTrace] = await Promise.all([
    getJson<{ items: AuditEvent[] }>('api/v1/audit/timeline', { subject_id: instanceId, limit: String(limit) }, tenantId),
    getJson<{ items: AuditEvent[] }>('api/v1/audit/timeline', { trace_id: instanceId, limit: String(limit) }, tenantId),
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

export async function fetchEventsForTrace(traceId: string, limit = 200, tenantId?: string): Promise<AuditEvent[]> {
  const body = await getJson<{ items: AuditEvent[] }>('api/v1/audit/timeline', {
    trace_id: traceId,
    limit: String(limit),
  }, tenantId)
  return body?.items ?? []
}

// Copilot governed activity for a whole workflow run lives under per-node-per-run trace ids
// `wf-<instanceId>-<nodeId>-<run8>` (AgentTaskExecutor). The exact-trace timeline can't span
// them, so use the search endpoint's traceIdPrefix to gather the run's activity in one call.
export async function searchByTracePrefix(prefix: string, limit = 300, tenantId?: string): Promise<AuditEvent[]> {
  // P1 — pass tenantId so strict-tenant callers get a tenant-scoped audit search, not just the
  // (already instance-unique) trace prefix. audit-gov filters on tenant_id when provided.
  const body = await postJson<{ items: AuditEvent[] }>('api/v1/audit/search', { traceIdPrefix: prefix, limit, ...(tenantId ? { tenantId } : {}) })
  const items = body?.items ?? []
  // search returns newest-first; activity panels render oldest-first.
  return [...items].sort((a, b) => a.created_at.localeCompare(b.created_at))
}

// M74 Phase 2B — closed-loop eval feedback. Fetches the most recent
// FAILED eval-run for a workflow/session so the next-attempt prompt can
// see "previous attempt scored 2/5 because <reason>". Fail-soft per the
// rest of this client — a missing/erroring audit-gov returns null rather
// than blocking the stage launch.
//
// Shape matches audit-gov's getLatestEvalFeedbackForSession response.

export interface EvalFeedbackResult {
  evaluator_id: string
  evaluator_kind: string
  score: number | null
  reason: string
  evidence: Record<string, unknown>
}

export interface EvalFeedback {
  eval_run_id: string
  status: string
  pass_rate: number
  created_at: string
  metadata: Record<string, unknown>
  failing_results: EvalFeedbackResult[]
}

export async function fetchEvalFeedback(args: {
  workflowInstanceId?: string
  blueprintSessionId?: string
  stageKey?: string
  failedOnly?: boolean
  tenantId?: string
}): Promise<EvalFeedback | null> {
  if (!args.workflowInstanceId && !args.blueprintSessionId) {
    return null
  }
  const params: Record<string, string | undefined> = {
    workflowInstanceId: args.workflowInstanceId,
    blueprintSessionId: args.blueprintSessionId,
    stageKey: args.stageKey,
    failedOnly: args.failedOnly === false ? 'false' : undefined,
  }
  const body = await getJson<{ feedback: EvalFeedback | null }>(
    'api/v1/engine/eval-feedback',
    params,
    args.tenantId,
  )
  return body?.feedback ?? null
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
