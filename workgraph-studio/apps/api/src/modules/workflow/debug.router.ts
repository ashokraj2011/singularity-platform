import { Router } from 'express'
import { z } from 'zod'
import { validate } from '../../middleware/validate'
import { assertWorkflowInstanceTenant, resolveTenantFromRequest } from '../../lib/tenant-isolation'
import { prisma } from '../../lib/prisma'
import { withTenantDbTransaction } from '../../lib/tenant-db-context'
import {
  cloneWorkflowRun,
  createTemplateMigration,
  createTimeTravelSnapshot,
  executeCompensation,
  previewTemplateMigration,
} from './debug.service'

export const workflowDebugRouter: Router = Router()

workflowDebugRouter.post('/instances/:id/clone', validate(z.object({
  checkpointId: z.string().uuid().optional(),
  reason: z.string().max(500).optional(),
  contextOverrides: z.record(z.unknown()).optional(),
})), async (req, res, next) => {
  try {
    await assertWorkflowInstanceTenant(req, req.params.id)
    res.status(201).json(await cloneWorkflowRun({
      instanceId: req.params.id,
      actorId: req.user!.userId,
      checkpointId: req.body.checkpointId,
      reason: req.body.reason,
      contextOverrides: req.body.contextOverrides,
    }))
  } catch (err) { next(err) }
})

workflowDebugRouter.get('/instances/:id/time-travel', async (req, res, next) => {
  try {
    await assertWorkflowInstanceTenant(req, req.params.id)
    res.json(await createTimeTravelSnapshot(req.params.id, req.user!.userId, typeof req.query.checkpointId === 'string' ? req.query.checkpointId : undefined, typeof req.query.nodeId === 'string' ? req.query.nodeId : undefined))
  } catch (err) { next(err) }
})

workflowDebugRouter.post('/instances/:id/time-travel', validate(z.object({ checkpointId: z.string().uuid().optional(), nodeId: z.string().uuid().optional() })), async (req, res, next) => {
  try {
    await assertWorkflowInstanceTenant(req, req.params.id)
    res.status(201).json(await createTimeTravelSnapshot(req.params.id, req.user!.userId, req.body.checkpointId, req.body.nodeId))
  } catch (err) { next(err) }
})

workflowDebugRouter.get('/instances/:id/compensations', async (req, res, next) => {
  try {
    await assertWorkflowInstanceTenant(req, req.params.id)
    const tenantId = resolveTenantFromRequest(req)
    res.json(await withTenantDbTransaction(prisma, tx => tx.workflowCompensationExecution.findMany({ where: { instanceId: req.params.id }, orderBy: { createdAt: 'desc' }, take: 100 }), tenantId))
  } catch (err) { next(err) }
})

workflowDebugRouter.post('/instances/:id/nodes/:nodeId/compensate', validate(z.object({ actionKey: z.string().max(120).optional() })), async (req, res, next) => {
  try {
    await assertWorkflowInstanceTenant(req, req.params.id)
    res.status(201).json(await executeCompensation({ instanceId: req.params.id, nodeId: req.params.nodeId, actorId: req.user!.userId, actionKey: req.body.actionKey }))
  } catch (err) { next(err) }
})

workflowDebugRouter.post('/templates/:id/migrations/preview', validate(z.object({
  fromVersion: z.coerce.number().int().positive(),
  toVersion: z.coerce.number().int().positive(),
  nodeMap: z.record(z.string().uuid()),
})), async (req, res, next) => {
  try {
    const tenantId = resolveTenantFromRequest(req)
    const template = await withTenantDbTransaction(prisma, tx => tx.workflow.findUnique({ where: { id: req.params.id }, select: { id: true } }), tenantId)
    if (!template) return res.status(404).json({ error: 'Workflow template not found' })
    res.json(await previewTemplateMigration({ templateId: req.params.id, fromVersion: req.body.fromVersion, toVersion: req.body.toVersion, nodeMap: req.body.nodeMap, actorId: req.user!.userId }))
  } catch (err) { next(err) }
})

workflowDebugRouter.post('/templates/:id/migrations', validate(z.object({
  fromVersion: z.coerce.number().int().positive(),
  toVersion: z.coerce.number().int().positive(),
  nodeMap: z.record(z.string().uuid()),
  applyToInFlight: z.boolean().optional().default(false),
})), async (req, res, next) => {
  try {
    const tenantId = resolveTenantFromRequest(req)
    const template = await withTenantDbTransaction(prisma, tx => tx.workflow.findUnique({ where: { id: req.params.id }, select: { id: true } }), tenantId)
    if (!template) return res.status(404).json({ error: 'Workflow template not found' })
    res.status(201).json(await createTemplateMigration({ templateId: req.params.id, fromVersion: req.body.fromVersion, toVersion: req.body.toVersion, nodeMap: req.body.nodeMap, actorId: req.user!.userId, applyToInFlight: req.body.applyToInFlight }))
  } catch (err) { next(err) }
})

workflowDebugRouter.get('/templates/:id/migrations', async (req, res, next) => {
  try {
    const tenantId = resolveTenantFromRequest(req)
    res.json(await withTenantDbTransaction(prisma, tx => tx.workflowTemplateMigration.findMany({ where: { templateId: req.params.id }, orderBy: { createdAt: 'desc' }, take: 100 }), tenantId))
  } catch (err) { next(err) }
})
