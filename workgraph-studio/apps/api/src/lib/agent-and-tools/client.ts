/**
 * agent-and-tools HTTP client (M10).
 *
 * Thin wrapper over fetch that forwards the caller's bearer token to the
 * upstream service so federated lookups are scoped to what the user can see.
 * No caching — federate-live model means every call is fresh.
 */

import { config } from '../../config'
import { getIamServiceToken } from '../iam/service-token'
import { readUpstreamJsonBody, upstreamSnippet, type UpstreamJsonBody } from '../upstream-json'

export class AgentAndToolsError extends Error {
  constructor(
    message: string,
    public status: number,
    public detail?: unknown,
  ) {
    super(message)
    this.name = 'AgentAndToolsError'
  }
}

async function resolvedAgentToolsAuthHeader(authHeader?: string): Promise<string | undefined> {
  const callerHeader = authHeader?.trim()
  if (callerHeader) {
    return callerHeader.startsWith('Bearer ') ? callerHeader : `Bearer ${callerHeader}`
  }
  const token = await getIamServiceToken()
  return token ? `Bearer ${token}` : undefined
}

type AgentToolsBody = UpstreamJsonBody

async function readAgentToolsBody(res: Response): Promise<AgentToolsBody> {
  return readUpstreamJsonBody(res)
}

function agentToolsDetail(body: AgentToolsBody): unknown {
  if (body.parseError) return { body: upstreamSnippet(body.raw, 500), parseError: body.parseError }
  return body.data
}

function agentToolsInvalidJsonError(path: string, body: AgentToolsBody): AgentAndToolsError {
  return new AgentAndToolsError(
    `agent-and-tools returned invalid JSON on ${path}: ${body.parseError ?? 'invalid JSON'}${body.raw ? `: ${upstreamSnippet(body.raw, 500)}` : ''}`,
    502,
    agentToolsDetail(body),
  )
}

/**
 * Forward a GET request to one of the agent-and-tools services with the
 * caller's bearer token. Returns the parsed JSON body on 2xx, throws
 * AgentAndToolsError otherwise.
 */
async function proxyGet(
  baseUrl: string,
  path: string,
  query: Record<string, string | undefined>,
  authHeader: string | undefined,
): Promise<unknown> {
  const url = new URL(path, baseUrl.replace(/\/?$/, '/'))
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== '') url.searchParams.set(k, v)
  }
  const headers: Record<string, string> = { accept: 'application/json' }
  const authorization = await resolvedAgentToolsAuthHeader(authHeader)
  if (authorization) headers.authorization = authorization
  let res: Response
  try {
    res = await fetch(url, { method: 'GET', headers })
  } catch (err) {
    throw new AgentAndToolsError(
      `agent-and-tools fetch failed (${url}): ${(err as Error).message}`,
      502,
    )
  }
  const body = await readAgentToolsBody(res)
  if (!res.ok) {
    throw new AgentAndToolsError(
      `agent-and-tools ${res.status} on ${path}`,
      res.status,
      agentToolsDetail(body),
    )
  }
  if (body.parseError) throw agentToolsInvalidJsonError(path, body)
  return body.data
}

async function proxyPost(
  baseUrl: string,
  path: string,
  payload: unknown,
  authHeader: string | undefined,
): Promise<unknown> {
  const url = new URL(path, baseUrl.replace(/\/?$/, '/'))
  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/json',
  }
  const authorization = await resolvedAgentToolsAuthHeader(authHeader)
  if (authorization) headers.authorization = authorization
  let res: Response
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) })
  } catch (err) {
    throw new AgentAndToolsError(
      `agent-and-tools fetch failed (${url}): ${(err as Error).message}`,
      502,
    )
  }
  const body = await readAgentToolsBody(res)
  if (!res.ok) {
    throw new AgentAndToolsError(
      `agent-and-tools ${res.status} on ${path}`,
      res.status,
      agentToolsDetail(body),
    )
  }
  if (body.parseError) throw agentToolsInvalidJsonError(path, body)
  return body.data
}

// ── Tool service ───────────────────────────────────────────────────────────

export type ToolDescriptor = {
  tool_name: string
  version?: string
  description?: string
  display_name?: string
  input_schema?: Record<string, unknown>
  risk_level?: string
  requires_approval?: boolean
  execution_target?: string
  mcp_server_ref?: string | null
  execution_location?: string
  runtime_type?: string
  tags?: string[]
}

export async function listTools(
  query: { status?: string; risk_level?: string; capability_id?: string },
  authHeader?: string,
): Promise<{ tools: ToolDescriptor[] }> {
  const body = await proxyGet(
    config.TOOL_SERVICE_URL,
    'api/v1/tools',
    {
      status: query.status,
      risk_level: query.risk_level,
      capability_id: query.capability_id,
    },
    authHeader,
  )
  return body as { tools: ToolDescriptor[] }
}

export async function discoverTools(
  body: {
    capability_id: string
    agent_uid?: string
    agent_id?: string
    task_type?: string
    query?: string
    risk_max?: string
    limit?: number
    effective_capabilities?: Array<Record<string, unknown>>
    effectiveCapabilities?: Array<Record<string, unknown>>
  },
  authHeader?: string,
): Promise<{ tools: ToolDescriptor[] }> {
  const payload = {
    agent_uid: 'lookup-proxy',
    risk_max: 'high',
    limit: 50,
    ...body,
  }
  const out = await proxyPost(
    config.TOOL_SERVICE_URL,
    'api/v1/tools/discover',
    payload,
    authHeader,
  )
  return out as { tools: ToolDescriptor[] }
}

// ── Agent runtime (templates + skills + capabilities) ──────────────────────

export type AgentTemplate = {
  id: string
  name: string
  description?: string
  capabilityId?: string
  isActive?: boolean
  modelOverrides?: Record<string, unknown>
  [k: string]: unknown
}

export type RuntimeCapability = {
  id: string
  name: string
  description?: string | null
  capabilityType?: string
  status?: string
  criticality?: string
  [k: string]: unknown
}

export async function listRuntimeCapabilities(
  authHeader?: string,
): Promise<RuntimeCapability[]> {
  const body = await proxyGet(
    config.AGENT_RUNTIME_URL,
    'api/v1/capabilities',
    {},
    authHeader,
  )
  const root = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const data = (root.data ?? body) as unknown
  if (Array.isArray(data)) return data as RuntimeCapability[]
  if (data && typeof data === 'object' && Array.isArray((data as { items?: unknown }).items)) {
    return (data as { items: RuntimeCapability[] }).items
  }
  return []
}

// Fetch ONE capability by id (agent-runtime detail endpoint). Unlike the list, this
// is a direct by-id lookup — not subject to list scoping — so it finds a capability
// (and its ACTIVE repositories) even when the list wouldn't return it. Returns null
// on 404 / any error (callers fall back to the list scan).
export async function getRuntimeCapability(
  capabilityId: string,
  authHeader?: string,
): Promise<RuntimeCapability | null> {
  try {
    const body = await proxyGet(
      config.AGENT_RUNTIME_URL,
      `api/v1/capabilities/${encodeURIComponent(capabilityId)}`,
      {},
      authHeader,
    )
    const root = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
    const data = (root.data ?? body) as unknown
    return data && typeof data === 'object' ? (data as RuntimeCapability) : null
  } catch {
    return null
  }
}

export type RuntimeCapabilityRepository = {
  id?: string
  repoName?: string | null
  repoUrl?: string | null
  defaultBranch?: string | null
  repositoryType?: string | null
  status?: string | null
  [k: string]: unknown
}

// List a capability's linked repositories regardless of status (ACTIVE first).
// The agent-runtime GET /:id and the list both ACTIVE-filter repos server-side,
// so this endpoint is the only way to resolve the repo URL of a capability whose
// repo is still bootstrapping (status !== ACTIVE). Returns [] on any error.
export async function listRuntimeCapabilityRepositories(
  capabilityId: string,
  authHeader?: string,
): Promise<RuntimeCapabilityRepository[]> {
  try {
    const body = await proxyGet(
      config.AGENT_RUNTIME_URL,
      `api/v1/capabilities/${encodeURIComponent(capabilityId)}/repositories`,
      {},
      authHeader,
    )
    const root = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
    const data = (root.data ?? body) as Record<string, unknown>
    const repos = (data?.repositories ?? data) as unknown
    return Array.isArray(repos) ? (repos as RuntimeCapabilityRepository[]) : []
  } catch {
    return []
  }
}

export async function listAgentTemplates(
  authHeader?: string,
  query: { scope?: 'common' | 'capability' | 'all'; capabilityId?: string; limit?: number } = {},
): Promise<AgentTemplate[]> {
  const body = await proxyGet(
    config.AGENT_RUNTIME_URL,
    'api/v1/agents/templates',
    {
      scope: query.scope,
      capabilityId: query.capabilityId,
      // agent-runtime caps limit at 100 per call.
      limit: String(Math.min(query.limit ?? 100, 100)),
    },
    authHeader,
  )
  // agent-runtime wraps responses as { success, data: { items: [...] } }
  // or sometimes { success, data: [...] } — handle both.
  const root = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const data = (root.data ?? body) as unknown
  if (Array.isArray(data)) return data as AgentTemplate[]
  if (data && typeof data === 'object' && Array.isArray((data as { items?: unknown }).items)) {
    return (data as { items: AgentTemplate[] }).items
  }
  return []
}

export async function getAgentTemplate(
  id: string,
  authHeader?: string,
): Promise<AgentTemplate | null> {
  try {
    const body = await proxyGet(
      config.AGENT_RUNTIME_URL,
      `api/v1/agents/templates/${encodeURIComponent(id)}`,
      {},
      authHeader,
    )
    const root = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
    return ((root.data as AgentTemplate | undefined) ?? (body as AgentTemplate | null)) ?? null
  } catch (err) {
    if (err instanceof AgentAndToolsError && err.status === 404) return null
    throw err
  }
}

// M23 — derive a capability-scoped template from a base
export async function deriveAgentTemplate(
  baseId: string,
  payload: { capabilityId: string; name?: string; description?: string; basePromptProfileId?: string },
  authHeader?: string,
): Promise<AgentTemplate> {
  const body = await proxyPost(
    config.AGENT_RUNTIME_URL,
    `api/v1/agents/templates/${encodeURIComponent(baseId)}/derive`,
    payload,
    authHeader,
  )
  const root = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  return (root.data ?? body) as AgentTemplate
}

// M23 — patch a (derived or unlocked) template
export async function patchAgentTemplate(
  id: string,
  payload: Record<string, unknown>,
  authHeader?: string,
): Promise<AgentTemplate> {
  const url = new URL(`api/v1/agents/templates/${encodeURIComponent(id)}`, config.AGENT_RUNTIME_URL.replace(/\/?$/, '/'))
  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/json',
  }
  const authorization = await resolvedAgentToolsAuthHeader(authHeader)
  if (authorization) headers.authorization = authorization
  let res: Response
  try {
    res = await fetch(url, { method: 'PATCH', headers, body: JSON.stringify(payload) })
  } catch (err) {
    throw new AgentAndToolsError(`agent-and-tools fetch failed (${url}): ${(err as Error).message}`, 502)
  }
  const bodyOut = await readAgentToolsBody(res)
  if (!res.ok) {
    throw new AgentAndToolsError(`agent-and-tools ${res.status} on PATCH /agents/templates/${id}`, res.status, agentToolsDetail(bodyOut))
  }
  if (bodyOut.parseError) throw agentToolsInvalidJsonError(`PATCH /agents/templates/${id}`, bodyOut)
  const root = (bodyOut.data && typeof bodyOut.data === 'object' ? bodyOut.data : {}) as Record<string, unknown>
  return (root.data ?? bodyOut.data) as AgentTemplate
}

/**
 * Look up a single tool by name (the canonical id used everywhere). Returns
 * null on 404. Tool-service has no `/tools/:name` GET (it's keyed by
 * `:name/versions/:version`) — list and find is good enough for the
 * single-record use case while the registry is small.
 */
export async function getToolByName(
  name: string,
  authHeader?: string,
): Promise<ToolDescriptor | null> {
  const out = await listTools({ status: 'active' }, authHeader)
  const match = (out.tools ?? []).find((t) => (t.tool_name ?? '').toLowerCase() === name.toLowerCase())
  return match ?? null
}

// ── Prompt composer ────────────────────────────────────────────────────────

export type PromptProfile = {
  id: string
  name: string
  capabilityId?: string
  scope?: string
  version?: number
  [k: string]: unknown
}

export async function listPromptProfiles(
  authHeader?: string,
): Promise<PromptProfile[]> {
  const body = await proxyGet(
    config.PROMPT_COMPOSER_URL,
    'api/v1/prompt-profiles',
    {},
    authHeader,
  )
  const root = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const data = (root.data ?? body) as unknown
  if (Array.isArray(data)) return data as PromptProfile[]
  if (data && typeof data === 'object' && Array.isArray((data as { items?: unknown }).items)) {
    return (data as { items: PromptProfile[] }).items
  }
  return []
}
