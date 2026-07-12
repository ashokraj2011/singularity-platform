/**
 * WorkGraph LLM routing — the backbone for the drag-drop "LLM connections by touch
 * point" admin canvas.
 *
 *   GET    /api/llm-routing/connections          available WorkGraph-owned connection aliases
 *   GET    /api/llm-routing/touch-points         the known surfaces a connection can serve
 *   GET    /api/llm-routing/rules                 all routing rows (for the canvas)
 *   POST   /api/llm-routing/rules                 upsert a rule (touchPoint, scope, alias)
 *   DELETE /api/llm-routing/rules/:id             remove a rule
 *   GET    /api/llm-routing/resolve?touchPoint&userId&capabilityId
 *                                                 → { modelAlias } (USER > CAPABILITY > DEFAULT)
 *
 * Connections are WorkGraph-owned config rows. They store provider, model, base URL,
 * and credentialEnv (the NAME of the server env var). They never store API key values.
 */
import { Router, type Request, type Router as ExpressRouter } from 'express'
import { z } from 'zod'
import { readFileSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { prisma } from '../../lib/prisma'
import { requireTenantFromRequest, resolveTenantFromRequest, tenantIsolationStrict } from '../../lib/tenant-isolation'
import { isAdminUser } from '../../lib/permissions/admin'
import { ForbiddenError } from '../../lib/errors'

export const llmRoutingRouter: ExpressRouter = Router()

function tenantFilter(req: Request): { tenantId?: string } {
  const tenantId = tenantIsolationStrict()
    ? requireTenantFromRequest(req, 'LLM routing operation')
    : resolveTenantFromRequest(req)
  return tenantId ? { tenantId } : {}
}

async function requireAdmin(req: Request): Promise<void> {
  if (!req.user?.userId || !(await isAdminUser(req.user.userId))) {
    throw new ForbiddenError('LLM routing configuration requires an administrator role.')
  }
}

// The surfaces that pick a model today (see the LLM routing map). Static list —
// adding a touch point is a code change because something has to consume it.
const TOUCH_POINTS = [
  { key: 'COPILOT_SDLC',   label: 'Copilot SDLC',         description: 'The Copilot coding-workflow stages (executor=copilot).' },
  { key: 'WORKBENCH',      label: 'Blueprint Workbench',  description: 'The staged agent loop.' },
  { key: 'CHAT',           label: 'Chat / Event Horizon', description: 'The assistant chat surface.' },
  { key: 'GOVERNED_AGENT', label: 'Governed Agent Tasks', description: 'Workflow AGENT_TASK nodes (governed loop).' },
  { key: 'AUDIT_JUDGE',    label: 'AI Audit Judge',       description: 'The governance audit judge.' },
] as const

type Connection = {
  alias: string
  label: string
  provider: string
  model: string
  baseUrl?: string | null
  credentialEnv?: string | null
  credentialPresent?: boolean
  credentialStatus?: 'not-required' | 'configured' | 'missing-env-name' | 'missing-env-value'
  costTier?: string
  default?: boolean
}

function credentialStatus(provider: string, credentialEnv?: string | null): Pick<Connection, 'credentialPresent' | 'credentialStatus'> {
  const normalized = provider.trim().toLowerCase()
  if (normalized === 'mock' || normalized === 'disabled') {
    return { credentialPresent: true, credentialStatus: 'not-required' }
  }
  if (!credentialEnv?.trim()) {
    return { credentialPresent: false, credentialStatus: 'missing-env-name' }
  }
  return process.env[credentialEnv]
    ? { credentialPresent: true, credentialStatus: 'configured' }
    : { credentialPresent: false, credentialStatus: 'missing-env-value' }
}

function serializeConnection(row: {
  id?: string
  alias: string
  name?: string
  label?: string
  provider: string
  model: string
  baseUrl?: string | null
  credentialEnv?: string | null
  costTier?: string
  default?: boolean
}) {
  return {
    id: row.id,
    alias: row.alias,
    label: row.name ?? row.label ?? row.alias,
    provider: row.provider,
    model: row.model,
    baseUrl: row.baseUrl ?? null,
    credentialEnv: row.credentialEnv ?? null,
    ...credentialStatus(row.provider, row.credentialEnv),
    costTier: row.costTier,
    default: row.default,
  }
}

function isCopilotProvider(provider: string): boolean {
  return ['copilot', 'github_copilot', 'github-copilot'].includes(provider.trim().toLowerCase())
}

// Best-effort read of the gateway model catalog. Falls back to a built-in list so
// the canvas always has something to drag even if the file isn't reachable.
function loadConnections(): Connection[] {
  const candidates = [
    process.env.LLM_MODEL_CATALOG_PATH,
    resolvePath(process.cwd(), '../../../.singularity/llm-models.json'),
    resolvePath(process.cwd(), '../../.singularity/llm-models.json'),
    resolvePath(process.cwd(), '.singularity/llm-models.json'),
  ].filter(Boolean) as string[]
  for (const p of candidates) {
    try {
      const raw = JSON.parse(readFileSync(p, 'utf8')) as Array<Record<string, unknown>>
      if (Array.isArray(raw) && raw.length) {
        return raw.map(m => ({
          alias: String(m.id ?? m.alias ?? ''),
          label: String(m.label ?? m.id ?? ''),
          provider: String(m.provider ?? ''),
          model: String(m.model ?? ''),
          baseUrl: typeof m.baseUrl === 'string' ? m.baseUrl : null,
          credentialEnv: typeof m.credentialEnv === 'string' ? m.credentialEnv : null,
          costTier: m.costTier ? String(m.costTier) : undefined,
          default: Boolean(m.default),
        })).filter(c => c.alias && c.provider !== 'mock' && !isCopilotProvider(c.provider) && !/mock|chaos/i.test(`${c.alias} ${c.label}`))
          .map(serializeConnection)
      }
    } catch { /* try next */ }
  }
  return [
    serializeConnection({ alias: 'claude-haiku-4-5',  label: 'Claude Haiku 4.5',  provider: 'anthropic', model: 'claude-haiku-4-5',  credentialEnv: 'ANTHROPIC_API_KEY', costTier: 'low', default: true }),
    serializeConnection({ alias: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', provider: 'anthropic', model: 'claude-sonnet-4-5', credentialEnv: 'ANTHROPIC_API_KEY', costTier: 'medium' }),
    serializeConnection({ alias: 'gpt-4o',            label: 'GPT-4o',            provider: 'openai',    model: 'gpt-4o',            credentialEnv: 'OPENAI_API_KEY', costTier: 'medium' }),
  ]
}

// Connections come from the DB (admin-added). If none have been added yet, fall
// back to the catalog so the palette isn't empty on first use. Only env var names
// and presence booleans are returned; never secret values.
llmRoutingRouter.get('/connections', async (req, res, next) => {
  try {
    const rows = await prisma.llmConnection.findMany({ where: { enabled: true, ...tenantFilter(req) }, orderBy: { name: 'asc' } })
    const visibleRows = rows.filter(row => !isCopilotProvider(row.provider))
    if (visibleRows.length > 0) {
      return res.json({
        source: 'db',
        items: visibleRows.map(serializeConnection),
      })
    }
    res.json({ source: 'catalog', items: loadConnections() })
  } catch (e) { next(e) }
})

const envNameSchema = z.string()
  .trim()
  .max(120)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'credentialEnv must be an environment variable name, not a secret value')

const connSchema = z.object({
  name: z.string().trim().min(1).max(120),
  provider: z.string().trim().min(1).max(60),
  model: z.string().trim().min(1).max(120),
  alias: z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9_.:-]+$/, 'alias may contain letters, numbers, underscore, dash, dot, or colon'),
  baseUrl: z.preprocess(v => typeof v === 'string' && v.trim() === '' ? undefined : v, z.string().trim().url().max(300).optional()),
  credentialEnv: z.preprocess(v => typeof v === 'string' && v.trim() === '' ? undefined : v, envNameSchema.optional()),
  enabled: z.boolean().default(true),
})

llmRoutingRouter.post('/connections', async (req, res, next) => {
  try {
    await requireAdmin(req)
    const b = connSchema.parse(req.body)
    if (isCopilotProvider(b.provider)) {
      return res.status(400).json({ error: 'Copilot connections are disabled here. Use an AGENT_TASK with executor=copilot through the governed MCP runtime.' })
    }
    const createdById = (req as { user?: { userId?: string } }).user?.userId
    const scope = tenantFilter(req)
    const existing = await prisma.llmConnection.findFirst({ where: { alias: b.alias, ...scope } })
    const row = existing
      ? await prisma.llmConnection.update({
        where: { id: existing.id },
        data: { name: b.name, provider: b.provider, model: b.model, baseUrl: b.baseUrl, credentialEnv: b.credentialEnv, enabled: b.enabled },
      })
      : await prisma.llmConnection.create({ data: { ...b, createdById, ...scope } })
    res.status(201).json(serializeConnection(row))
  } catch (e) { next(e) }
})

llmRoutingRouter.delete('/connections/:id', async (req, res, next) => {
  try {
    await requireAdmin(req)
    const existing = await prisma.llmConnection.findFirst({ where: { id: req.params.id, ...tenantFilter(req) } })
    if (!existing) return res.status(404).json({ error: 'LLM connection not found' })
    await prisma.llmConnection.delete({ where: { id: existing.id } })
    res.status(204).end()
  }
  catch (e) { next(e) }
})

llmRoutingRouter.get('/touch-points', (_req, res) => { res.json({ items: TOUCH_POINTS }) })

llmRoutingRouter.get('/rules', async (req, res, next) => {
  try { res.json({ items: await prisma.llmRouting.findMany({ where: tenantFilter(req), orderBy: [{ touchPoint: 'asc' }, { scopeType: 'asc' }] }) }) }
  catch (e) { next(e) }
})

const ruleSchema = z.object({
  touchPoint: z.string().min(1).max(64),
  scopeType: z.enum(['DEFAULT', 'USER', 'CAPABILITY']).default('DEFAULT'),
  scopeId: z.string().max(200).default(''),
  modelAlias: z.string().min(1).max(200),
  enabled: z.boolean().default(true),
  positionX: z.number().optional(),
  positionY: z.number().optional(),
})

llmRoutingRouter.post('/rules', async (req, res, next) => {
  try {
    await requireAdmin(req)
    const b = ruleSchema.parse(req.body)
    if (b.modelAlias.trim().toLowerCase() === 'copilot') {
      return res.status(400).json({ error: 'The Copilot model alias is retired. Use the Copilot SDLC touch point with executor=copilot.' })
    }
    const scopeId = b.scopeType === 'DEFAULT' ? '' : b.scopeId
    if (b.scopeType !== 'DEFAULT' && !scopeId) {
      return res.status(400).json({ error: `${b.scopeType} rule requires a scopeId (the user or capability id)` })
    }
    const createdById = (req as { user?: { userId?: string } }).user?.userId
    const scope = tenantFilter(req)
    const existing = await prisma.llmRouting.findFirst({ where: { touchPoint: b.touchPoint, scopeType: b.scopeType, scopeId, ...scope } })
    const row = existing
      ? await prisma.llmRouting.update({
        where: { id: existing.id },
        data: { modelAlias: b.modelAlias, enabled: b.enabled, positionX: b.positionX, positionY: b.positionY },
      })
      : await prisma.llmRouting.create({ data: { ...b, scopeId, createdById, ...scope } })
    res.status(201).json(row)
  } catch (e) { next(e) }
})

llmRoutingRouter.delete('/rules/:id', async (req, res, next) => {
  try {
    await requireAdmin(req)
    const existing = await prisma.llmRouting.findFirst({ where: { id: req.params.id, ...tenantFilter(req) } })
    if (!existing) return res.status(404).json({ error: 'LLM routing rule not found' })
    await prisma.llmRouting.delete({ where: { id: existing.id } })
    res.status(204).end()
  }
  catch (e) { next(e) }
})

// Resolve precedence: USER > CAPABILITY > DEFAULT. Returns null modelAlias when no
// rule matches so the caller falls back to its own default.
llmRoutingRouter.get('/resolve', async (req, res, next) => {
  try {
    const touchPoint = String(req.query.touchPoint ?? '')
    const userId = req.query.userId ? String(req.query.userId) : ''
    const capabilityId = req.query.capabilityId ? String(req.query.capabilityId) : ''
    if (!touchPoint) return res.status(400).json({ error: 'touchPoint is required' })
    const rules = await prisma.llmRouting.findMany({ where: { touchPoint, enabled: true, ...tenantFilter(req) } })
    const pick = (scopeType: string, scopeId: string) => rules.find(r => r.scopeType === scopeType && r.scopeId === scopeId)
    const match =
      (userId && pick('USER', userId)) ||
      (capabilityId && pick('CAPABILITY', capabilityId)) ||
      pick('DEFAULT', '') ||
      null
    res.json({ touchPoint, modelAlias: match?.modelAlias ?? null, scopeType: match?.scopeType ?? null, ruleId: match?.id ?? null })
  } catch (e) { next(e) }
})
