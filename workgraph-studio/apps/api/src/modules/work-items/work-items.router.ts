import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../lib/prisma'
import { validate } from '../../middleware/validate'
import { NotFoundError } from '../../lib/errors'
import {
  answerWorkItemClarification,
  archiveWorkItem,
  assertCanClaimWorkItemTarget,
  assertCanViewWorkItem,
  approveWorkItem,
  canViewWorkItem,
  claimWorkItemTarget,
  createWorkItem,
  detachWorkItemFromWorkflow,
  detachWorkItemTargetFromWorkflow,
  requestWorkItemClarification,
  requestWorkItemRework,
  startWorkItemTarget,
  updateWorkItem,
} from './work-items.service'
import { routeWorkItem } from './work-item-routing.service'

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

const WORK_ITEM_STATUSES = [
  'SCHEDULED',
  'QUEUED',
  'IN_PROGRESS',
  'AWAITING_PARENT_APPROVAL',
  'COMPLETED',
  'CANCELLED',
  'ARCHIVED',
] as const

type WorkItemTargetForDiagnostics = {
  targetCapabilityId: string
  childWorkflowTemplateId?: string | null
}

type WorkItemForDiagnostics = {
  targets: WorkItemTargetForDiagnostics[]
}

type WorkflowTemplateForDiagnostics = {
  id: string
  name: string
  capabilityId: string | null
  archivedAt: Date | null
  status: string
  profile: string
  workflowTypeKey: string
}

function targetTemplateStatus(target: WorkItemTargetForDiagnostics, template?: WorkflowTemplateForDiagnostics) {
  if (!target.childWorkflowTemplateId) return undefined
  if (!template) {
    return {
      state: 'invalid',
      reason: 'MISSING_TEMPLATE',
      message: `Workflow template ${target.childWorkflowTemplateId} no longer exists.`,
      template: null,
    }
  }
  if (template.archivedAt || String(template.status ?? '').trim().toUpperCase() === 'ARCHIVED') {
    return {
      state: 'invalid',
      reason: 'ARCHIVED_TEMPLATE',
      message: `Workflow template ${template.name} is archived.`,
      template,
    }
  }
  if (String(template.profile ?? 'main').trim().toLowerCase() === 'workbench') {
    return {
      state: 'invalid',
      reason: 'WORKBENCH_PROFILE_TEMPLATE',
      message: `Workflow template ${template.name} is workbench-profile and must be invoked through a main workflow CALL_WORKFLOW node.`,
      template,
    }
  }
  // Common (null) templates are capability-independent → usable by any WorkItem target.
  if (template.capabilityId && template.capabilityId !== target.targetCapabilityId) {
    return {
      state: 'invalid',
      reason: 'CAPABILITY_MISMATCH',
      message: `Workflow template ${template.name} belongs to capability ${template.capabilityId ?? 'none'}, not ${target.targetCapabilityId}.`,
      template,
    }
  }
  return {
    state: 'valid',
    reason: null,
    message: `Workflow template ${template.name} is startable for this target capability.`,
    template,
  }
}

async function withTargetTemplateDiagnostics<T extends WorkItemForDiagnostics>(items: T[]): Promise<T[]> {
  const ids = [...new Set(items.flatMap(item => item.targets.map(target => target.childWorkflowTemplateId).filter((id): id is string => Boolean(id))))];
  if (ids.length === 0) return items
  const templates = await prisma.workflow.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      name: true,
      capabilityId: true,
      archivedAt: true,
      status: true,
      profile: true,
      workflowTypeKey: true,
    },
  })
  const byId = new Map(templates.map(template => [template.id, template]))
  return items.map(item => ({
    ...item,
    targets: item.targets.map(target => ({
      ...target,
      ...(target.childWorkflowTemplateId
        ? { workflowTemplateStatus: targetTemplateStatus(target, byId.get(target.childWorkflowTemplateId)) }
        : {}),
    })),
  }))
}

const targetSchema = z.object({
  targetCapabilityId: z.string().min(1),
  childWorkflowTemplateId: z.string().uuid().optional(),
  roleKey: z.string().optional(),
})

const createSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  workItemTypeKey: z.string().optional(),
  routingMode: z.enum(['MANUAL', 'AUTO_ATTACH', 'AUTO_START', 'SCHEDULED_START']).optional(),
  workflowTypeKey: z.string().optional(),
  scheduledAt: z.string().datetime().optional(),
  notBefore: z.string().datetime().optional(),
  sourceEventTypeKey: z.string().optional(),
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
  // Optional per-run model chosen at launch (a gateway catalog alias).
  modelAlias: z.string().max(120).optional(),
  // Optional per-run git branch/ref chosen at launch — the branch the run clones
  // and bases its wi/<code> work branch on. Empty → the designed/capability
  // default (which, when itself empty, makes the runtime blindly guess `main`).
  sourceRef: z.string().max(200).optional(),
  // Optional per-run source mode. 'github' (default) clones the resolved repo;
  // 'local_dir' points the run at an existing checkout on the runtime (sourceUri),
  // validated against the runtime's MCP_ALLOWED_LOCAL_SOURCE_ROOTS.
  sourceType: z.string().max(40).optional(),
  // The source location: a repo URL for github, or a local path for local_dir.
  // Empty → the capability's linked repo / node default (github only).
  sourceUri: z.string().max(500).optional(),
  // Optional per-run "clone into" folder — a name resolved under the runtime's
  // managed workspaces root (never an arbitrary FS path).
  cloneDir: z.string().max(200).optional(),
  // Optional: push the working-tree code to wi/<code> via the runtime after each
  // phase's artifacts are finalized (S3). Opt-in; rides the dial-in bridge.
  pushEachPhase: z.boolean().optional(),
}).default({})

const routeSchemaBase = z.object({
  targetId: z.string().uuid().optional(),
  workflowId: z.string().uuid().optional(),
  workflowTypeKey: z.string().optional(),
  routingMode: z.enum(['MANUAL', 'AUTO_ATTACH', 'AUTO_START', 'SCHEDULED_START']).optional(),
})

const routeSchema = routeSchemaBase.default({})

const attachSchema = routeSchemaBase.extend({
  workflowId: z.string().uuid().optional(),
}).default({})

const startWorkItemSchema = routeSchemaBase.extend({
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

const detachSchema = z.object({
  reason: z.string().optional(),
}).default({})

workItemsRouter.post('/', validate(createSchema), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof createSchema>
    // Security (finding #3): a real user must be authorized to act in every target
    // capability before creating/routing a work item there. No-ops when
    // AUTH_PROVIDER !== 'iam'; admins bypass. Internal automation uses the service
    // functions directly (no router), so it is unaffected.
    for (const t of body.targets) {
      await assertCanClaimWorkItemTarget(req.user!.userId, t.targetCapabilityId, `create:${t.targetCapabilityId}`)
    }
    const created = await createWorkItem(body, req.user!.userId)
    if (body.routingMode && body.routingMode !== 'MANUAL') {
      const routed = await routeWorkItem(created.id, req.user!.userId, {
        workflowTypeKey: body.workflowTypeKey,
        routingMode: body.routingMode,
      })
      res.status(201).json(routed)
      return
    }
    res.status(201).json(created)
  } catch (err) {
    next(err)
  }
})

workItemsRouter.get('/', async (req, res, next) => {
  try {
    const { targetCapabilityId, status, mine, cursor, sourceWorkflowInstanceId, sourceWorkflowNodeId, includeArchived, archived, available, workItemTypeKey, routingMode, routingState, sourceEventTypeKey } = req.query as Record<string, string | undefined>
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 100)
    const targetWhere: Record<string, unknown> = {}
    const itemWhere: Record<string, unknown> = {}
    if (archived === '1' || archived === 'true') {
      itemWhere.status = 'ARCHIVED'
    } else if (!(includeArchived === '1' || includeArchived === 'true')) {
      itemWhere.status = { not: 'ARCHIVED' }
    }
    if (sourceWorkflowInstanceId) itemWhere.sourceWorkflowInstanceId = sourceWorkflowInstanceId
    if (sourceWorkflowNodeId) itemWhere.sourceWorkflowNodeId = sourceWorkflowNodeId
    if (workItemTypeKey) itemWhere.workItemTypeKey = workItemTypeKey.toUpperCase()
    if (routingMode) itemWhere.routingMode = routingMode.toUpperCase()
    if (routingState) itemWhere.routingState = routingState.toUpperCase()
    if (sourceEventTypeKey) itemWhere.sourceEventTypeKey = sourceEventTypeKey.toUpperCase()
    if (targetCapabilityId) targetWhere.targetCapabilityId = targetCapabilityId
    if (available === '1' || available === 'true') {
      itemWhere.status = { in: ['QUEUED', 'IN_PROGRESS'] }
      itemWhere.sourceWorkflowInstanceId = null
      itemWhere.sourceWorkflowNodeId = null
      targetWhere.status = { in: ['QUEUED', 'CLAIMED', 'REWORK_REQUESTED'] }
      targetWhere.childWorkflowInstanceId = null
    }
    if (status) {
      const normalized = status.toUpperCase()
      if (WORK_ITEM_TARGET_STATUSES.includes(normalized as (typeof WORK_ITEM_TARGET_STATUSES)[number])) {
        targetWhere.status = normalized
      } else if (WORK_ITEM_STATUSES.includes(normalized as (typeof WORK_ITEM_STATUSES)[number])) {
        itemWhere.status = normalized
      } else {
        res.status(400).json({ error: 'INVALID_WORK_ITEM_STATUS', message: `Unknown WorkItem status: ${status}` })
        return
      }
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
    const items = await withTargetTemplateDiagnostics(visible)
    res.json({ items, nextCursor: exhausted ? null : nextCursor })
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
    const [diagnosed] = await withTargetTemplateDiagnostics([workItem])
    res.json(diagnosed ?? workItem)
  } catch (err) {
    next(err)
  }
})

const updateWorkItemSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  priority: z.number().int().optional(),
  dueAt: z.string().datetime().nullable().optional(),
  details: z.record(z.unknown()).optional(),
  status: z.enum(['SCHEDULED', 'QUEUED', 'IN_PROGRESS', 'CANCELLED']).optional(),
}).refine(b => Object.keys(b).length > 0, { message: 'No fields to update' })

workItemsRouter.patch('/:id', validate(updateWorkItemSchema), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof updateWorkItemSchema>
    const updated = await updateWorkItem(String(req.params.id), req.user!.userId, body)
    res.json(updated)
  } catch (err) {
    next(err)
  }
})

workItemsRouter.post('/:id/archive', async (req, res, next) => {
  try {
    const result = await archiveWorkItem(String(req.params.id), req.user!.userId)
    res.json(result)
  } catch (err) {
    next(err)
  }
})

workItemsRouter.post('/:id/detach', validate(detachSchema), async (req, res, next) => {
  try {
    const { reason } = req.body as z.infer<typeof detachSchema>
    const result = await detachWorkItemFromWorkflow(String(req.params.id), req.user!.userId, reason)
    res.json(result)
  } catch (err) {
    next(err)
  }
})

workItemsRouter.post('/:id/route', validate(routeSchema), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof routeSchema>
    const workItem = await routeWorkItem(req.params.id, req.user!.userId, body)
    res.json(workItem)
  } catch (err) {
    next(err)
  }
})

workItemsRouter.post('/:id/attach', validate(attachSchema), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof attachSchema>
    const workItem = await routeWorkItem(req.params.id, req.user!.userId, {
      ...body,
      routingMode: body.routingMode ?? 'AUTO_ATTACH',
    })
    res.json(workItem)
  } catch (err) {
    next(err)
  }
})

workItemsRouter.post('/:id/start', validate(startWorkItemSchema), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof startWorkItemSchema>
    const routed = await routeWorkItem(req.params.id, req.user!.userId, {
      targetId: body.targetId,
      workflowId: body.childWorkflowTemplateId ?? body.workflowId,
      workflowTypeKey: body.workflowTypeKey,
      routingMode: body.routingMode ?? 'AUTO_START',
      startNow: true,
    })
    res.json(routed)
  } catch (err) {
    next(err)
  }
})

workItemsRouter.post('/:id/targets/:targetId/detach', validate(detachSchema), async (req, res, next) => {
  try {
    const { reason } = req.body as z.infer<typeof detachSchema>
    const result = await detachWorkItemTargetFromWorkflow(
      String(req.params.id),
      String(req.params.targetId),
      req.user!.userId,
      reason,
    )
    res.json(result)
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
      modelAlias: body?.modelAlias,
      sourceRef: body?.sourceRef,
      sourceType: body?.sourceType,
      sourceUri: body?.sourceUri,
      cloneDir: body?.cloneDir,
      pushEachPhase: body?.pushEachPhase,
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
