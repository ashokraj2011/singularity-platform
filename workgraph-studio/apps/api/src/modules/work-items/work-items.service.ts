import { Prisma } from '@prisma/client'
import type { WorkflowInstance, WorkflowNode } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { logEvent, publishOutbox } from '../../lib/audit'
import { ForbiddenError, NotFoundError, ValidationError } from '../../lib/errors'
import { config } from '../../config'
import { authzCheck } from '../../lib/iam/client'
import { assertTemplatePermission } from '../../lib/permissions/workflowTemplate'
import { cloneDesignToRun } from '../workflow/lib/cloneDesignToRun'
import { getWorkflowBudgetOverview } from '../workflow/runtime/budget'

type KVPair = { key?: string; path?: string; value?: string }

export type WorkItemTargetInput = {
  targetCapabilityId: string
  childWorkflowTemplateId?: string
  roleKey?: string
}

export type CreateWorkItemInput = {
  title: string
  description?: string
  parentCapabilityId?: string | null
  sourceWorkflowInstanceId?: string | null
  sourceWorkflowNodeId?: string | null
  input?: Record<string, unknown>
  priority?: number
  dueAt?: string | Date | null
  targets: WorkItemTargetInput[]
}

const DONE_TARGET_STATUSES = new Set(['SUBMITTED', 'APPROVED'])

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function walk(root: Record<string, unknown>, path: string): unknown {
  return path.split('.').filter(Boolean).reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[key]
    return undefined
  }, root)
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.').filter(Boolean)
  if (parts.length === 0) return
  let cursor = target
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]
    const next = cursor[key]
    if (!next || typeof next !== 'object' || Array.isArray(next)) cursor[key] = {}
    cursor = cursor[key] as Record<string, unknown>
  }
  cursor[parts[parts.length - 1]] = value
}

function resolveRef(context: Record<string, unknown>, raw: string): unknown {
  const mustache = raw.match(/^\s*\{\{\s*(.+?)\s*\}\}\s*$/)
  const path = mustache ? mustache[1] : raw
  if (path.startsWith('vars.')) return walk(asRecord(context._vars), path.slice('vars.'.length))
  if (path.startsWith('globals.')) return walk(asRecord(context._globals), path.slice('globals.'.length))
  if (path.startsWith('params.')) return walk(asRecord(context._params), path.slice('params.'.length))
  if (path.startsWith('context.')) return walk(context, path.slice('context.'.length))
  if (path.startsWith('output.')) return walk(context, path.slice('output.'.length))
  return walk(context, path)
}

function resolveInputMap(context: Record<string, unknown>, cfg: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const base = asRecord(cfg.input)
  for (const [key, value] of Object.entries(base)) setPath(out, key, value)

  const mappings = Array.isArray(cfg.assignments) ? cfg.assignments as KVPair[] : []
  for (const pair of mappings) {
    const key = (pair.key ?? '').trim()
    const value = (pair.value ?? pair.path ?? '').trim()
    if (!key || !value) continue
    setPath(out, key, resolveRef(context, value))
  }
  return out
}

async function sourceCapabilityId(instance: WorkflowInstance): Promise<string | null> {
  if (!instance.templateId) return null
  const workflow = await prisma.workflow.findUnique({
    where: { id: instance.templateId },
    select: { capabilityId: true },
  })
  return workflow?.capabilityId ?? null
}

function normalizeTargets(cfg: Record<string, unknown>): WorkItemTargetInput[] {
  const std = asRecord(cfg.standard)
  const rows = Array.isArray(cfg.targets) ? cfg.targets
    : Array.isArray(cfg.workItemTargets) ? cfg.workItemTargets
    : []

  const targets = rows
    .map(row => asRecord(row))
    .map(row => ({
      targetCapabilityId: String(row.targetCapabilityId ?? row.capabilityId ?? '').trim(),
      childWorkflowTemplateId: String(row.childWorkflowTemplateId ?? row.templateId ?? '').trim() || undefined,
      roleKey: String(row.roleKey ?? '').trim() || undefined,
    }))
    .filter(row => row.targetCapabilityId)

  const singleTarget = String(std.targetCapabilityId ?? cfg.targetCapabilityId ?? '').trim()
  if (targets.length === 0 && singleTarget) {
    targets.push({
      targetCapabilityId: singleTarget,
      childWorkflowTemplateId: String(std.childWorkflowTemplateId ?? std.templateId ?? cfg.childWorkflowTemplateId ?? cfg.templateId ?? '').trim() || undefined,
      roleKey: String(std.roleKey ?? cfg.roleKey ?? '').trim() || undefined,
    })
  }
  return targets
}

export async function createWorkItem(input: CreateWorkItemInput, actorId?: string | null) {
  if (input.targets.length === 0) throw new ValidationError('WorkItem requires at least one child capability target')
  const dueAt = input.dueAt ? new Date(input.dueAt) : undefined

  const workItem = await prisma.workItem.create({
    data: {
      title: input.title,
      description: input.description,
      parentCapabilityId: input.parentCapabilityId ?? undefined,
      sourceWorkflowInstanceId: input.sourceWorkflowInstanceId ?? undefined,
      sourceWorkflowNodeId: input.sourceWorkflowNodeId ?? undefined,
      input: (input.input ?? {}) as Prisma.InputJsonValue,
      priority: input.priority ?? 50,
      dueAt,
      createdById: actorId ?? undefined,
      targets: {
        create: input.targets.map(target => ({
          targetCapabilityId: target.targetCapabilityId,
          childWorkflowTemplateId: target.childWorkflowTemplateId,
          roleKey: target.roleKey,
        })),
      },
    },
    include: { targets: true, events: true },
  })

  await prisma.workItemEvent.create({
    data: {
      workItemId: workItem.id,
      eventType: 'created',
      actorId: actorId ?? undefined,
      payload: { targetCount: workItem.targets.length } as Prisma.InputJsonValue,
    },
  })
  await logEvent('WorkItemCreated', 'WorkItem', workItem.id, actorId ?? undefined, {
    parentCapabilityId: input.parentCapabilityId,
    sourceWorkflowInstanceId: input.sourceWorkflowInstanceId,
    sourceWorkflowNodeId: input.sourceWorkflowNodeId,
    targetCount: workItem.targets.length,
  })
  await publishOutbox('WorkItem', workItem.id, 'WorkItemCreated', { workItemId: workItem.id })
  return workItem
}

export async function activateWorkItem(node: WorkflowNode, instance: WorkflowInstance, actorId?: string): Promise<void> {
  const cfg = asRecord(node.config)
  if (typeof cfg._workItemId === 'string' && cfg._workItemId) return

  const std = asRecord(cfg.standard)
  const targets = normalizeTargets(cfg)
  const parentCapabilityId = await sourceCapabilityId(instance)
  const title = String(std.title ?? cfg.title ?? node.label ?? 'Delegated work item').trim()
  const description = String(std.description ?? cfg.description ?? '').trim() || undefined
  const priority = Number(std.priority ?? cfg.priority ?? 50)
  const dueAtRaw = std.dueAt ?? cfg.dueAt
  const input = resolveInputMap(asRecord(instance.context), cfg)

  const workItem = await createWorkItem({
    title,
    description,
    parentCapabilityId,
    sourceWorkflowInstanceId: instance.id,
    sourceWorkflowNodeId: node.id,
    input,
    priority: Number.isFinite(priority) ? priority : 50,
    dueAt: typeof dueAtRaw === 'string' ? dueAtRaw : null,
    targets,
  }, actorId ?? instance.createdById ?? null)

  await prisma.workflowNode.update({
    where: { id: node.id },
    data: { config: { ...cfg, _workItemId: workItem.id } as Prisma.InputJsonValue },
  })
}

async function loadActor(userId: string) {
  return prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, iamUserId: true, roles: { include: { role: { select: { name: true } } } } },
  })
}

export async function assertCanClaimWorkItemTarget(userId: string, targetCapabilityId: string, resourceId: string): Promise<void> {
  if (config.AUTH_PROVIDER !== 'iam') return
  const actor = await loadActor(userId)
  const isAdmin = actor?.roles.some(r => ['ADMIN', 'SYSTEM_ADMIN', 'WORKFLOW_ADMIN'].includes(r.role.name)) ?? false
  if (isAdmin) return
  if (!actor?.iamUserId) throw new ForbiddenError('IAM identity is required to claim this WorkItem')
  const result = await authzCheck(actor.iamUserId, targetCapabilityId, 'claim_task', {
    resourceType: 'WorkItemTarget',
    resourceId,
  })
  if (!result.allowed) throw new ForbiddenError('User is not eligible to claim WorkItems for this capability')
}

type WorkItemViewRow = {
  id: string
  parentCapabilityId: string | null
  createdById: string | null
  approvedById?: string | null
  targets: Array<{
    id: string
    targetCapabilityId: string
    claimedById: string | null
  }>
}

export async function canViewWorkItem(userId: string, workItem: WorkItemViewRow): Promise<boolean> {
  if (config.AUTH_PROVIDER !== 'iam') return true
  if (workItem.createdById === userId || workItem.approvedById === userId) return true
  if (workItem.targets.some(t => t.claimedById === userId)) return true

  const actor = await loadActor(userId)
  const isAdmin = actor?.roles.some(r => ['ADMIN', 'SYSTEM_ADMIN', 'WORKFLOW_ADMIN'].includes(r.role.name)) ?? false
  if (isAdmin) return true
  if (!actor?.iamUserId) return false

  for (const target of workItem.targets) {
    const result = await authzCheck(actor.iamUserId, target.targetCapabilityId, 'claim_task', {
      resourceType: 'WorkItemTarget',
      resourceId: target.id,
    }).catch(() => ({ allowed: false }))
    if (result.allowed) return true
  }
  return false
}

export async function assertCanViewWorkItem(userId: string, workItem: WorkItemViewRow): Promise<void> {
  if (!(await canViewWorkItem(userId, workItem))) {
    throw new ForbiddenError('User is not eligible to view this WorkItem')
  }
}

export async function claimWorkItemTarget(workItemId: string, targetId: string, userId: string) {
  const target = await prisma.workItemTarget.findFirst({
    where: { id: targetId, workItemId },
    include: { workItem: true },
  })
  if (!target) throw new NotFoundError('WorkItemTarget', targetId)
  if (target.claimedById && target.claimedById !== userId) throw new ValidationError('WorkItem target is already claimed')
  if (!['QUEUED', 'REWORK_REQUESTED'].includes(target.status) && target.claimedById !== userId) {
    throw new ValidationError(`WorkItem target cannot be claimed from status ${target.status}`)
  }
  await assertCanClaimWorkItemTarget(userId, target.targetCapabilityId, target.id)

  const updated = await prisma.workItemTarget.update({
    where: { id: target.id },
    data: { status: 'CLAIMED', claimedById: userId, claimedAt: new Date() },
  })
  await prisma.workItem.update({ where: { id: workItemId }, data: { status: 'IN_PROGRESS' } })
  await prisma.workItemEvent.create({
    data: { workItemId, targetId, eventType: 'claimed', actorId: userId },
  })
  await logEvent('WorkItemTargetClaimed', 'WorkItemTarget', targetId, userId, { workItemId })
  await publishOutbox('WorkItemTarget', targetId, 'WorkItemTargetClaimed', { workItemId, targetId })
  return updated
}

export async function startWorkItemTarget(workItemId: string, targetId: string, userId: string) {
  const target = await prisma.workItemTarget.findFirst({
    where: { id: targetId, workItemId },
    include: { workItem: true },
  })
  if (!target) throw new NotFoundError('WorkItemTarget', targetId)
  if (target.claimedById !== userId) throw new ValidationError('Claim this WorkItem target before starting it')
  if (!target.childWorkflowTemplateId) throw new ValidationError('This WorkItem target has no child workflow template configured')
  if (target.childWorkflowInstanceId) throw new ValidationError('This WorkItem target already has a child workflow run')

  await assertTemplatePermission(userId, target.childWorkflowTemplateId, 'start')
  const vars = {
    ...asRecord(target.workItem.input),
    workItemId,
    workItemTargetId: targetId,
    parentCapabilityId: target.workItem.parentCapabilityId,
    targetCapabilityId: target.targetCapabilityId,
  }
  const result = await cloneDesignToRun({
    templateId: target.childWorkflowTemplateId,
    name: `${target.workItem.title} · ${target.targetCapabilityId.slice(0, 8)}`,
    vars,
    createdById: userId,
  })

  const instance = await prisma.workflowInstance.findUniqueOrThrow({ where: { id: result.instance.id } })
  const context = asRecord(instance.context)
  context._workItem = {
    id: workItemId,
    targetId,
    parentCapabilityId: target.workItem.parentCapabilityId,
    targetCapabilityId: target.targetCapabilityId,
    sourceWorkflowInstanceId: target.workItem.sourceWorkflowInstanceId,
    sourceWorkflowNodeId: target.workItem.sourceWorkflowNodeId,
    input: target.workItem.input,
  }
  await prisma.workflowInstance.update({
    where: { id: result.instance.id },
    data: { context: context as Prisma.InputJsonValue },
  })

  const updated = await prisma.workItemTarget.update({
    where: { id: target.id },
    data: {
      status: 'IN_PROGRESS',
      childWorkflowInstanceId: result.instance.id,
      startedAt: new Date(),
    },
  })
  await prisma.workItemEvent.create({
    data: {
      workItemId,
      targetId,
      eventType: 'started',
      actorId: userId,
      payload: { childWorkflowInstanceId: result.instance.id } as Prisma.InputJsonValue,
    },
  })
  await logEvent('WorkItemTargetStarted', 'WorkItemTarget', targetId, userId, {
    workItemId,
    childWorkflowInstanceId: result.instance.id,
  })

  const { startInstance } = await import('../workflow/runtime/WorkflowRuntime')
  await startInstance(result.instance.id, userId)
  return { target: updated, childWorkflowInstanceId: result.instance.id }
}

async function buildChildOutput(instance: WorkflowInstance): Promise<Record<string, unknown>> {
  const [consumables, budget] = await Promise.all([
    prisma.consumable.findMany({
      where: { instanceId: instance.id },
      select: { id: true, name: true, status: true, currentVersion: true, nodeId: true, formData: true },
      orderBy: { updatedAt: 'desc' },
    }),
    getWorkflowBudgetOverview(instance.id).catch(() => null),
  ])
  const ctx = asRecord(instance.context)
  const finalSummary = ctx.finalSummary ?? walk(ctx, 'workbench.finalPack') ?? ctx.summary ?? ctx.result ?? null
  return {
    childWorkflowInstanceId: instance.id,
    finalSummary,
    consumables,
    consumableIds: consumables.map(c => c.id),
    budget,
    completedAt: instance.completedAt?.toISOString() ?? new Date().toISOString(),
  }
}

export async function handleWorkItemChildCompletion(instance: WorkflowInstance, actorId?: string): Promise<void> {
  const ctx = asRecord(instance.context)
  const workItemRef = asRecord(ctx._workItem)
  const targetId = typeof workItemRef.targetId === 'string' ? workItemRef.targetId : null
  const target = await prisma.workItemTarget.findFirst({
    where: {
      OR: [
        ...(targetId ? [{ id: targetId }] : []),
        { childWorkflowInstanceId: instance.id },
      ],
    },
    include: { workItem: { include: { targets: true } } },
  })
  if (!target || DONE_TARGET_STATUSES.has(target.status) || target.status === 'CANCELLED') return

  const output = await buildChildOutput(instance)
  await prisma.workItemTarget.update({
    where: { id: target.id },
    data: { status: 'SUBMITTED', output: output as Prisma.InputJsonValue, submittedAt: new Date() },
  })
  await prisma.workItemEvent.create({
    data: {
      workItemId: target.workItemId,
      targetId: target.id,
      eventType: 'submitted',
      actorId,
      payload: output as Prisma.InputJsonValue,
    },
  })
  await logEvent('WorkItemTargetSubmitted', 'WorkItemTarget', target.id, actorId, {
    workItemId: target.workItemId,
    childWorkflowInstanceId: instance.id,
  })
  await maybeRequestParentApproval(target.workItemId, actorId)
}

async function maybeRequestParentApproval(workItemId: string, actorId?: string): Promise<void> {
  const workItem = await prisma.workItem.findUnique({
    where: { id: workItemId },
    include: { targets: true },
  })
  if (!workItem || workItem.parentApprovalRequestId || workItem.status === 'COMPLETED') return
  if (!workItem.targets.every(t => DONE_TARGET_STATUSES.has(t.status))) return

  const submittedTargets = workItem.targets.map(t => ({
    targetId: t.id,
    targetCapabilityId: t.targetCapabilityId,
    childWorkflowInstanceId: t.childWorkflowInstanceId,
    output: t.output,
  }))
  const approval = await prisma.approvalRequest.create({
    data: {
      instanceId: workItem.sourceWorkflowInstanceId ?? undefined,
      nodeId: workItem.sourceWorkflowNodeId ?? undefined,
      subjectType: 'WorkItem',
      subjectId: workItem.id,
      requestedById: actorId ?? workItem.createdById ?? 'system',
      assignedToId: workItem.createdById ?? undefined,
      assignmentMode: workItem.createdById ? 'DIRECT_USER' : 'ROLE_BASED',
      capabilityId: workItem.parentCapabilityId ?? undefined,
      roleKey: workItem.createdById ? undefined : 'owner',
      formData: { workItemId: workItem.id, targets: submittedTargets } as Prisma.InputJsonValue,
    },
  })
  await prisma.workItem.update({
    where: { id: workItem.id },
    data: { status: 'AWAITING_PARENT_APPROVAL', parentApprovalRequestId: approval.id },
  })
  await prisma.workItemEvent.create({
    data: {
      workItemId: workItem.id,
      eventType: 'approval_requested',
      actorId,
      payload: { approvalRequestId: approval.id } as Prisma.InputJsonValue,
    },
  })
  await logEvent('WorkItemApprovalRequested', 'WorkItem', workItem.id, actorId, {
    approvalRequestId: approval.id,
  })
  await publishOutbox('WorkItem', workItem.id, 'WorkItemApprovalRequested', {
    workItemId: workItem.id,
    approvalRequestId: approval.id,
  })
}

export async function approveWorkItem(workItemId: string, userId: string, approvalDecision?: string) {
  const workItem = await prisma.workItem.findUnique({
    where: { id: workItemId },
    include: { targets: true },
  })
  if (!workItem) throw new NotFoundError('WorkItem', workItemId)

  const targetOutputs = workItem.targets.map(t => ({
    targetId: t.id,
    targetCapabilityId: t.targetCapabilityId,
    childWorkflowInstanceId: t.childWorkflowInstanceId,
    output: t.output,
  }))
  const consumableIds = targetOutputs.flatMap(t => {
    const output = asRecord(t.output)
    return Array.isArray(output.consumableIds) ? output.consumableIds.filter(id => typeof id === 'string') : []
  })
  const finalOutput = {
    workItemId,
    title: workItem.title,
    status: 'COMPLETED',
    approvalDecision,
    targetOutputs,
    consumableIds,
    childWorkflowInstanceIds: targetOutputs.map(t => t.childWorkflowInstanceId).filter(Boolean),
  }

  await prisma.$transaction([
    prisma.workItem.update({
      where: { id: workItemId },
      data: {
        status: 'COMPLETED',
        finalOutput: finalOutput as Prisma.InputJsonValue,
        approvedById: userId,
      },
    }),
    prisma.workItemTarget.updateMany({
      where: { workItemId, status: 'SUBMITTED' },
      data: { status: 'APPROVED', completedAt: new Date() },
    }),
    prisma.workItemEvent.create({
      data: {
        workItemId,
        eventType: 'approved',
        actorId: userId,
        payload: { approvalDecision } as Prisma.InputJsonValue,
      },
    }),
  ])
  await logEvent('WorkItemApproved', 'WorkItem', workItemId, userId, { approvalDecision })
  await publishOutbox('WorkItem', workItemId, 'WorkItemApproved', { workItemId })

  if (workItem.sourceWorkflowInstanceId && workItem.sourceWorkflowNodeId) {
    const sourceNode = await prisma.workflowNode.findUnique({
      where: { id: workItem.sourceWorkflowNodeId },
      select: { config: true },
    })
    const cfg = asRecord(sourceNode?.config)
    const outputPath = String(asRecord(cfg.standard).outputPath ?? cfg.outputPath ?? 'workItem').trim() || 'workItem'
    const advanceOutput: Record<string, unknown> = {}
    setPath(advanceOutput, outputPath, finalOutput)
    const { advance } = await import('../workflow/runtime/WorkflowRuntime')
    await advance(workItem.sourceWorkflowInstanceId, workItem.sourceWorkflowNodeId, advanceOutput, userId)
  }
  return finalOutput
}

export async function requestWorkItemRework(workItemId: string, userId: string, targetIds?: string[], reason?: string) {
  const workItem = await prisma.workItem.findUnique({ where: { id: workItemId }, include: { targets: true } })
  if (!workItem) throw new NotFoundError('WorkItem', workItemId)
  const selected = targetIds && targetIds.length > 0
    ? targetIds
    : workItem.targets.filter(t => t.status === 'SUBMITTED' || t.status === 'APPROVED').map(t => t.id)
  if (selected.length === 0) throw new ValidationError('No submitted WorkItem targets are available for rework')

  await prisma.$transaction([
    prisma.workItem.update({
      where: { id: workItemId },
      data: { status: 'IN_PROGRESS', parentApprovalRequestId: null },
    }),
    prisma.workItemTarget.updateMany({
      where: { workItemId, id: { in: selected } },
      data: {
        status: 'REWORK_REQUESTED',
        claimedById: null,
        claimedAt: null,
        submittedAt: null,
      },
    }),
    prisma.workItemEvent.create({
      data: {
        workItemId,
        eventType: 'rework_requested',
        actorId: userId,
        payload: { targetIds: selected, reason } as Prisma.InputJsonValue,
      },
    }),
  ])
  await logEvent('WorkItemReworkRequested', 'WorkItem', workItemId, userId, { targetIds: selected, reason })
  await publishOutbox('WorkItem', workItemId, 'WorkItemReworkRequested', { workItemId, targetIds: selected })
  return { workItemId, targetIds: selected, status: 'IN_PROGRESS' }
}
