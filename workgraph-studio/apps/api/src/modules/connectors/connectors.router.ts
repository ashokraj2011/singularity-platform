import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../lib/prisma'
import { buildAdapter } from './connector.service'
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

// GET /api/connectors/git/branches?repoUrl=&owner=&repo=
// Best-effort branch list from the first configured GIT connector — powers the
// launch "Branch to clone" picker. NEVER throws: returns { branches: [] } with a
// reason when no GIT connector is configured or the repo can't be read, so the
// launch dialog cleanly falls back to free-text branch entry. Registered before
// the '/:id' routes; '/:id' only matches a single segment so there is no clash.
connectorsRouter.get('/git/branches', async (req, res) => {
  try {
    const connector = await prisma.connector.findFirst({
      where: { type: 'GIT', archivedAt: null },
      orderBy: { createdAt: 'desc' },
    })
    if (!connector) return res.json({ branches: [], reason: 'No GIT connector is configured.' })
    const adapter = buildAdapter(connector.type, connector.config as any, connector.credentials as any)
    const repoUrl = typeof req.query.repoUrl === 'string' ? req.query.repoUrl : undefined
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
      connector: { id: connector.id, name: connector.name, repo: repoLabel },
    })
  } catch (e) {
    res.json({ branches: [], reason: e instanceof Error ? e.message : String(e) })
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
