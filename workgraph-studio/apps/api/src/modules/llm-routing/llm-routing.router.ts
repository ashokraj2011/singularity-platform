/**
 * LLM gateway routing — the backbone for the drag-drop "LLM connections by touch
 * point" admin canvas.
 *
 *   GET    /api/llm-routing/connections          available connections (catalog aliases)
 *   GET    /api/llm-routing/touch-points         the known surfaces a connection can serve
 *   GET    /api/llm-routing/rules                 all routing rows (for the canvas)
 *   POST   /api/llm-routing/rules                 upsert a rule (touchPoint, scope, alias)
 *   DELETE /api/llm-routing/rules/:id             remove a rule
 *   GET    /api/llm-routing/resolve?touchPoint&userId&capabilityId
 *                                                 → { modelAlias } (USER > CAPABILITY > DEFAULT)
 *
 * Connections come from the gateway model catalog (.singularity/llm-models.json) —
 * credentials never leave the gateway; the canvas only maps touch points → aliases.
 */
import { Router, type Router as ExpressRouter } from 'express'
import { z } from 'zod'
import { readFileSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { prisma } from '../../lib/prisma'

export const llmRoutingRouter: ExpressRouter = Router()

// The surfaces that pick a model today (see the LLM routing map). Static list —
// adding a touch point is a code change because something has to consume it.
const TOUCH_POINTS = [
  { key: 'COPILOT_SDLC',   label: 'Copilot SDLC',         description: 'The Copilot coding-workflow stages (executor=copilot).' },
  { key: 'WORKBENCH',      label: 'Blueprint Workbench',  description: 'The staged agent loop.' },
  { key: 'CHAT',           label: 'Chat / Event Horizon', description: 'The assistant chat surface.' },
  { key: 'GOVERNED_AGENT', label: 'Governed Agent Tasks', description: 'Workflow AGENT_TASK nodes (governed loop).' },
  { key: 'AUDIT_JUDGE',    label: 'AI Audit Judge',       description: 'The governance audit judge.' },
] as const

type Connection = { alias: string; label: string; provider: string; model: string; costTier?: string; default?: boolean }

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
          costTier: m.costTier ? String(m.costTier) : undefined,
          default: Boolean(m.default),
        })).filter(c => c.alias && c.provider !== 'mock' && !/mock|chaos/i.test(`${c.alias} ${c.label}`))
      }
    } catch { /* try next */ }
  }
  return [
    { alias: 'claude-haiku-4-5',  label: 'Claude Haiku 4.5',  provider: 'anthropic', model: 'claude-haiku-4-5',  costTier: 'low', default: true },
    { alias: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', provider: 'anthropic', model: 'claude-sonnet-4-5', costTier: 'medium' },
    { alias: 'gpt-4o',            label: 'GPT-4o',            provider: 'openai',    model: 'gpt-4o',            costTier: 'medium' },
    { alias: 'copilot',           label: 'Copilot CLI',       provider: 'copilot',   model: 'copilot',           costTier: 'na' },
  ]
}

// Connections come from the DB (admin-added). If none have been added yet, fall
// back to the gateway catalog so the palette isn't empty on first use.
llmRoutingRouter.get('/connections', async (_req, res, next) => {
  try {
    const rows = await prisma.llmConnection.findMany({ where: { enabled: true }, orderBy: { name: 'asc' } })
    if (rows.length > 0) {
      return res.json({
        source: 'db',
        items: rows.map(r => ({ id: r.id, alias: r.alias, label: r.name, provider: r.provider, model: r.model, baseUrl: r.baseUrl, credentialEnv: r.credentialEnv })),
      })
    }
    res.json({ source: 'catalog', items: loadConnections() })
  } catch (e) { next(e) }
})

const connSchema = z.object({
  name: z.string().min(1).max(120),
  provider: z.string().min(1).max(60),
  model: z.string().min(1).max(120),
  alias: z.string().min(1).max(120),
  baseUrl: z.string().max(300).optional(),
  credentialEnv: z.string().max(120).optional(),
  enabled: z.boolean().default(true),
})

llmRoutingRouter.post('/connections', async (req, res, next) => {
  try {
    const b = connSchema.parse(req.body)
    const createdById = (req as { user?: { userId?: string } }).user?.userId
    const row = await prisma.llmConnection.upsert({
      where: { alias: b.alias },
      create: { ...b, createdById },
      update: { name: b.name, provider: b.provider, model: b.model, baseUrl: b.baseUrl, credentialEnv: b.credentialEnv, enabled: b.enabled },
    })
    res.status(201).json(row)
  } catch (e) { next(e) }
})

llmRoutingRouter.delete('/connections/:id', async (req, res, next) => {
  try { await prisma.llmConnection.delete({ where: { id: req.params.id } }); res.status(204).end() }
  catch (e) { next(e) }
})

llmRoutingRouter.get('/touch-points', (_req, res) => { res.json({ items: TOUCH_POINTS }) })

llmRoutingRouter.get('/rules', async (_req, res, next) => {
  try { res.json({ items: await prisma.llmRouting.findMany({ orderBy: [{ touchPoint: 'asc' }, { scopeType: 'asc' }] }) }) }
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
    const b = ruleSchema.parse(req.body)
    const scopeId = b.scopeType === 'DEFAULT' ? '' : b.scopeId
    if (b.scopeType !== 'DEFAULT' && !scopeId) {
      return res.status(400).json({ error: `${b.scopeType} rule requires a scopeId (the user or capability id)` })
    }
    const createdById = (req as { user?: { userId?: string } }).user?.userId
    const row = await prisma.llmRouting.upsert({
      where: { touchPoint_scopeType_scopeId: { touchPoint: b.touchPoint, scopeType: b.scopeType, scopeId } },
      create: { ...b, scopeId, createdById },
      update: { modelAlias: b.modelAlias, enabled: b.enabled, positionX: b.positionX, positionY: b.positionY },
    })
    res.status(201).json(row)
  } catch (e) { next(e) }
})

llmRoutingRouter.delete('/rules/:id', async (req, res, next) => {
  try { await prisma.llmRouting.delete({ where: { id: req.params.id } }); res.status(204).end() }
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
    const rules = await prisma.llmRouting.findMany({ where: { touchPoint, enabled: true } })
    const pick = (scopeType: string, scopeId: string) => rules.find(r => r.scopeType === scopeType && r.scopeId === scopeId)
    const match =
      (userId && pick('USER', userId)) ||
      (capabilityId && pick('CAPABILITY', capabilityId)) ||
      pick('DEFAULT', '') ||
      null
    res.json({ touchPoint, modelAlias: match?.modelAlias ?? null, scopeType: match?.scopeType ?? null, ruleId: match?.id ?? null })
  } catch (e) { next(e) }
})
