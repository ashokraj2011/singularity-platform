import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../lib/prisma'
import { validate } from '../../middleware/validate'
import { NotFoundError } from '../../lib/errors'
import {
  answerWorkItemClarification,
  assertCanViewWorkItem,
  approveWorkItem,
  canViewWorkItem,
  claimWorkItemTarget,
  createWorkItem,
  requestWorkItemClarification,
  requestWorkItemRework,
  startWorkItemTarget,
} from './work-items.service'

export const workItemsRouter: Router = Router()

const WORK_ITEM_TARGET_STATUSES = [
  'QUEUED',
  'CLAIMED',
  'IN_PROGRESS',
  'SUBMITTED',
  'APPROVED',
  'REWORK_REQUESTED',
  'CANCELLED',
] as const

const targetSchema = z.object({
  targetCapabilityId: z.string().min(1),
  childWorkflowTemplateId: z.string().uuid().optional(),
  roleKey: z.string().optional(),
})

const createSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  originType: z.enum(['PARENT_DELEGATED', 'CAPABILITY_LOCAL']).optional(),
  parentCapabilityId: z.string().optional(),
  sourceWorkflowInstanceId: z.string().uuid().optional(),
  sourceWorkflowNodeId: z.string().uuid().optional(),
  input: z.record(z.unknown()).optional(),
  details: z.record(z.unknown()).optional(),
  budget: z.record(z.unknown()).optional(),
  urgency: z.enum(['LOW', 'NORMAL', 'HIGH', 'CRITICAL']).optional(),
  requiredBy: z.string().datetime().optional(),
  priority: z.number().int().optional(),
  dueAt: z.string().datetime().optional(),
  targets: z.array(targetSchema).min(1),
})

const startTargetSchema = z.object({
  childWorkflowTemplateId: z.string().uuid().optional(),
}).default({})

const clarificationSchema = z.object({
  question: z.string().min(1),
})

const answerClarificationSchema = z.object({
  answer: z.string().min(1),
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
    const { targetCapabilityId, status, mine, cursor, sourceWorkflowInstanceId, sourceWorkflowNodeId } = req.query as Record<string, string | undefined>
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 100)
    const targetWhere: Record<string, unknown> = {}
    const itemWhere: Record<string, unknown> = {}
    if (sourceWorkflowInstanceId) itemWhere.sourceWorkflowInstanceId = sourceWorkflowInstanceId
    if (sourceWorkflowNodeId) itemWhere.sourceWorkflowNodeId = sourceWorkflowNodeId
    if (targetCapabilityId) targetWhere.targetCapabilityId = targetCapabilityId
    if (status) {
      const normalized = status.toUpperCase()
      if (!WORK_ITEM_TARGET_STATUSES.includes(normalized as (typeof WORK_ITEM_TARGET_STATUSES)[number])) {
        res.status(400).json({ error: 'INVALID_WORK_ITEM_STATUS', message: `Unknown WorkItem target status: ${status}` })
        return
      }
      targetWhere.status = normalized
    }
    if (mine === '1' || mine === 'true') targetWhere.claimedById = req.user!.userId

    const visible = []
    let nextCursor: string | null = cursor ?? null
    let exhausted = false
    while (visible.length < limit && !exhausted) {
      const items = await prisma.workItem.findMany({
        where: {
          ...itemWhere,
          ...(Object.keys(targetWhere).length > 0 ? { targets: { some: targetWhere } } : {}),
        },
        include: {
          targets: Object.keys(targetWhere).length > 0 ? { where: targetWhere, orderBy: { createdAt: 'asc' } } : { orderBy: { createdAt: 'asc' } },
          events: { orderBy: { createdAt: 'desc' }, take: 5 },
          clarifications: { orderBy: { createdAt: 'desc' }, take: 5 },
        },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        ...(nextCursor ? { cursor: { id: nextCursor }, skip: 1 } : {}),
        take: Math.min(100, Math.max(limit * 2, 25)),
      })
      exhausted = items.length === 0
      for (const item of items) {
        nextCursor = item.id
        if (await canViewWorkItem(req.user!.userId, item)) visible.push(item)
        if (visible.length >= limit) break
      }
      if (items.length < Math.min(100, Math.max(limit * 2, 25))) exhausted = true
    }
    res.json({ items: visible, nextCursor: exhausted ? null : nextCursor })
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
        clarifications: { orderBy: { createdAt: 'asc' } },
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

workItemsRouter.post('/:id/targets/:targetId/start', validate(startTargetSchema), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof startTargetSchema>
    const result = await startWorkItemTarget(String(req.params.id), String(req.params.targetId), req.user!.userId, {
      childWorkflowTemplateId: body?.childWorkflowTemplateId,
    })
    res.json(result)
  } catch (err) {
    next(err)
  }
})

workItemsRouter.post('/:id/targets/:targetId/clarifications', validate(clarificationSchema), async (req, res, next) => {
  try {
    const { question } = req.body as z.infer<typeof clarificationSchema>
    const result = await requestWorkItemClarification(String(req.params.id), String(req.params.targetId), req.user!.userId, question)
    res.status(201).json(result)
  } catch (err) {
    next(err)
  }
})

workItemsRouter.post('/:id/clarifications/:clarificationId/answer', validate(answerClarificationSchema), async (req, res, next) => {
  try {
    const { answer } = req.body as z.infer<typeof answerClarificationSchema>
    const result = await answerWorkItemClarification(String(req.params.id), String(req.params.clarificationId), req.user!.userId, answer)
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
