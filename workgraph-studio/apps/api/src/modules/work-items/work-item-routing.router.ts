import { Router } from 'express'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { ValidationError } from '../../lib/errors'
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

async function assertRoutingPolicyWorkflowStartable(capabilityId: string, workflowId?: string | null): Promise<void> {
  if (!workflowId) return
  const workflow = await prisma.workflow.findUnique({
    where: { id: workflowId },
    select: {
      id: true,
      name: true,
      capabilityId: true,
      archivedAt: true,
      status: true,
      profile: true,
    },
  })
  if (!workflow || workflow.archivedAt || String(workflow.status ?? '').trim().toUpperCase() === 'ARCHIVED') {
    throw new ValidationError(`Workflow ${workflowId} is not available for WorkItem routing policies.`)
  }
  if (String(workflow.profile ?? 'main').trim().toLowerCase() === 'workbench') {
    throw new ValidationError(
      `Workflow ${workflow.name} is a workbench-profile template; routing policies must target a main workflow. ` +
      `Use a main workflow with a CALL_WORKFLOW node to invoke this workbench.`,
    )
  }
  if (!workflow.capabilityId || workflow.capabilityId !== capabilityId) {
    throw new ValidationError(
      `Workflow ${workflowId} belongs to capability ${workflow.capabilityId ?? 'none'}, ` +
      `but this routing policy belongs to capability ${capabilityId}.`,
    )
  }
}

function routingPolicyWorkflowStatus(policy: {
  capabilityId: string
  workflowId?: string | null
  workflow?: {
    id: string
    name: string
    capabilityId: string | null
    archivedAt: Date | null
    status: string
    profile: string
    workflowTypeKey: string
  } | null
}) {
  if (!policy.workflowId) return undefined
  const workflow = policy.workflow
  if (!workflow) {
    return {
      state: 'invalid',
      reason: 'MISSING_TEMPLATE',
      message: `Workflow ${policy.workflowId} no longer exists.`,
      template: null,
    }
  }
  if (workflow.archivedAt || String(workflow.status ?? '').trim().toUpperCase() === 'ARCHIVED') {
    return {
      state: 'invalid',
      reason: 'ARCHIVED_TEMPLATE',
      message: `Workflow ${workflow.name} is archived.`,
      template: workflow,
    }
  }
  if (String(workflow.profile ?? 'main').trim().toLowerCase() === 'workbench') {
    return {
      state: 'invalid',
      reason: 'WORKBENCH_PROFILE_TEMPLATE',
      message: `Workflow ${workflow.name} is workbench-profile and must be invoked through a main workflow CALL_WORKFLOW node.`,
      template: workflow,
    }
  }
  if (!workflow.capabilityId || workflow.capabilityId !== policy.capabilityId) {
    return {
      state: 'invalid',
      reason: 'CAPABILITY_MISMATCH',
      message: `Workflow ${workflow.name} belongs to capability ${workflow.capabilityId ?? 'none'}, not ${policy.capabilityId}.`,
      template: workflow,
    }
  }
  return {
    state: 'valid',
    reason: null,
    message: `Workflow ${workflow.name} is startable for this routing policy.`,
    template: workflow,
  }
}

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
      include: {
        workflow: {
          select: {
            id: true,
            name: true,
            capabilityId: true,
            archivedAt: true,
            status: true,
            profile: true,
            workflowTypeKey: true,
          },
        },
      },
      orderBy: [{ capabilityId: 'asc' }, { priority: 'desc' }, { updatedAt: 'desc' }],
    })
    res.json({
      items: items.map(item => ({
        ...item,
        ...(item.workflowId ? { workflowTemplateStatus: routingPolicyWorkflowStatus(item) } : {}),
      })),
    })
  } catch (err) {
    next(err)
  }
})

workItemRoutingPoliciesRouter.post('/', validate(routingPolicySchema), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof routingPolicySchema>
    await assertRoutingPolicyWorkflowStartable(body.capabilityId, body.workflowId)
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
    const current = await prisma.workItemRoutingPolicy.findUnique({
      where: { id: req.params.id },
      select: { capabilityId: true, workflowId: true },
    })
    const effectiveCapabilityId = body.capabilityId ?? current?.capabilityId
    const effectiveWorkflowId = body.workflowId !== undefined ? body.workflowId : current?.workflowId
    if (effectiveCapabilityId) {
      await assertRoutingPolicyWorkflowStartable(effectiveCapabilityId, effectiveWorkflowId)
    }
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
