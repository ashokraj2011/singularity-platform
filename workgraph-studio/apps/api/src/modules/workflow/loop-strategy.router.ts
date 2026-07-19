import { Router } from 'express'
import { z } from 'zod'
import { validate } from '../../middleware/validate'
import {
  createLoopStrategy,
  createLoopStrategyVersion,
  directLlmToolCatalog,
  getLoopStrategy,
  listLoopStrategies,
  publishLoopStrategy,
  updateLoopStrategy,
  validateLoopStrategyDefinition,
} from './loop-strategy.service'
import { resolveTenantFromRequest } from '../../lib/tenant-isolation'
import { assertPlatformWorkflowPermission } from '../../lib/permissions/workflowTemplate'

export const loopStrategyRouter: Router = Router()
const definitionSchema = z.record(z.unknown())

loopStrategyRouter.get('/tools', (_req, res) => res.json({ items: directLlmToolCatalog() }))

loopStrategyRouter.post('/validate', validate(z.object({ definition: definitionSchema })), async (req, res) => {
  const result = validateLoopStrategyDefinition(req.body.definition)
  res.status(result.ok ? 200 : 422).json(result)
})

loopStrategyRouter.get('/', async (req, res, next) => {
  try { res.json({ items: await listLoopStrategies(typeof req.query.kind === 'string' ? req.query.kind : undefined) }) } catch (err) { next(err) }
})

loopStrategyRouter.post('/', validate(z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).optional(),
  kind: z.string().trim().optional(),
  definition: definitionSchema,
  publish: z.boolean().optional(),
})), async (req, res, next) => {
  try {
    const tenantId = resolveTenantFromRequest(req)
    await assertPlatformWorkflowPermission(req.user!.userId, 'create', 'LoopStrategy', undefined, tenantId)
    const result = await createLoopStrategy({ ...req.body, actorId: req.user!.userId })
    res.status(201).json(result)
  } catch (err) { next(err) }
})

loopStrategyRouter.get('/:id', async (req, res, next) => {
  try { res.json(await getLoopStrategy(req.params.id)) } catch (err) { next(err) }
})

loopStrategyRouter.patch('/:id', validate(z.object({ name: z.string().trim().min(1).max(120).optional(), description: z.string().trim().max(2000).optional() })), async (req, res, next) => {
  try {
    const tenantId = resolveTenantFromRequest(req)
    await assertPlatformWorkflowPermission(req.user!.userId, 'edit', 'LoopStrategy', req.params.id, tenantId)
    res.json(await updateLoopStrategy(req.params.id, { ...req.body, actorId: req.user!.userId }))
  } catch (err) { next(err) }
})

loopStrategyRouter.post('/:id/versions', validate(z.object({ definition: definitionSchema, publish: z.boolean().optional() })), async (req, res, next) => {
  try {
    const tenantId = resolveTenantFromRequest(req)
    await assertPlatformWorkflowPermission(req.user!.userId, req.body.publish ? 'publish' : 'edit', 'LoopStrategy', req.params.id, tenantId)
    res.status(201).json(await createLoopStrategyVersion(req.params.id, { ...req.body, actorId: req.user!.userId }))
  } catch (err) { next(err) }
})

loopStrategyRouter.post('/:id/publish', validate(z.object({ version: z.number().int().positive().optional() })), async (req, res, next) => {
  try {
    const tenantId = resolveTenantFromRequest(req)
    await assertPlatformWorkflowPermission(req.user!.userId, 'publish', 'LoopStrategy', req.params.id, tenantId)
    res.json(await publishLoopStrategy(req.params.id, req.body.version, req.user!.userId))
  } catch (err) { next(err) }
})
