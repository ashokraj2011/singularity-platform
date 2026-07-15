// ─────────────────────────────────────────────────────────────────────────────
// Online HTTP adapters — used when the VM runs connected to the central platform.
// Each adapter targets a service base URL with a bearer token. Any adapter whose
// baseUrl is unset reports online() === false, so a partially-connected VM
// degrades per-capability (e.g. LLM reachable but human-task service is not).
// ─────────────────────────────────────────────────────────────────────────────

import type {
  Adapters,
  IamAdapter,
  IamAuthzRequest,
  LlmAdapter,
  McpToolAdapter,
  GitAdapter,
  HumanTaskAdapter,
  HumanTaskRequest,
  AuditAdapter,
  AuditEvent,
  DiscoveryAdapter,
  DiscoveryElicitRequest,
  DiscoveryElicitResult,
  Clock,
} from '../types.js'
import { systemClock } from './offline.js'

export interface HttpEndpoint {
  baseUrl?: string
  token?: string
}

export interface HttpAdapterConfig {
  iam?: HttpEndpoint
  llm?: HttpEndpoint
  tool?: HttpEndpoint
  git?: HttpEndpoint
  human?: HttpEndpoint
  audit?: HttpEndpoint
  discovery?: HttpEndpoint
  timeoutMs?: number
  clock?: Clock
  fetchImpl?: typeof fetch
}

async function postJson(
  ep: HttpEndpoint,
  path: string,
  body: unknown,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (ep.token) headers.authorization = `Bearer ${ep.token}`
    const res = await fetchImpl(`${ep.baseUrl!.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`)
    const text = await res.text()
    return text ? JSON.parse(text) : {}
  } finally {
    clearTimeout(timer)
  }
}

export function httpAdapters(config: HttpAdapterConfig): Adapters {
  const timeoutMs = config.timeoutMs ?? 10_000
  const clock = config.clock ?? systemClock
  const fetchImpl = config.fetchImpl ?? fetch

  const iam: IamAdapter = {
    online: () => Boolean(config.iam?.baseUrl),
    authzCheck: async (req: IamAuthzRequest) => {
      const r = (await postJson(config.iam!, '/api/v1/authz/check', req, timeoutMs, fetchImpl)) as {
        allowed?: boolean
        reason?: string
      }
      return { allowed: r.allowed === true, reason: r.reason }
    },
  }

  const llm: LlmAdapter = {
    online: () => Boolean(config.llm?.baseUrl),
    complete: async input => {
      const r = (await postJson(config.llm!, '/api/v1/complete', input, timeoutMs, fetchImpl)) as {
        text?: string
      }
      return { text: r.text ?? '', raw: r }
    },
  }

  const tool: McpToolAdapter = {
    online: () => Boolean(config.tool?.baseUrl),
    invoke: async input => {
      const r = (await postJson(config.tool!, '/api/v1/tools/invoke', input, timeoutMs, fetchImpl)) as {
        result?: unknown
      }
      return { result: r.result }
    },
  }

  const git: GitAdapter = {
    online: () => Boolean(config.git?.baseUrl),
    push: async input => {
      const r = (await postJson(config.git!, '/api/v1/git/push', input, timeoutMs, fetchImpl)) as {
        ok?: boolean
        ref?: string
      }
      return { ok: r.ok === true, ref: r.ref }
    },
  }

  const human: HumanTaskAdapter = {
    online: () => Boolean(config.human?.baseUrl),
    requestDecision: async (req: HumanTaskRequest) => {
      const r = (await postJson(config.human!, '/api/v1/human-tasks/decision', req, timeoutMs, fetchImpl)) as {
        decision?: 'APPROVED' | 'REJECTED'
        by?: string
      }
      return { decision: r.decision === 'REJECTED' ? 'REJECTED' : 'APPROVED', by: r.by }
    },
  }

  const audit: AuditAdapter = {
    online: () => Boolean(config.audit?.baseUrl),
    emit: async (event: AuditEvent) => {
      await postJson(config.audit!, '/api/v1/events', event, timeoutMs, fetchImpl)
    },
  }

  const discovery: DiscoveryAdapter = {
    online: () => Boolean(config.discovery?.baseUrl),
    elicit: async (req: DiscoveryElicitRequest) => {
      const r = (await postJson(config.discovery!, '/api/v1/discovery/elicit', req, timeoutMs, fetchImpl)) as
        Partial<DiscoveryElicitResult>
      return {
        questions: Array.isArray(r.questions) ? r.questions : [],
        assumptions: Array.isArray(r.assumptions) ? r.assumptions : [],
      }
    },
  }

  return { iam, llm, tool, git, human, audit, discovery, clock }
}

/**
 * Compose an adapter set that prefers online HTTP adapters but falls back to a
 * provided offline adapter per-capability when the online one is not configured.
 */
export function mergeAdapters(primary: Adapters, fallback: Adapters): Adapters {
  return {
    iam: primary.iam.online() ? primary.iam : fallback.iam,
    llm: primary.llm.online() ? primary.llm : fallback.llm,
    tool: primary.tool.online() ? primary.tool : fallback.tool,
    git: primary.git.online() ? primary.git : fallback.git,
    human: primary.human.online() ? primary.human : fallback.human,
    audit: primary.audit.online() ? primary.audit : fallback.audit,
    discovery: primary.discovery.online() ? primary.discovery : fallback.discovery,
    clock: primary.clock,
  }
}
