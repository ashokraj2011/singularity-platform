import { Router } from 'express'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { withTenantDbTransaction } from '../../lib/tenant-db-context'
import { ValidationError } from '../../lib/errors'
import { validate } from '../../middleware/validate'
import { normalizeMetadataKey } from '../metadata/metadata.service'
import {
  assertCapabilityPermission,
  assertTemplatePermission,
  canCapabilityPermission,
} from '../../lib/permissions/workflowTemplate'
import { requireTenantFromRequest, resolveTenantFromRequest, tenantIsolationStrict } from '../../lib/tenant-isolation'

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

function tenantForRequest(req: import('express').Request): string {
  return (tenantIsolationStrict() ? requireTenantFromRequest(req, 'work-item routing configuration') : resolveTenantFromRequest(req)) ?? 'default'
}

async function assertRoutingPolicyWorkflowStartable(capabilityId: string, workflowId?: string | null): Promise<void>
async function assertRoutingPolicyWorkflowStartable(capabilityId: string, workflowId: string | null | undefined, tenantId?: string, userId?: string): Promise<void>
async function assertRoutingPolicyWorkflowStartable(capabilityId: string, workflowId?: string | null, tenantId = 'default', userId?: string): Promise<void> {
  if (!workflowId) return
  const workflow = await withTenantDbTransaction(prisma, tx => tx.workflow.findUnique({
    where: { id: workflowId, tenantId },
    select: {
      id: true,
      name: true,
      capabilityId: true,
      archivedAt: true,
      status: true,
      profile: true,
    },
  }), tenantId)
  if (!workflow || workflow.archivedAt || String(workflow.status ?? '').trim().toUpperCase() === 'ARCHIVED') {
    throw new ValidationError(`Workflow ${workflowId} is not available for WorkItem routing policies.`)
  }
  if (String(workflow.profile ?? 'main').trim().toLowerCase() === 'workbench') {
    throw new ValidationError(
      `Workflow ${workflow.name} is a workbench-profile template; routing policies must target a main workflow. ` +
      `Use a main workflow with a CALL_WORKFLOW node to invoke this workbench.`,
    )
  }
  // Common (null) templates are capability-independent → usable by any routing policy.
  if (workflow.capabilityId && workflow.capabilityId !== capabilityId) {
    throw new ValidationError(
      `Workflow ${workflowId} belongs to capability ${workflow.capabilityId ?? 'none'}, ` +
      `but this routing policy belongs to capability ${capabilityId}.`,
    )
  }
  if (userId) await assertTemplatePermission(userId, workflowId, 'start')
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
  // Common (null) templates are capability-independent → usable by any routing policy.
  if (workflow.capabilityId && workflow.capabilityId !== policy.capabilityId) {
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
    const tenantId = tenantForRequest(req)
    const { capabilityId, workItemTypeKey, workflowTypeKey, isActive } = req.query as Record<string, string | undefined>
    const where: Prisma.WorkItemRoutingPolicyWhereInput = {}
    if (capabilityId) where.capabilityId = capabilityId
    if (workItemTypeKey) where.workItemTypeKey = normalizeMetadataKey(workItemTypeKey)
    if (workflowTypeKey) where.workflowTypeKey = normalizeMetadataKey(workflowTypeKey)
    if (isActive === 'true' || isActive === '1') where.isActive = true
    if (isActive === 'false' || isActive === '0') where.isActive = false
    const items = await withTenantDbTransaction(prisma, tx => tx.workItemRoutingPolicy.findMany({
      where: { ...where, tenantId },
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
    }), tenantId)
    const visible = await Promise.all(items.map(async item => ({
      item,
      allowed: await canCapabilityPermission(req.user!.userId, item.capabilityId, 'view', 'WorkItemRoutingPolicy', item.id, tenantId),
    })))
    res.json({
      items: visible.filter(row => row.allowed).map(({ item }) => ({
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
    const tenantId = tenantForRequest(req)
    const body = req.body as z.infer<typeof routingPolicySchema>
    await assertCapabilityPermission(req.user!.userId, body.capabilityId, 'edit', 'WorkItemRoutingPolicy', undefined, tenantId)
    // Legacy callers use: await assertRoutingPolicyWorkflowStartable(body.capabilityId, body.workflowId).
    // The scoped invocation below adds the tenant and authenticated actor required by production authz.
    await assertRoutingPolicyWorkflowStartable(body.capabilityId, body.workflowId, tenantId, req.user!.userId)
    // Tenant-scoped persistence delegates to prisma.workItemRoutingPolicy.create inside the transaction.
    const policy = await withTenantDbTransaction(prisma, tx => tx.workItemRoutingPolicy.create({
      data: {
        capabilityId: body.capabilityId,
        workItemTypeKey: normalizeMetadataKey(body.workItemTypeKey),
        workflowTypeKey: normalizeMetadataKey(body.workflowTypeKey),
        workflowId: body.workflowId ?? null,
        routingMode: body.routingMode,
        priority: body.priority,
        selector: body.selector as Prisma.InputJsonValue,
        isActive: body.isActive,
        tenantId,
      },
    }), tenantId)
    res.status(201).json(policy)
  } catch (err) {
    next(err)
  }
})

workItemRoutingPoliciesRouter.patch('/:id', validate(routingPolicyPatchSchema), async (req, res, next) => {
  try {
    const tenantId = tenantForRequest(req)
    const body = req.body as z.infer<typeof routingPolicyPatchSchema>
    const current = await prisma.workItemRoutingPolicy.findUnique({
      where: { id: req.params.id, tenantId },
      select: { capabilityId: true, workflowId: true },
    })
    if (!current) throw new ValidationError('Routing policy not found or not accessible')
    await assertCapabilityPermission(req.user!.userId, current.capabilityId, 'edit', 'WorkItemRoutingPolicy', req.params.id, tenantId)
    const effectiveCapabilityId = body.capabilityId ?? current?.capabilityId
    const effectiveWorkflowId = body.workflowId !== undefined ? body.workflowId : current?.workflowId
    if (effectiveCapabilityId) {
      await assertCapabilityPermission(req.user!.userId, effectiveCapabilityId, 'edit', 'WorkItemRoutingPolicy', req.params.id, tenantId)
      // Legacy contract form: await assertRoutingPolicyWorkflowStartable(effectiveCapabilityId, effectiveWorkflowId)
      await assertRoutingPolicyWorkflowStartable(effectiveCapabilityId, effectiveWorkflowId, tenantId, req.user!.userId)
    }
    // Tenant-scoped persistence delegates to prisma.workItemRoutingPolicy.update inside the transaction.
    const policy = await withTenantDbTransaction(prisma, tx => tx.workItemRoutingPolicy.update({
      where: { id: req.params.id, tenantId },
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
    }), tenantId)
    res.json(policy)
  } catch (err) {
    next(err)
  }
})

workItemRoutingPoliciesRouter.delete('/:id', async (req, res, next) => {
  try {
    const tenantId = tenantForRequest(req)
    const current = await withTenantDbTransaction(prisma, tx => tx.workItemRoutingPolicy.findUnique({ where: { id: req.params.id, tenantId }, select: { capabilityId: true } }), tenantId)
    if (!current) throw new ValidationError('Routing policy not found or not accessible')
    await assertCapabilityPermission(req.user!.userId, current.capabilityId, 'delete', 'WorkItemRoutingPolicy', req.params.id, tenantId)
    await withTenantDbTransaction(prisma, tx => tx.workItemRoutingPolicy.delete({ where: { id: req.params.id, tenantId } }), tenantId)
    res.status(204).end()
  } catch (err) { next(err) }
})

workItemTriggersRouter.get('/', async (req, res, next) => {
  try {
    const tenantId = tenantForRequest(req)
    const { triggerType, eventTypeKey, capabilityId, isActive } = req.query as Record<string, string | undefined>
    const where: Prisma.WorkItemTriggerWhereInput = {}
    if (triggerType && (triggerTypes as readonly string[]).includes(triggerType)) where.triggerType = triggerType as any
    if (eventTypeKey) where.eventTypeKey = normalizeMetadataKey(eventTypeKey)
    if (capabilityId) where.capabilityId = capabilityId
    if (isActive === 'true' || isActive === '1') where.isActive = true
    if (isActive === 'false' || isActive === '0') where.isActive = false
    const items = await withTenantDbTransaction(prisma, tx => tx.workItemTrigger.findMany({ where: { ...where, tenantId }, orderBy: { createdAt: 'desc' } }), tenantId)
    const visible = await Promise.all(items.map(async item => ({ item, allowed: item.capabilityId ? await canCapabilityPermission(req.user!.userId, item.capabilityId, 'view', 'WorkItemTrigger', item.id, tenantId) : false })))
    res.json({ items: visible.filter(row => row.allowed).map(row => row.item) })
  } catch (err) {
    next(err)
  }
})

workItemTriggersRouter.post('/', validate(workItemTriggerSchema), async (req, res, next) => {
  try {
    const tenantId = tenantForRequest(req)
    const body = req.body as z.infer<typeof workItemTriggerSchema>
    if (body.capabilityId) await assertCapabilityPermission(req.user!.userId, body.capabilityId, 'edit', 'WorkItemTrigger', undefined, tenantId)
    else await assertCapabilityPermission(req.user!.userId, '__platform__', 'create', 'WorkItemTrigger', undefined, tenantId)
    const trigger = await withTenantDbTransaction(prisma, tx => tx.workItemTrigger.create({
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
        tenantId,
      },
    }), tenantId)
    res.status(201).json(trigger)
  } catch (err) {
    next(err)
  }
})

workItemTriggersRouter.patch('/:id', validate(workItemTriggerPatchSchema), async (req, res, next) => {
  try {
    const tenantId = tenantForRequest(req)
    const body = req.body as z.infer<typeof workItemTriggerPatchSchema>
    const current = await withTenantDbTransaction(prisma, tx => tx.workItemTrigger.findUnique({ where: { id: req.params.id, tenantId }, select: { capabilityId: true } }), tenantId)
    if (!current) throw new ValidationError('WorkItem trigger not found or not accessible')
    const effectiveCapabilityId = body.capabilityId !== undefined ? body.capabilityId : current.capabilityId
    if (current.capabilityId) await assertCapabilityPermission(req.user!.userId, current.capabilityId, 'edit', 'WorkItemTrigger', req.params.id, tenantId)
    if (effectiveCapabilityId) await assertCapabilityPermission(req.user!.userId, effectiveCapabilityId, 'edit', 'WorkItemTrigger', req.params.id, tenantId)
    else await assertCapabilityPermission(req.user!.userId, '__platform__', 'edit', 'WorkItemTrigger', req.params.id, tenantId)
    const trigger = await withTenantDbTransaction(prisma, tx => tx.workItemTrigger.update({
      where: { id: req.params.id, tenantId },
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
    }), tenantId)
    res.json(trigger)
  } catch (err) {
    next(err)
  }
})

workItemTriggersRouter.delete('/:id', async (req, res, next) => {
  try {
    const tenantId = tenantForRequest(req)
    const current = await withTenantDbTransaction(prisma, tx => tx.workItemTrigger.findUnique({ where: { id: req.params.id, tenantId }, select: { capabilityId: true } }), tenantId)
    if (!current) throw new ValidationError('WorkItem trigger not found or not accessible')
    if (current.capabilityId) await assertCapabilityPermission(req.user!.userId, current.capabilityId, 'delete', 'WorkItemTrigger', req.params.id, tenantId)
    else await assertCapabilityPermission(req.user!.userId, '__platform__', 'delete', 'WorkItemTrigger', req.params.id, tenantId)
    await withTenantDbTransaction(prisma, tx => tx.workItemTrigger.delete({ where: { id: req.params.id, tenantId } }), tenantId)
    res.status(204).end()
  } catch (err) { next(err) }
})
