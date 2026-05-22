import { Router } from 'express'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { validate } from '../../middleware/validate'
import { normalizeMetadataKey } from '../metadata/metadata.service'

export const workItemRoutingPoliciesRouter: Router = Router()
export const workItemTriggersRouter: Router = Router()

const routingModes = ['MANUAL', 'AUTO_ATTACH', 'AUTO_START', 'SCHEDULED_START'] as const
const triggerTypes = ['EVENT', 'SCHEDULE', 'WEBHOOK'] as const

const routingPolicySchema = z.object({
  capabilityId: z.string().min(1),
  workItemTypeKey: z.string().min(1).default('GENERAL'),
  workflowTypeKey: z.string().min(1).default('GENERAL'),
  workflowId: z.string().uuid().nullable().optional(),
  routingMode: z.enum(routingModes).default('MANUAL'),
  priority: z.number().int().default(100),
  selector: z.record(z.unknown()).default({}),
  isActive: z.boolean().default(true),
})

const routingPolicyPatchSchema = routingPolicySchema.partial()

const workItemTriggerSchema = z.object({
  triggerType: z.enum(triggerTypes),
  eventTypeKey: z.string().optional(),
  capabilityId: z.string().optional(),
  workItemTypeKey: z.string().min(1).default('GENERAL'),
  routingMode: z.enum(routingModes).default('MANUAL'),
  scheduleConfig: z.record(z.unknown()).default({}),
  payloadMapping: z.record(z.unknown()).default({}),
  dedupeKey: z.string().optional(),
  isActive: z.boolean().default(true),
})

const workItemTriggerPatchSchema = workItemTriggerSchema.partial()

workItemRoutingPoliciesRouter.get('/', async (req, res, next) => {
  try {
    const { capabilityId, workItemTypeKey, workflowTypeKey, isActive } = req.query as Record<string, string | undefined>
    const where: Prisma.WorkItemRoutingPolicyWhereInput = {}
    if (capabilityId) where.capabilityId = capabilityId
    if (workItemTypeKey) where.workItemTypeKey = normalizeMetadataKey(workItemTypeKey)
    if (workflowTypeKey) where.workflowTypeKey = normalizeMetadataKey(workflowTypeKey)
    if (isActive === 'true' || isActive === '1') where.isActive = true
    if (isActive === 'false' || isActive === '0') where.isActive = false
    const items = await prisma.workItemRoutingPolicy.findMany({
      where,
      include: { workflow: { select: { id: true, name: true, workflowTypeKey: true } } },
      orderBy: [{ capabilityId: 'asc' }, { priority: 'desc' }, { updatedAt: 'desc' }],
    })
    res.json({ items })
  } catch (err) {
    next(err)
  }
})

workItemRoutingPoliciesRouter.post('/', validate(routingPolicySchema), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof routingPolicySchema>
    const policy = await prisma.workItemRoutingPolicy.create({
      data: {
        capabilityId: body.capabilityId,
        workItemTypeKey: normalizeMetadataKey(body.workItemTypeKey),
        workflowTypeKey: normalizeMetadataKey(body.workflowTypeKey),
        workflowId: body.workflowId ?? null,
        routingMode: body.routingMode,
        priority: body.priority,
        selector: body.selector as Prisma.InputJsonValue,
        isActive: body.isActive,
      },
    })
    res.status(201).json(policy)
  } catch (err) {
    next(err)
  }
})

workItemRoutingPoliciesRouter.patch('/:id', validate(routingPolicyPatchSchema), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof routingPolicyPatchSchema>
    const policy = await prisma.workItemRoutingPolicy.update({
      where: { id: req.params.id },
      data: {
        ...(body.capabilityId !== undefined ? { capabilityId: body.capabilityId } : {}),
        ...(body.workItemTypeKey !== undefined ? { workItemTypeKey: normalizeMetadataKey(body.workItemTypeKey) } : {}),
        ...(body.workflowTypeKey !== undefined ? { workflowTypeKey: normalizeMetadataKey(body.workflowTypeKey) } : {}),
        ...(body.workflowId !== undefined ? { workflowId: body.workflowId } : {}),
        ...(body.routingMode !== undefined ? { routingMode: body.routingMode } : {}),
        ...(body.priority !== undefined ? { priority: body.priority } : {}),
        ...(body.selector !== undefined ? { selector: body.selector as Prisma.InputJsonValue } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
      },
    })
    res.json(policy)
  } catch (err) {
    next(err)
  }
})

workItemTriggersRouter.get('/', async (req, res, next) => {
  try {
    const { triggerType, eventTypeKey, capabilityId, isActive } = req.query as Record<string, string | undefined>
    const where: Prisma.WorkItemTriggerWhereInput = {}
    if (triggerType && (triggerTypes as readonly string[]).includes(triggerType)) where.triggerType = triggerType as any
    if (eventTypeKey) where.eventTypeKey = normalizeMetadataKey(eventTypeKey)
    if (capabilityId) where.capabilityId = capabilityId
    if (isActive === 'true' || isActive === '1') where.isActive = true
    if (isActive === 'false' || isActive === '0') where.isActive = false
    const items = await prisma.workItemTrigger.findMany({ where, orderBy: { createdAt: 'desc' } })
    res.json({ items })
  } catch (err) {
    next(err)
  }
})

workItemTriggersRouter.post('/', validate(workItemTriggerSchema), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof workItemTriggerSchema>
    const trigger = await prisma.workItemTrigger.create({
      data: {
        triggerType: body.triggerType,
        eventTypeKey: body.eventTypeKey ? normalizeMetadataKey(body.eventTypeKey) : null,
        capabilityId: body.capabilityId ?? null,
        workItemTypeKey: normalizeMetadataKey(body.workItemTypeKey),
        routingMode: body.routingMode,
        scheduleConfig: body.scheduleConfig as Prisma.InputJsonValue,
        payloadMapping: body.payloadMapping as Prisma.InputJsonValue,
        dedupeKey: body.dedupeKey,
        isActive: body.isActive,
      },
    })
    res.status(201).json(trigger)
  } catch (err) {
    next(err)
  }
})

workItemTriggersRouter.patch('/:id', validate(workItemTriggerPatchSchema), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof workItemTriggerPatchSchema>
    const trigger = await prisma.workItemTrigger.update({
      where: { id: req.params.id },
      data: {
        ...(body.triggerType !== undefined ? { triggerType: body.triggerType } : {}),
        ...(body.eventTypeKey !== undefined ? { eventTypeKey: body.eventTypeKey ? normalizeMetadataKey(body.eventTypeKey) : null } : {}),
        ...(body.capabilityId !== undefined ? { capabilityId: body.capabilityId } : {}),
        ...(body.workItemTypeKey !== undefined ? { workItemTypeKey: normalizeMetadataKey(body.workItemTypeKey) } : {}),
        ...(body.routingMode !== undefined ? { routingMode: body.routingMode } : {}),
        ...(body.scheduleConfig !== undefined ? { scheduleConfig: body.scheduleConfig as Prisma.InputJsonValue } : {}),
        ...(body.payloadMapping !== undefined ? { payloadMapping: body.payloadMapping as Prisma.InputJsonValue } : {}),
        ...(body.dedupeKey !== undefined ? { dedupeKey: body.dedupeKey } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
      },
    })
    res.json(trigger)
  } catch (err) {
    next(err)
  }
})
