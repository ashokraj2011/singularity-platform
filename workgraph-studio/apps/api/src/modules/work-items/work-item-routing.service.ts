import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { logEvent, publishOutbox } from '../../lib/audit'
import { NotFoundError, ValidationError } from '../../lib/errors'
import { cloneDesignToRun } from '../workflow/lib/cloneDesignToRun'
import { normalizeMetadataKey, recordOf } from '../metadata/metadata.service'
// Security (finding #3) — actor authorization for routing/starting. work-items.service
// imports THIS module dynamically (await import), so this static import creates no cycle.
import { assertCanClaimWorkItemTarget } from './work-items.service'
import { assertTemplatePermission } from '../../lib/permissions/workflowTemplate'

type RoutingMode = 'MANUAL' | 'AUTO_ATTACH' | 'AUTO_START' | 'SCHEDULED_START'

function dateReady(value: Date | null | undefined, now = new Date()): boolean {
  return !value || value.valueOf() <= now.valueOf()
}

async function choosePolicy(args: {
  capabilityId: string
  workItemTypeKey: string
  workflowTypeKey?: string | null
}) {
  return prisma.workItemRoutingPolicy.findFirst({
    where: {
      capabilityId: args.capabilityId,
      workItemTypeKey: args.workItemTypeKey,
      isActive: true,
      ...(args.workflowTypeKey ? { workflowTypeKey: args.workflowTypeKey } : {}),
    },
    orderBy: [{ priority: 'desc' }, { updatedAt: 'desc' }],
  })
}

async function chooseWorkflow(args: {
  capabilityId: string
  workItemTypeKey: string
  workflowTypeKey?: string | null
  workflowId?: string | null
}) {
  if (args.workflowId) {
    return prisma.workflow.findFirst({
      // Security (finding #3): a caller-supplied workflowId MUST belong to the target
      // capability — otherwise a work item could attach/start an unrelated capability's
      // workflow. A foreign id now resolves to null → the ROUTE_FAILED path.
      where: { id: args.workflowId, capabilityId: args.capabilityId, archivedAt: null },
      select: { id: true, name: true, workflowTypeKey: true, defaultRoutingMode: true },
    })
  }
  const workflowTypeKey = normalizeMetadataKey(args.workflowTypeKey ?? args.workItemTypeKey)
  return prisma.workflow.findFirst({
    where: {
      capabilityId: args.capabilityId,
      archivedAt: null,
      status: { not: 'ARCHIVED' },
      workflowTypeKey: { in: [workflowTypeKey, 'GENERAL'] },
    },
    orderBy: [{ isDefaultForType: 'desc' }, { updatedAt: 'desc' }],
    select: { id: true, name: true, workflowTypeKey: true, defaultRoutingMode: true },
  })
}

async function startAttachedTarget(args: {
  workItemId: string
  targetId: string
  actorId?: string | null
}) {
  const target = await prisma.workItemTarget.findFirst({
    where: { id: args.targetId, workItemId: args.workItemId },
    include: { workItem: true },
  })
  if (!target) throw new NotFoundError('WorkItemTarget', args.targetId)
  const templateId = target.childWorkflowTemplateId
  if (!templateId) throw new ValidationError('WorkItem target is not attached to a workflow template')
  if (target.childWorkflowInstanceId) return { childWorkflowInstanceId: target.childWorkflowInstanceId }

  // Finding #10 — atomically reserve the target before cloning so two concurrent starts
  // can't both create a run. Postgres serialises the conditional UPDATE, so exactly one
  // request flips startedAt while the link is still null; the loser returns the winner's
  // link (or errors if the winner hasn't linked it yet).
  const reservation = await prisma.workItemTarget.updateMany({
    where: { id: args.targetId, workItemId: args.workItemId, childWorkflowInstanceId: null, startedAt: null },
    data: { startedAt: new Date() },
  })
  if (reservation.count === 0) {
    const current = await prisma.workItemTarget.findFirst({
      where: { id: args.targetId, workItemId: args.workItemId },
      select: { childWorkflowInstanceId: true },
    })
    if (current?.childWorkflowInstanceId) return { childWorkflowInstanceId: current.childWorkflowInstanceId }
    throw new ValidationError('WorkItem target is already being started')
  }

  const vars = {
    ...recordOf(target.workItem.input),
    workItemId: args.workItemId,
    workCode: target.workItem.workCode,
    workItemTargetId: args.targetId,
    workItemTypeKey: target.workItem.workItemTypeKey,
    routingMode: target.workItem.routingMode,
    parentCapabilityId: target.workItem.parentCapabilityId,
    targetCapabilityId: target.targetCapabilityId,
    workItemUrgency: target.workItem.urgency,
    workItemRequiredBy: target.workItem.requiredBy?.toISOString(),
    workItemDetails: target.workItem.details,
    workItemBudget: target.workItem.budget,
  }
  const result = await (async () => {
    try {
      return await cloneDesignToRun({
        templateId,
        name: `${target.workItem.workCode} · ${target.workItem.title}`,
        vars,
        createdById: args.actorId ?? undefined,
      })
    } catch (err) {
      // Release the reservation so a later retry can start this target.
      await prisma.workItemTarget.updateMany({
        where: { id: args.targetId, childWorkflowInstanceId: null },
        data: { startedAt: null },
      })
      throw err
    }
  })()

  const instance = await prisma.workflowInstance.findUniqueOrThrow({ where: { id: result.instance.id } })
  const context = recordOf(instance.context)
  context._workItem = {
    id: args.workItemId,
    workCode: target.workItem.workCode,
    targetId: args.targetId,
    workItemTypeKey: target.workItem.workItemTypeKey,
    routingMode: target.workItem.routingMode,
    originType: target.workItem.originType,
    parentCapabilityId: target.workItem.parentCapabilityId,
    targetCapabilityId: target.targetCapabilityId,
    sourceWorkflowInstanceId: target.workItem.sourceWorkflowInstanceId,
    sourceWorkflowNodeId: target.workItem.sourceWorkflowNodeId,
    input: target.workItem.input,
    details: target.workItem.details,
    budget: target.workItem.budget,
    urgency: target.workItem.urgency,
    requiredBy: target.workItem.requiredBy?.toISOString(),
    detailsLocked: target.workItem.detailsLocked,
  }
  await prisma.workflowInstance.update({
    where: { id: result.instance.id },
    data: { context: context as Prisma.InputJsonValue },
  })
  await prisma.workItemTarget.update({
    where: { id: args.targetId },
    data: {
      status: 'IN_PROGRESS',
      claimedById: target.claimedById ?? args.actorId ?? null,
      claimedAt: target.claimedAt ?? new Date(),
      childWorkflowInstanceId: result.instance.id,
      startedAt: new Date(),
    },
  })
  await prisma.workItem.update({
    where: { id: args.workItemId },
    data: { status: 'IN_PROGRESS', routingState: 'STARTED' },
  })
  await prisma.workItemEvent.create({
    data: {
      workItemId: args.workItemId,
      targetId: args.targetId,
      eventType: 'AUTO_STARTED',
      actorId: args.actorId ?? undefined,
      payload: { childWorkflowInstanceId: result.instance.id, childWorkflowTemplateId: templateId } as Prisma.InputJsonValue,
    },
  })
  await logEvent('WorkItemAutoStarted', 'WorkItem', args.workItemId, args.actorId ?? undefined, {
    targetId: args.targetId,
    childWorkflowInstanceId: result.instance.id,
    childWorkflowTemplateId: templateId,
  })
  const { startInstance } = await import('../workflow/runtime/WorkflowRuntime')
  await startInstance(result.instance.id, args.actorId ?? undefined)
  return { childWorkflowInstanceId: result.instance.id }
}

export async function routeWorkItem(
  workItemId: string,
  actorId?: string | null,
  options: {
    targetId?: string
    workflowId?: string
    workflowTypeKey?: string
    routingMode?: RoutingMode
    startNow?: boolean
  } = {},
) {
  const workItem = await prisma.workItem.findUnique({
    where: { id: workItemId },
    include: { targets: { orderBy: { createdAt: 'asc' } } },
  })
  if (!workItem) throw new NotFoundError('WorkItem', workItemId)
  if (workItem.status === 'ARCHIVED' || workItem.status === 'COMPLETED') {
    throw new ValidationError(`WorkItem cannot be routed from status ${workItem.status}`)
  }
  const target = options.targetId
    ? workItem.targets.find(t => t.id === options.targetId)
    : workItem.targets[0]
  if (!target) throw new ValidationError('WorkItem has no target capability to route')

  // Security (finding #3): a real user routing/attaching/starting must be authorized to
  // act in the target capability. Internal automation (WORK_ITEM node, triggers,
  // scheduler) calls with actorId=null and is exempt; the check also no-ops when
  // AUTH_PROVIDER !== 'iam'.
  if (actorId) {
    await assertCanClaimWorkItemTarget(actorId, target.targetCapabilityId, target.id)
  }

  const mode = options.routingMode ?? workItem.routingMode
  if (mode === 'SCHEDULED_START' && (!dateReady(workItem.scheduledAt) || !dateReady(workItem.notBefore))) {
    await prisma.workItem.update({ where: { id: workItemId }, data: { status: 'SCHEDULED' } })
    await prisma.workItemEvent.create({
      data: {
        workItemId,
        targetId: target.id,
        eventType: 'SCHEDULED',
        actorId: actorId ?? undefined,
        payload: { scheduledAt: workItem.scheduledAt?.toISOString(), notBefore: workItem.notBefore?.toISOString() } as Prisma.InputJsonValue,
      },
    })
    return prisma.workItem.findUniqueOrThrow({ where: { id: workItemId }, include: { targets: true, events: true } })
  }

  const workflowTypeKey = normalizeMetadataKey(options.workflowTypeKey ?? recordOf(workItem.details).workflowTypeKey ?? workItem.workItemTypeKey)
  const policy = await choosePolicy({
    capabilityId: target.targetCapabilityId,
    workItemTypeKey: workItem.workItemTypeKey,
    workflowTypeKey: options.workflowTypeKey,
  })
  const workflow = await chooseWorkflow({
    capabilityId: target.targetCapabilityId,
    workItemTypeKey: workItem.workItemTypeKey,
    workflowTypeKey: options.workflowTypeKey ?? policy?.workflowTypeKey ?? workflowTypeKey,
    workflowId: options.workflowId ?? policy?.workflowId,
  })

  if (!workflow) {
    const failed = await prisma.workItem.update({
      where: { id: workItemId },
      data: {
        routingState: 'ROUTE_FAILED',
        routingPolicyId: policy?.id ?? null,
        details: {
          ...recordOf(workItem.details),
          routingFailure: {
            targetCapabilityId: target.targetCapabilityId,
            workItemTypeKey: workItem.workItemTypeKey,
            workflowTypeKey,
            failedAt: new Date().toISOString(),
          },
        } as Prisma.InputJsonValue,
      },
      include: { targets: true, events: true },
    })
    await prisma.workItemEvent.create({
      data: {
        workItemId,
        targetId: target.id,
        eventType: 'ROUTE_FAILED',
        actorId: actorId ?? undefined,
        payload: { targetCapabilityId: target.targetCapabilityId, workItemTypeKey: workItem.workItemTypeKey, workflowTypeKey } as Prisma.InputJsonValue,
      },
    })
    await logEvent('WorkItemRouteFailed', 'WorkItem', workItemId, actorId ?? undefined, {
      targetCapabilityId: target.targetCapabilityId,
      workItemTypeKey: workItem.workItemTypeKey,
      workflowTypeKey,
    })
    return failed
  }

  // Security (finding #3): the AUTO_START / startNow path must enforce the same 'start'
  // template permission as the manual path (startWorkItemTarget); checked before attach
  // so an unauthorized start does not even attach. Internal automation (actorId=null) exempt.
  if ((options.startNow || mode === 'AUTO_START') && actorId) {
    await assertTemplatePermission(actorId, workflow.id, 'start')
  }

  await prisma.$transaction(async tx => {
    await tx.workItemTarget.update({
      where: { id: target.id },
      data: { childWorkflowTemplateId: workflow.id },
    })
    await tx.workItem.update({
      where: { id: workItemId },
      data: {
        routingMode: mode,
        routingState: 'ATTACHED',
        routingPolicyId: policy?.id ?? null,
        status: workItem.status === 'SCHEDULED' ? 'QUEUED' : workItem.status,
        details: {
          ...recordOf(workItem.details),
          workflowTypeKey: workflow.workflowTypeKey,
          routedWorkflowId: workflow.id,
          routedWorkflowName: workflow.name,
        } as Prisma.InputJsonValue,
      },
    })
    await tx.workItemEvent.create({
      data: {
        workItemId,
        targetId: target.id,
        eventType: 'ROUTED',
        actorId: actorId ?? undefined,
        payload: {
          policyId: policy?.id,
          routingMode: mode,
          targetCapabilityId: target.targetCapabilityId,
          childWorkflowTemplateId: workflow.id,
          workflowTypeKey: workflow.workflowTypeKey,
        } as Prisma.InputJsonValue,
      },
    })
    await tx.workItemEvent.create({
      data: {
        workItemId,
        targetId: target.id,
        eventType: 'ATTACHED',
        actorId: actorId ?? undefined,
        payload: { childWorkflowTemplateId: workflow.id, workflowTypeKey: workflow.workflowTypeKey } as Prisma.InputJsonValue,
      },
    })
  })
  await logEvent('WorkItemRouted', 'WorkItem', workItemId, actorId ?? undefined, {
    targetId: target.id,
    policyId: policy?.id,
    routingMode: mode,
    childWorkflowTemplateId: workflow.id,
  })
  await publishOutbox('WorkItem', workItemId, 'WorkItemRouted', { workItemId, targetId: target.id, workflowId: workflow.id })

  if (options.startNow || mode === 'AUTO_START') {
    await startAttachedTarget({ workItemId, targetId: target.id, actorId })
  }

  return prisma.workItem.findUniqueOrThrow({
    where: { id: workItemId },
    include: { targets: { orderBy: { createdAt: 'asc' } }, events: { orderBy: { createdAt: 'asc' } } },
  })
}
