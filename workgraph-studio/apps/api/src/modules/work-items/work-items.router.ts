import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../lib/prisma'
import { validate } from '../../middleware/validate'
import { NotFoundError } from '../../lib/errors'
import {
  assertCanViewWorkItem,
  approveWorkItem,
  canViewWorkItem,
  claimWorkItemTarget,
  createWorkItem,
  requestWorkItemRework,
  startWorkItemTarget,
} from './work-items.service'

export const workItemsRouter: Router = Router()

const targetSchema = z.object({
  targetCapabilityId: z.string().min(1),
  childWorkflowTemplateId: z.string().uuid().optional(),
  roleKey: z.string().optional(),
})

const createSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  parentCapabilityId: z.string().optional(),
  sourceWorkflowInstanceId: z.string().uuid().optional(),
  sourceWorkflowNodeId: z.string().uuid().optional(),
  input: z.record(z.unknown()).optional(),
  priority: z.number().int().optional(),
  dueAt: z.string().datetime().optional(),
  targets: z.array(targetSchema).min(1),
})

const reworkSchema = z.object({
  targetIds: z.array(z.string().uuid()).optional(),
  reason: z.string().optional(),
})

workItemsRouter.post('/', validate(createSchema), async (req, res, next) => {
  try {
    const workItem = await createWorkItem(req.body as z.infer<typeof createSchema>, req.user!.userId)
    res.status(201).json(workItem)
  } catch (err) {
    next(err)
  }
})

workItemsRouter.get('/', async (req, res, next) => {
  try {
    const { targetCapabilityId, status, mine } = req.query as Record<string, string | undefined>
    const targetWhere: Record<string, unknown> = {}
    if (targetCapabilityId) targetWhere.targetCapabilityId = targetCapabilityId
    if (status) targetWhere.status = status
    if (mine === '1' || mine === 'true') targetWhere.claimedById = req.user!.userId

    const items = await prisma.workItem.findMany({
      where: Object.keys(targetWhere).length > 0 ? { targets: { some: targetWhere } } : undefined,
      include: {
        targets: Object.keys(targetWhere).length > 0 ? { where: targetWhere, orderBy: { createdAt: 'asc' } } : { orderBy: { createdAt: 'asc' } },
        events: { orderBy: { createdAt: 'desc' }, take: 5 },
      },
      orderBy: { updatedAt: 'desc' },
      take: 200,
    })
    const visible = []
    for (const item of items) {
      if (await canViewWorkItem(req.user!.userId, item)) visible.push(item)
    }
    res.json({ items: visible })
  } catch (err) {
    next(err)
  }
})

workItemsRouter.get('/:id', async (req, res, next) => {
  try {
    const id = String(req.params.id)
    const workItem = await prisma.workItem.findUnique({
      where: { id },
      include: {
        targets: { orderBy: { createdAt: 'asc' } },
        events: { orderBy: { createdAt: 'asc' } },
      },
    })
    if (!workItem) throw new NotFoundError('WorkItem', id)
    await assertCanViewWorkItem(req.user!.userId, workItem)
    res.json(workItem)
  } catch (err) {
    next(err)
  }
})

workItemsRouter.post('/:id/targets/:targetId/claim', async (req, res, next) => {
  try {
    const target = await claimWorkItemTarget(String(req.params.id), String(req.params.targetId), req.user!.userId)
    res.json(target)
  } catch (err) {
    next(err)
  }
})

workItemsRouter.post('/:id/targets/:targetId/start', async (req, res, next) => {
  try {
    const result = await startWorkItemTarget(String(req.params.id), String(req.params.targetId), req.user!.userId)
    res.json(result)
  } catch (err) {
    next(err)
  }
})

workItemsRouter.post('/:id/approve', async (req, res, next) => {
  try {
    const result = await approveWorkItem(String(req.params.id), req.user!.userId, 'APPROVED')
    res.json(result)
  } catch (err) {
    next(err)
  }
})

workItemsRouter.post('/:id/request-rework', validate(reworkSchema), async (req, res, next) => {
  try {
    const { targetIds, reason } = req.body as z.infer<typeof reworkSchema>
    const result = await requestWorkItemRework(String(req.params.id), req.user!.userId, targetIds, reason)
    res.json(result)
  } catch (err) {
    next(err)
  }
})
