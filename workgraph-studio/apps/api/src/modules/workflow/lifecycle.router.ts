import { Router } from 'express'
import { z } from 'zod'
import { validate } from '../../middleware/validate'
import { replayWorkflow, simulateWorkflow } from './lifecycle.service'
import { createWorkflowCheckpoint, listWorkflowCheckpoints } from './checkpoint.service'
import { assertWorkflowInstanceTenant } from '../../lib/tenant-isolation'
import { assertInstancePermission } from '../../lib/permissions/workflowTemplate'

export const workflowLifecycleRouter: Router = Router()

workflowLifecycleRouter.post('/:id/simulate', validate(z.object({ input: z.record(z.unknown()).default({}), maxSteps: z.coerce.number().int().min(1).max(1000).optional() })), async (req, res, next) => {
  try {
    await assertWorkflowInstanceTenant(req, req.params.id)
    await assertInstancePermission(req.user!.userId, req.params.id, 'simulate')
    res.status(201).json(await simulateWorkflow(req.params.id, req.user!.userId, req.body.input, req.body.maxSteps))
  } catch (err) { next(err) }
})

workflowLifecycleRouter.get('/:id/checkpoints', async (req, res, next) => {
  try {
    await assertWorkflowInstanceTenant(req, req.params.id)
    await assertInstancePermission(req.user!.userId, req.params.id, 'checkpoint')
    res.json(await listWorkflowCheckpoints(req.params.id))
  } catch (err) { next(err) }
})

workflowLifecycleRouter.post('/:id/checkpoints', validate(z.object({ reason: z.string().max(500).optional(), nodeId: z.string().uuid().optional() })), async (req, res, next) => {
  try {
    await assertWorkflowInstanceTenant(req, req.params.id)
    await assertInstancePermission(req.user!.userId, req.params.id, 'checkpoint')
    res.status(201).json(await createWorkflowCheckpoint(req.params.id, req.user!.userId, req.body.reason, req.body.nodeId))
  } catch (err) { next(err) }
})

workflowLifecycleRouter.post('/:id/replay', validate(z.object({ checkpointId: z.string().uuid().optional(), mode: z.enum(['DRY_RUN', 'RESUME']).default('DRY_RUN') })), async (req, res, next) => {
  try {
    await assertWorkflowInstanceTenant(req, req.params.id)
    await assertInstancePermission(req.user!.userId, req.params.id, 'replay')
    res.status(201).json(await replayWorkflow(req.params.id, req.user!.userId, req.body.checkpointId, req.body.mode))
  } catch (err) { next(err) }
})
