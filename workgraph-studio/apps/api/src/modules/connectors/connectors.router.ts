import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../lib/prisma'
import { config } from '../../config'
import { buildAdapter } from './connector.service'
import { resolveCapabilityRepo } from '../../lib/agent-and-tools/capability-repo'
import type { ConnectorType } from '@prisma/client'

export const connectorsRouter: ReturnType<typeof Router> = Router()

const CONNECTOR_TYPES: ConnectorType[] = [
  'HTTP', 'EMAIL', 'TEAMS', 'SLACK', 'JIRA', 'GIT',
  'CONFLUENCE', 'DATADOG', 'SERVICENOW', 'LLM_GATEWAY', 'S3', 'POSTGRES', 'SHAREPOINT',
]

const createSchema = z.object({
  type: z.enum(CONNECTOR_TYPES as [ConnectorType, ...ConnectorType[]]),
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  config: z.record(z.unknown()).default({}),
  credentials: z.record(z.unknown()).default({}),
})

const updateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).optional(),
  config: z.record(z.unknown()).optional(),
  credentials: z.record(z.unknown()).optional(),
})

// ── Omit credentials from all responses ────────────────────────────────────
function safe(c: Record<string, unknown>) {
  const { credentials: _omit, ...rest } = c as any
  return rest
}

// Parse owner/repo from a github/gitlab URL (best-effort).
function parseOwnerRepo(url: string): { owner?: string; repo?: string } {
  const m = url.match(/[/:]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/)
  return m ? { owner: m[1], repo: m[2] } : {}
}

// The connected laptop runtime lists the repo's branches with its OWN github token
// (over the CF source-tree bridge frame, listBranches flag). This is the preferred
// path: no duplicate GIT connector credential is needed — the token already lives on
// the runtime. Runtimes are keyed in CF by the IAM user id, so we resolve the current
// session user's iamUserId and pass it as user_id (personal-laptop match). Returns
// { branches } on success (empty list is still authoritative), or { reason } so the
// caller can fall back to the connector path and surface why the runtime path didn't
// apply.
async function listBranchesViaRuntime(
  req: { user?: { id?: string } },
  repoUrl: string,
): Promise<{ branches?: string[]; reason?: string }> {
  const cfUrl = config.CONTEXT_FABRIC_URL?.replace(/\/$/, '')
  if (!cfUrl) return { reason: 'Context Fabric not configured (CONTEXT_FABRIC_URL unset).' }
  const localId = req.user?.id
  if (!localId) return { reason: 'No authenticated session user for the runtime match.' }
  const u = await prisma.user
    .findUnique({ where: { id: localId }, select: { iamUserId: true } })
    .catch(() => null)
  if (!u?.iamUserId) return { reason: 'Session user has no linked IAM id (runtime match needs it).' }
  try {
    const resp = await fetch(`${cfUrl}/api/runtime-bridge/source/branches`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Service-Token': config.CONTEXT_FABRIC_SERVICE_TOKEN ?? '' },
      body: JSON.stringify({ user_id: u.iamUserId, repoUrl }),
    })
    if (!resp.ok) {
      // 503 = no laptop runtime advertising the source frame is connected → fall back
      // to the connector path. Other statuses (timeout/relay error) also fall back.
      const text = await resp.text().catch(() => '')
      return { reason: `runtime branch list unavailable (HTTP ${resp.status})${text ? `: ${text.slice(0, 160)}` : ''}` }
    }
    const body = (await resp.json().catch(() => ({}))) as { branches?: unknown }
    return { branches: Array.isArray(body.branches) ? (body.branches as string[]) : [] }
  } catch (e) {
    return { reason: `Context Fabric unreachable: ${e instanceof Error ? e.message : String(e)}` }
  }
}

// GET /api/connectors/git/branches?repoUrl=&owner=&repo=
// Powers the launch "Branch to clone" picker. Two paths, in order:
//   1) the connected laptop runtime lists branches with its own github token (no
//      connector needed — the token already lives on the runtime), and
//   2) fallback to the first configured GIT connector.
// NEVER throws: returns { branches: [] } with a reason when neither path applies,
// so the launch dialog cleanly falls back to free-text branch entry. Registered
// before the '/:id' routes; '/:id' only matches a single segment so there's no clash.
connectorsRouter.get('/git/branches', async (req, res) => {
  // repoUrl is the run's target repo. The launch dialog usually can't name it, so it
  // passes the workflow's capabilityId instead and we resolve the capability's linked
  // repo — the SAME repo the run will clone (matches the executor's fallback chain).
  const explicitRepoUrl = typeof req.query.repoUrl === 'string' && req.query.repoUrl.trim()
    ? req.query.repoUrl.trim()
    : undefined
  let capabilityId = typeof req.query.capabilityId === 'string' && req.query.capabilityId.trim()
    ? req.query.capabilityId.trim()
    : undefined
  // instanceId (run-aware) — resolve the repo the SAME way the executor does, from the
  // run's own context: an explicit repoUrl var → the capability's linked repo. This is
  // the reliable path for the mid-run Create-branch form (the client can't always name
  // the right capabilityId var).
  const instanceId = typeof req.query.instanceId === 'string' && req.query.instanceId.trim()
    ? req.query.instanceId.trim()
    : undefined
  let contextRepo: string | undefined
  if (instanceId) {
    const inst = await prisma.workflowInstance.findUnique({
      where: { id: instanceId },
      select: { context: true, template: { select: { capabilityId: true } } },
    }).catch(() => null)
    const ctx = (inst?.context ?? {}) as Record<string, unknown>
    const vars = (ctx._vars && typeof ctx._vars === 'object' ? ctx._vars : {}) as Record<string, unknown>
    const globals = (ctx._globals && typeof ctx._globals === 'object' ? ctx._globals : {}) as Record<string, unknown>
    const pick = (...vals: unknown[]) => vals.find((x): x is string => typeof x === 'string' && x.trim().length > 0)?.trim()
    contextRepo = pick(vars.repoUrl, vars.sourceUri, globals.repoUrl, globals.sourceUri)
    // Capability from the run's vars, else the workflow template's owning capability.
    capabilityId = capabilityId
      ?? pick(vars.parentCapabilityId, vars.targetCapabilityId, vars.capabilityId)
      ?? (typeof inst?.template?.capabilityId === 'string' ? inst.template.capabilityId : undefined)
  }
  const repoUrl = explicitRepoUrl
    ?? contextRepo
    ?? (capabilityId ? await resolveCapabilityRepo(capabilityId).catch(() => undefined) : undefined)
  // 1) Preferred: the connected runtime (its own token, over the CF bridge). An empty
  //    list from a successful call is authoritative; only a reason (not connected /
  //    unreachable) falls through to the connector path.
  let runtimeReason: string | undefined
  if (repoUrl) {
    const rt = await listBranchesViaRuntime(req as { user?: { id?: string } }, repoUrl)
    if (rt.branches) return res.json({ branches: rt.branches, source: 'runtime', repo: repoUrl })
    runtimeReason = rt.reason
  } else {
    runtimeReason = capabilityId
      ? `capability ${capabilityId} has no ACTIVE linked repository in agent-runtime (or the capability isn't found there)`
      : 'no repo resolved — the run has no repoUrl var and no capability with a linked repo'
  }
  // 2) Fallback: first configured GIT connector.
  try {
    const connector = await prisma.connector.findFirst({
      where: { type: 'GIT', archivedAt: null },
      orderBy: { createdAt: 'desc' },
    })
    if (!connector) {
      return res.json({
        branches: [],
        // Surface the capability's repo even when we can't list its branches, so the
        // UI can still show which repo the run targets.
        ...(repoUrl ? { repo: repoUrl } : {}),
        reason: runtimeReason
          ? `No connected runtime (${runtimeReason}) and no GIT connector is configured.`
          : 'No GIT connector is configured.',
      })
    }
    const adapter = buildAdapter(connector.type, connector.config as any, connector.credentials as any)
    const parsed = repoUrl ? parseOwnerRepo(repoUrl) : {}
    const owner = (typeof req.query.owner === 'string' && req.query.owner) || parsed.owner
    const repo = (typeof req.query.repo === 'string' && req.query.repo) || parsed.repo
    const params: Record<string, unknown> = {}
    if (owner) params.owner = owner
    if (repo) params.repo = repo
    const result = await adapter.invoke('listBranches', params) as { branches?: string[] }
    const cfg = (connector.config ?? {}) as { defaultOwner?: string; defaultRepo?: string }
    const repoLabel = owner && repo ? `${owner}/${repo}` : [cfg.defaultOwner, cfg.defaultRepo].filter(Boolean).join('/') || undefined
    res.json({
      branches: Array.isArray(result?.branches) ? result.branches : [],
      source: 'connector',
      // Prefer the capability's actual repo URL when known; else the connector label.
      ...(repoUrl ? { repo: repoUrl } : {}),
      connector: { id: connector.id, name: connector.name, repo: repoLabel },
      ...(runtimeReason ? { runtimeReason } : {}),
    })
  } catch (e) {
    const connErr = e instanceof Error ? e.message : String(e)
    res.json({ branches: [], ...(repoUrl ? { repo: repoUrl } : {}), reason: [runtimeReason, connErr].filter(Boolean).join('; ') })
  }
})

// GET /api/connectors
connectorsRouter.get('/', async (req, res) => {
  const connectors = await prisma.connector.findMany({
    where: { archivedAt: null },
    orderBy: { createdAt: 'desc' },
  })
  res.json(connectors.map(c => safe(c as any)))
})

// GET /api/connectors/archived
connectorsRouter.get('/archived', async (_req, res) => {
  const connectors = await prisma.connector.findMany({
    where: { archivedAt: { not: null } },
    orderBy: { archivedAt: 'desc' },
  })
  res.json(connectors.map(c => safe(c as any)))
})

// GET /api/connectors/:id
connectorsRouter.get('/:id', async (req, res) => {
  const c = await prisma.connector.findUniqueOrThrow({ where: { id: req.params.id } })
  res.json(safe(c as any))
})

// GET /api/connectors/:id/operations — list available operations + param schemas
connectorsRouter.get('/:id/operations', async (req, res) => {
  const c = await prisma.connector.findUniqueOrThrow({ where: { id: req.params.id } })
  const adapter = buildAdapter(c.type, c.config as any, c.credentials as any)
  res.json(adapter.listOperations())
})

// POST /api/connectors
connectorsRouter.post('/', async (req, res) => {
  const body = createSchema.parse(req.body)
  const c = await prisma.connector.create({
    data: {
      type: body.type,
      name: body.name,
      description: body.description,
      config: body.config as any,
      credentials: body.credentials as any,
      createdById: (req as any).user?.id,
    },
  })
  res.status(201).json(safe(c as any))
})

// PATCH /api/connectors/:id
connectorsRouter.patch('/:id', async (req, res) => {
  const body = updateSchema.parse(req.body)
  const existing = await prisma.connector.findUniqueOrThrow({ where: { id: req.params.id } })

  const mergedConfig = body.config ? { ...(existing.config as object), ...body.config } : undefined
  const mergedCreds = body.credentials ? { ...(existing.credentials as object), ...body.credentials } : undefined

  const c = await prisma.connector.update({
    where: { id: req.params.id },
    data: {
      ...(body.name ? { name: body.name } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(mergedConfig ? { config: mergedConfig as any } : {}),
      ...(mergedCreds ? { credentials: mergedCreds as any } : {}),
    },
  })
  res.json(safe(c as any))
})

// POST /api/connectors/:id/test
connectorsRouter.post('/:id/test', async (req, res) => {
  const c = await prisma.connector.findUniqueOrThrow({ where: { id: req.params.id } })
  const adapter = buildAdapter(c.type, c.config as any, c.credentials as any)
  const result = await adapter.testConnection()
  res.json(result)
})

// POST /api/connectors/:id/invoke
connectorsRouter.post('/:id/invoke', async (req, res) => {
  const { operation, params = {} } = req.body as { operation: string; params?: Record<string, unknown> }
  if (!operation) return res.status(400).json({ error: 'operation is required' })
  const c = await prisma.connector.findUniqueOrThrow({ where: { id: req.params.id } })
  const adapter = buildAdapter(c.type, c.config as any, c.credentials as any)
  const result = await adapter.invoke(operation, params)
  res.json({ result })
})

// POST /api/connectors/:id/archive
connectorsRouter.post('/:id/archive', async (req, res) => {
  const c = await prisma.connector.update({
    where: { id: req.params.id },
    data: { archivedAt: new Date() },
  })
  res.json(safe(c as any))
})

// POST /api/connectors/:id/restore
connectorsRouter.post('/:id/restore', async (req, res) => {
  const c = await prisma.connector.update({
    where: { id: req.params.id },
    data: { archivedAt: null },
  })
  res.json(safe(c as any))
})

// DELETE /api/connectors/:id
connectorsRouter.delete('/:id', async (req, res) => {
  await prisma.connector.delete({ where: { id: req.params.id } })
  res.status(204).end()
})
