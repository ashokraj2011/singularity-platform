/**
 * /api/lookup/* — federated reference-data lookups (M10).
 *
 * Every endpoint forwards the caller's `Authorization` header to the upstream
 * source-of-truth service (IAM or one of the agent-and-tools services). No
 * caching, no DB writes — pure proxy. Pickers in the SPA call these so users
 * see real names instead of typed UUIDs.
 *
 * Response shape is always `{ items, total, page, size }` so the SPA's
 * combobox component can consume them uniformly.
 */

import { Router, type Request } from 'express'
import { z } from 'zod'
import { proxyGet as iamProxyGet, IamUnauthorizedError, IamUnavailableError } from '../../lib/iam/client'
import {
  listTools,
  discoverTools,
  listAgentTemplates,
  listRuntimeCapabilities,
  listPromptProfiles,
  AgentAndToolsError,
  type ToolDescriptor,
  type AgentTemplate,
  type PromptProfile,
  type RuntimeCapability,
} from '../../lib/agent-and-tools/client'
import { resolveOne, SINGLE_KINDS } from './resolver'

export const lookupRouter: Router = Router()

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract the raw bearer token (without the `Bearer ` prefix). Both the IAM
 * client (`iamFetch`) and the agent-and-tools client expect the token alone
 * and re-add the `Bearer ` themselves.
 */
function authToken(req: Request): string | undefined {
  const h = req.headers.authorization
  if (typeof h !== 'string') return undefined
  return h.startsWith('Bearer ') ? h.slice(7) : h
}

/**
 * Build the `Authorization: Bearer <jwt>` header value for the
 * agent-and-tools client (which forwards as-is, no prefix re-add).
 */
function authHeader(req: Request): string | undefined {
  const t = authToken(req)
  return t ? `Bearer ${t}` : undefined
}

function pageFromQuery(req: Request): { page: number; size: number } {
  const page = Math.max(1, Number(req.query.page ?? 1))
  const size = Math.min(200, Math.max(1, Number(req.query.size ?? 50)))
  return { page, size }
}

function paginate<T>(items: T[], page: number, size: number) {
  const total = items.length
  const start = (page - 1) * size
  return { items: items.slice(start, start + size), total, page, size }
}

function unwrapIamPage(body: unknown, page: number, size: number) {
  // IAM returns { items, page, size, total } already.
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>
    if (Array.isArray(b.items)) {
      return {
        items: b.items,
        total: Number(b.total ?? b.items.length),
        page:  Number(b.page ?? page),
        size:  Number(b.size ?? size),
      }
    }
    if (Array.isArray(b)) return paginate(b as unknown[], page, size)
  }
  if (Array.isArray(body)) return paginate(body, page, size)
  return { items: [], total: 0, page, size }
}

function handleError(err: unknown, res: import('express').Response) {
  if (err instanceof IamUnauthorizedError) {
    return res.status(401).json({ code: 'UPSTREAM_UNAUTHORIZED', message: err.message })
  }
  if (err instanceof IamUnavailableError) {
    return res.status(502).json({ code: 'UPSTREAM_UNAVAILABLE', message: err.message })
  }
  if (err instanceof AgentAndToolsError) {
    return res.status(err.status >= 400 && err.status < 600 ? err.status : 502).json({
      code: 'UPSTREAM_ERROR',
      message: err.message,
      detail: err.detail ?? null,
    })
  }
  return res.status(500).json({ code: 'INTERNAL', message: (err as Error).message })
}

function caseFold(s: unknown): string {
  return typeof s === 'string' ? s.toLowerCase() : ''
}

function clientFilter<T>(items: T[], q: string | undefined, fields: (item: T) => Array<unknown>) {
  if (!q) return items
  const needle = q.toLowerCase()
  return items.filter((it) => fields(it).some((f) => caseFold(f).includes(needle)))
}

function normalizeRuntimeCapability(cap: RuntimeCapability): Record<string, unknown> {
  const repositories = Array.isArray(cap.repositories)
    ? cap.repositories.filter((repo): repo is Record<string, unknown> => Boolean(repo && typeof repo === 'object' && !Array.isArray(repo)))
    : []
  const primaryRepo = repositories.find(repo => String(repo.status ?? '').toUpperCase() === 'ACTIVE')
    ?? repositories[0]
  const repoUrl = typeof primaryRepo?.repoUrl === 'string' ? primaryRepo.repoUrl
    : typeof primaryRepo?.url === 'string' ? primaryRepo.url
    : undefined
  const repositoryType = typeof primaryRepo?.repositoryType === 'string' ? primaryRepo.repositoryType
    : typeof primaryRepo?.type === 'string' ? primaryRepo.type
    : undefined
  return {
    id:              cap.id,
    capability_id:   cap.id,
    name:            cap.name,
    capability_type: cap.capabilityType ?? cap.capability_type,
    status:          typeof cap.status === 'string' ? cap.status.toLowerCase() : cap.status,
    description:     cap.description,
    criticality:     cap.criticality,
    repositories,
    repoUrl,
    sourceUri:       repoUrl,
    sourceType:      repoUrl ? (repositoryType === 'LOCAL' || repoUrl.startsWith('local://') ? 'localdir' : 'github') : undefined,
    defaultBranch:   typeof primaryRepo?.defaultBranch === 'string' ? primaryRepo.defaultBranch : undefined,
    source:          'agent-runtime',
  }
}

// ── IAM-backed endpoints ─────────────────────────────────────────────────────

lookupRouter.get('/users', async (req, res) => {
  try {
    const { page, size } = pageFromQuery(req)
    const teamId = req.query.team_id as string | undefined
    const capabilityId = req.query.capability_id as string | undefined
    const q = req.query.q as string | undefined

    if (teamId) {
      // Team members → hydrate user records by id (limited to current page).
      const members = await iamProxyGet(`/teams/${encodeURIComponent(teamId)}/members`, {}, authToken(req)) as Array<Record<string, unknown>>
      const userIds = members.map((m) => String(m.user_id ?? m.userId)).filter(Boolean)
      const idsPage = userIds.slice((page - 1) * size, (page - 1) * size + size)
      const users = await Promise.all(idsPage.map(async (uid) => {
        try {
          return await iamProxyGet(`/users/${encodeURIComponent(uid)}`, {}, authToken(req)) as Record<string, unknown>
        } catch { return null }
      }))
      const items = users.filter(Boolean) as Array<Record<string, unknown>>
      const filtered = clientFilter(items, q, (u) => [u.email, u.display_name, u.displayName])
      return res.json({ items: filtered, total: userIds.length, page, size })
    }

    if (capabilityId) {
      const members = await iamProxyGet(`/capabilities/${encodeURIComponent(capabilityId)}/members`, {}, authToken(req)) as Array<Record<string, unknown>>
      const userIds = Array.from(new Set(members.map((m) => String(m.user_id ?? '')).filter(Boolean)))
      const idsPage = userIds.slice((page - 1) * size, (page - 1) * size + size)
      const users = await Promise.all(idsPage.map(async (uid) => {
        try {
          return await iamProxyGet(`/users/${encodeURIComponent(uid)}`, {}, authToken(req)) as Record<string, unknown>
        } catch { return null }
      }))
      const items = (users.filter(Boolean) as Array<Record<string, unknown>>)
      const filtered = clientFilter(items, q, (u) => [u.email, u.display_name, u.displayName])
      return res.json({ items: filtered, total: userIds.length, page, size })
    }

    const body = await iamProxyGet('/users', { page, size, q }, authToken(req))
    return res.json(unwrapIamPage(body, page, size))
  } catch (err) { handleError(err, res) }
})

lookupRouter.get('/teams', async (req, res) => {
  try {
    const { page, size } = pageFromQuery(req)
    const body = await iamProxyGet('/teams', {
      page, size,
      q: req.query.q as string | undefined,
      bu_id: req.query.bu_id as string | undefined,
    }, authToken(req))
    return res.json(unwrapIamPage(body, page, size))
  } catch (err) { handleError(err, res) }
})

lookupRouter.get('/business-units', async (req, res) => {
  try {
    const { page, size } = pageFromQuery(req)
    const body = await iamProxyGet('/business-units', { page, size }, authToken(req))
    return res.json(unwrapIamPage(body, page, size))
  } catch (err) { handleError(err, res) }
})

lookupRouter.get('/capabilities', async (req, res) => {
  try {
    const { page, size } = pageFromQuery(req)
    const body = await iamProxyGet('/capabilities', {
      page, size,
      q:      req.query.q as string | undefined,
      type:   req.query.type as string | undefined,
      status: req.query.status as string | undefined,
    }, authToken(req))
    const iamPage = unwrapIamPage(body, page, size)
    const itemsById = new Map<string, Record<string, unknown>>()
    for (const item of iamPage.items as Array<Record<string, unknown>>) {
      const id = String(item.id ?? item.capability_id ?? '')
      if (id) itemsById.set(id, { ...item, source: 'iam' })
    }

    try {
      const runtimeCaps = await listRuntimeCapabilities(authHeader(req))
      for (const cap of runtimeCaps) {
        const id = String(cap.id ?? '')
        if (!id) continue
        const normalized = normalizeRuntimeCapability(cap)
        const existing = itemsById.get(id)
        itemsById.set(id, existing ? { ...normalized, ...existing, source: `${existing.source ?? 'iam'}+agent-runtime` } : normalized)
      }
    } catch {
      // Keep IAM-backed lookup usable even if agent-runtime is unavailable.
    }

    let items = Array.from(itemsById.values())
    items = clientFilter(items, req.query.q as string | undefined, (c) => [c.name, c.description, c.capability_type, c.capabilityType, c.id, c.capability_id])
    return res.json(paginate(items, page, size))
  } catch (err) { handleError(err, res) }
})

lookupRouter.get('/me/memberships', async (req, res) => {
  try {
    const token = authToken(req)
    const userId = (req as Request & { user?: { userId?: string } }).user?.userId
    const candidates = [
      '/me/memberships',
      userId ? `/users/${encodeURIComponent(userId)}/memberships` : '',
      userId ? `/users/${encodeURIComponent(userId)}/teams` : '',
    ].filter(Boolean)

    for (const path of candidates) {
      const body = await iamProxyGet(path, {}, token)
      let arr: unknown[] | null = null
      if (Array.isArray(body)) {
        arr = body
      } else if (body && typeof body === 'object') {
        const obj = body as Record<string, unknown>
        if (Array.isArray(obj.items)) arr = obj.items
        else if (Array.isArray(obj.data)) arr = obj.data
      }
      if (arr && arr.length > 0) return res.json({ items: arr, total: arr.length, page: 1, size: arr.length })
    }

    if ((req as Request & { iamUser?: { is_super_admin?: boolean } }).iamUser?.is_super_admin) {
      const byCapability = new Map<string, Record<string, unknown>>()
      try {
        const body = await iamProxyGet('/capabilities', { size: 200 }, token)
        const iamPage = unwrapIamPage(body, 1, 200)
        for (const item of iamPage.items as Array<Record<string, unknown>>) {
          const id = String(item.id ?? item.capability_id ?? '')
          if (!id) continue
          byCapability.set(id, {
            capability_id: id,
            capability_name: String(item.name ?? id),
            team_id: '',
            team_name: 'All teams',
            role_key: 'capability_admin',
            role_name: 'Capability Admin',
            is_capability_owner: true,
          })
        }
      } catch {
        // Keep going: agent-runtime may still have capability references.
      }
      try {
        const runtimeCaps = await listRuntimeCapabilities(authHeader(req))
        for (const cap of runtimeCaps) {
          const id = String(cap.id ?? '')
          if (!id || byCapability.has(id)) continue
          byCapability.set(id, {
            capability_id: id,
            capability_name: String(cap.name ?? id),
            team_id: '',
            team_name: 'Agent Studio',
            role_key: 'capability_admin',
            role_name: 'Capability Admin',
            is_capability_owner: true,
          })
        }
      } catch {
        // The picker can still operate with IAM-only capabilities.
      }
      const items = Array.from(byCapability.values())
      if (items.length > 0) return res.json({ items, total: items.length, page: 1, size: items.length })
    }

    return res.json({ items: [], total: 0, page: 1, size: 0 })
  } catch (err) { handleError(err, res) }
})

lookupRouter.get('/capability-members', async (req, res) => {
  try {
    const capabilityId = req.query.capability_id as string | undefined
    if (!capabilityId) return res.status(400).json({ code: 'BAD_REQUEST', message: 'capability_id is required' })
    const body = await iamProxyGet(`/capabilities/${encodeURIComponent(capabilityId)}/members`, {}, authToken(req))
    const items = Array.isArray(body) ? body : []
    return res.json({ items, total: items.length, page: 1, size: items.length })
  } catch (err) { handleError(err, res) }
})

lookupRouter.get('/roles', async (req, res) => {
  try {
    const { page, size } = pageFromQuery(req)
    const body = await iamProxyGet('/roles', { page, size }, authToken(req))
    return res.json(unwrapIamPage(body, page, size))
  } catch (err) { handleError(err, res) }
})

lookupRouter.get('/skills', async (req, res) => {
  try {
    const { page, size } = pageFromQuery(req)
    // IAM may not have a /skills endpoint; try and gracefully fall back to empty.
    try {
      const body = await iamProxyGet('/skills', { page, size }, authToken(req))
      return res.json(unwrapIamPage(body, page, size))
    } catch (err) {
      if (err instanceof IamUnavailableError) {
        return res.json({ items: [], total: 0, page, size })
      }
      throw err
    }
  } catch (err) { handleError(err, res) }
})

lookupRouter.get('/mcp-servers', async (req, res) => {
  try {
    const capabilityId = req.query.capability_id as string | undefined
    if (!capabilityId) return res.status(400).json({ code: 'BAD_REQUEST', message: 'capability_id is required' })
    const body = await iamProxyGet(
      `/capabilities/${encodeURIComponent(capabilityId)}/mcp-servers`,
      { status: req.query.status as string | undefined },
      authToken(req),
    )
    const items = Array.isArray(body) ? body : []
    return res.json({ items, total: items.length, page: 1, size: items.length })
  } catch (err) { handleError(err, res) }
})

// ── agent-and-tools-backed endpoints ────────────────────────────────────────

lookupRouter.get('/agent-templates', async (req, res) => {
  try {
    const { page, size } = pageFromQuery(req)
    const capabilityId = req.query.capability_id as string | undefined
    const q = req.query.q as string | undefined
    let templates: AgentTemplate[] = await listAgentTemplates(authHeader(req))
    // A template with no capabilityId is "global" and visible everywhere; only
    // exclude templates explicitly bound to a different capability.
    if (capabilityId) templates = templates.filter((t) => {
      const cid = (t.capabilityId ?? '').toString().toLowerCase()
      return !cid || cid === capabilityId.toLowerCase()
    })
    templates = clientFilter(templates, q, (t) => [t.name, t.description, t.id])
    return res.json(paginate(templates, page, size))
  } catch (err) { handleError(err, res) }
})

lookupRouter.get('/tools', async (req, res) => {
  try {
    const { page, size } = pageFromQuery(req)
    const capabilityId = req.query.capability_id as string | undefined
    const riskMax = (req.query.risk_max as string | undefined) ?? 'high'
    const q = req.query.q as string | undefined

    let tools: ToolDescriptor[]
    if (capabilityId) {
      const out = await discoverTools({
        capability_id: capabilityId,
        agent_uid: 'lookup-proxy',
        query: q ?? '',
        risk_max: riskMax,
        limit: 100,
      }, authHeader(req))
      tools = out.tools ?? []
    } else {
      const out = await listTools({}, authHeader(req))
      tools = out.tools ?? []
      tools = clientFilter(tools, q, (t) => [t.tool_name, t.description, t.display_name])
    }
    return res.json(paginate(tools, page, size))
  } catch (err) { handleError(err, res) }
})

lookupRouter.get('/prompt-profiles', async (req, res) => {
  try {
    const { page, size } = pageFromQuery(req)
    const capabilityId = req.query.capability_id as string | undefined
    const q = req.query.q as string | undefined
    let profiles: PromptProfile[] = await listPromptProfiles(authHeader(req))
    if (capabilityId) profiles = profiles.filter((p) => {
      const cid = (p.capabilityId ?? '').toString().toLowerCase()
      return !cid || cid === capabilityId.toLowerCase()
    })
    profiles = clientFilter(profiles, q, (p) => [p.name, p.id])
    return res.json(paginate(profiles, page, size))
  } catch (err) { handleError(err, res) }
})

// ── M11.b — single-record lookup-by-id + batch resolve ─────────────────────
//
// resolveOne + SINGLE_KINDS now live in ./resolver.ts so the workflow design
// save path can call the same code (write-time validation).

const SEGMENT_TO_KIND: Record<string, typeof SINGLE_KINDS[number]> = {
  users:           'user',
  teams:           'team',
  'business-units':'business-unit',
  capabilities:    'capability',
  roles:           'role',
  'mcp-servers':   'mcp-server',
  'agent-templates': 'agent-template',
  tools:           'tool',
  'prompt-profiles': 'prompt-profile',
}

for (const [segment, kind] of Object.entries(SEGMENT_TO_KIND)) {
  lookupRouter.get(`/${segment}/:id`, async (req, res) => {
    const hit = await resolveOne(kind, req.params.id, req)
    if (!hit.exists) {
      const status = hit.error?.startsWith('upstream-unauthorized') ? 401
                   : hit.error?.startsWith('upstream-unavailable')  ? 502
                   : 404
      return res.status(status).json({ code: hit.error ?? 'NOT_FOUND', kind, id: req.params.id })
    }
    return res.json(hit)
  })
}

// POST /api/lookup/resolve — batch existence check + label hydration.
const resolveBodySchema = z.object({
  refs: z.array(z.object({
    kind: z.enum(SINGLE_KINDS),
    id:   z.string().min(1),
  })).min(1).max(100),
})

lookupRouter.post('/resolve', async (req, res) => {
  const parsed = resolveBodySchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ code: 'BAD_REQUEST', message: 'invalid payload', details: parsed.error.flatten() })
  }
  const results = await Promise.all(parsed.data.refs.map((r) => resolveOne(r.kind, r.id, req)))
  const allOk = results.every((r) => r.exists)
  return res.status(allOk ? 200 : 207).json({ all_ok: allOk, results })
})
