import { createHash } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { currentTenantIdForDb, withTenantDbTransaction } from '../../lib/tenant-db-context'
import { logEvent, publishOutbox } from '../../lib/audit'
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors'
import { systemRouteActor } from './work-item-actors'

type FinalizeOptions = {
  approvalDecision?: string
  expectedGeneration?: number
  reason?: string
}

const SUCCESSFUL_TARGET_STATUSES = new Set(['SUBMITTED', 'APPROVED', 'ACCEPTED'])

export function isCurrentVerifiedScopeRun(
  run: {
    submissionId: string
    status: string
    reconciliationState: string
    specificationBindingId: string | null
    developmentScopeId: string | null
    handoffGenerationId: string | null
  },
  scope: { id: string; specificationBindingId: string | null; currentHandoffGenerationId: string | null },
  latestSubmissionId: string | undefined,
): boolean {
  return run.status === 'VERIFIED_PASS'
    && run.reconciliationState === 'VERIFIED'
    && run.developmentScopeId === scope.id
    && run.submissionId === latestSubmissionId
    && run.specificationBindingId === scope.specificationBindingId
    && run.handoffGenerationId === scope.currentHandoffGenerationId
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.').filter(Boolean)
  if (!parts.length) return
  let cursor = target
  for (let i = 0; i < parts.length - 1; i += 1) {
    const next = cursor[parts[i]]
    if (!next || typeof next !== 'object' || Array.isArray(next)) cursor[parts[i]] = {}
    cursor = cursor[parts[i]] as Record<string, unknown>
  }
  cursor[parts[parts.length - 1]] = value
}

function finalOutputOf(workItem: {
  id: string
  title: string
  targets: Array<{ id: string; targetCapabilityId: string; childWorkflowInstanceId: string | null; output: Prisma.JsonValue | null }>
}, approvalDecision?: string): Record<string, unknown> {
  const targetOutputs = workItem.targets.map(target => ({
    targetId: target.id,
    targetCapabilityId: target.targetCapabilityId,
    childWorkflowInstanceId: target.childWorkflowInstanceId,
    output: target.output,
  }))
  const impactedChildren = targetOutputs
    .filter(target => recordOf(recordOf(target.output).impactVerdict).impacted === true)
    .map(target => ({ targetCapabilityId: target.targetCapabilityId, childWorkflowInstanceId: target.childWorkflowInstanceId }))
  const consumableIds = targetOutputs.flatMap(target => {
    const output = recordOf(target.output)
    return Array.isArray(output.consumableIds) ? output.consumableIds.filter(id => typeof id === 'string') : []
  })
  return {
    workItemId: workItem.id,
    title: workItem.title,
    status: 'COMPLETED',
    approvalDecision,
    targetOutputs,
    impactedChildren,
    impactedCount: impactedChildren.length,
    hasImpact: impactedChildren.length > 0,
    consumableIds,
    childWorkflowInstanceIds: targetOutputs.map(target => target.childWorkflowInstanceId).filter(Boolean),
  }
}

async function releaseDependents(workItemId: string, actorId: string, tenantId: string): Promise<void> {
  const dependencies = await withTenantDbTransaction(prisma, tx => tx.workItemDependency.findMany({
    where: {
      predecessorId: workItemId,
      dependencyType: { in: ['BLOCKS', 'BLOCKS_UNTIL_SUCCESS'] },
    },
    include: { successor: { select: { id: true, workCode: true, title: true, status: true, routingMode: true, createdById: true } } },
  }), tenantId)

  for (const dependency of dependencies) {
    const remaining = await withTenantDbTransaction(prisma, tx => tx.workItemDependency.count({
      where: {
        successorId: dependency.successor.id,
        dependencyType: { in: ['BLOCKS', 'BLOCKS_UNTIL_SUCCESS'] },
        predecessor: { status: { notIn: ['COMPLETED', 'ARCHIVED'] } },
      },
    }), tenantId)
    if (remaining > 0) continue

    await withTenantDbTransaction(prisma, tx => tx.workItemEvent.create({
      data: {
        workItemId: dependency.successor.id,
        eventType: 'TRIGGERED',
        actorId,
        tenantId,
        payload: { releasedBy: workItemId, dependencyId: dependency.id } as Prisma.InputJsonValue,
      },
    }), tenantId)

    if (dependency.successor.createdById) {
      const { createNotification } = await import('../notifications/notifications.service')
      await createNotification({
        tenantId,
        userId: dependency.successor.createdById,
        kind: 'WORK_ITEM_RELEASED',
        title: 'WorkItem dependency released',
        message: `${dependency.successor.workCode} is unblocked and ready for routing.`,
        severity: 'info',
        entityType: 'WorkItem',
        entityId: dependency.successor.id,
        href: `/work-items/${dependency.successor.id}`,
        payload: { predecessorId: workItemId, dependencyId: dependency.id },
      }).catch(() => undefined)
    }

    if (['AUTO_ATTACH', 'AUTO_START'].includes(dependency.successor.routingMode)) {
      const { routeWorkItem } = await import('./work-item-routing.service')
      await routeWorkItem(dependency.successor.id, systemRouteActor('dependency-release'), {
        routingMode: dependency.successor.routingMode,
        startNow: dependency.successor.routingMode === 'AUTO_START',
      }).catch(error => logEvent('WorkItemDependencyAutoRouteFailed', 'WorkItem', dependency.successor.id, actorId, {
        error: String(error), predecessorId: workItemId,
      }))
    }
  }
}

async function advanceSourceWorkflow(workItem: {
  sourceWorkflowInstanceId: string | null
  sourceWorkflowNodeId: string | null
}, finalOutput: Record<string, unknown>, actorId: string, tenantId: string): Promise<void> {
  if (!workItem.sourceWorkflowInstanceId || !workItem.sourceWorkflowNodeId) return
  const sourceNode = await withTenantDbTransaction(prisma, tx => tx.workflowNode.findUnique({
    where: { id: workItem.sourceWorkflowNodeId! },
    select: { config: true, instance: { select: { tenantId: true } } },
  }), tenantId)
  if (!sourceNode) return
  const config = recordOf(sourceNode.config)
  const standard = recordOf(config.standard)
  const outputPath = String(standard.outputPath ?? config.outputPath ?? 'workItem').trim() || 'workItem'
  const output: Record<string, unknown> = {}
  setPath(output, outputPath, finalOutput)
  const { advance } = await import('../workflow/runtime/WorkflowRuntime')
  await advance(workItem.sourceWorkflowInstanceId, workItem.sourceWorkflowNodeId, output, actorId, undefined, sourceNode.instance.tenantId ?? tenantId)
}

/**
 * The sole WorkItem completion authority. Approval, reconciliation, and manual
 * paths must submit evidence here instead of mutating WorkItem.status directly.
 */
export async function finalizeWorkItem(workItemId: string, actorId: string, options: FinalizeOptions = {}) {
  const tenantId = currentTenantIdForDb() ?? 'default'
  const workItem = await withTenantDbTransaction(prisma, tx => tx.workItem.findUnique({
    where: { id: workItemId },
    include: {
      targets: true,
      developmentScopes: { include: { specificationBinding: true, currentHandoffGeneration: true } },
      specificationBindings: { where: { status: 'CURRENT' } },
      implementationSubmissions: {
        select: { id: true, developmentScopeId: true, repository: true, createdAt: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      },
      reconciliationRuns: { select: { id: true, submissionId: true, status: true, reconciliationState: true, generation: true, specificationBindingId: true, developmentScopeId: true, handoffGenerationId: true } },
      predecessorDependencies: { include: { predecessor: { select: { id: true, workCode: true, status: true } } } },
      clarifications: { where: { status: 'OPEN' }, select: { id: true } },
    },
  }), tenantId)
  if (!workItem) throw new NotFoundError('WorkItem', workItemId)
  if (workItem.status === 'COMPLETED') {
    return { workItemId, status: 'COMPLETED', idempotent: true, finalizationGeneration: workItem.finalizationGeneration }
  }
  if (['CANCELLED', 'ARCHIVED'].includes(workItem.status)) {
    throw new ConflictError(`WorkItem cannot be finalized from ${workItem.status}`)
  }
  if (workItem.status !== 'AWAITING_PARENT_APPROVAL') {
    throw new ConflictError(`WorkItem must be awaiting approval before finalization; current status is ${workItem.status}`)
  }
  if (!workItem.parentApprovalRequestId) throw new ValidationError('Finalization requires an approval request')
  const approvalRequestId = workItem.parentApprovalRequestId
  const approval = await withTenantDbTransaction(prisma, tx => tx.approvalRequest.findUnique({
    where: { id: approvalRequestId },
    select: { status: true, requestedById: true, tenantId: true },
  }), tenantId)
  if (!approval) throw new ValidationError('Finalization approval request no longer exists')
  if ((approval.tenantId ?? tenantId) !== (workItem.tenantId ?? tenantId)) throw new ValidationError('Finalization approval request belongs to a different tenant')
  if (!['APPROVED', 'APPROVED_WITH_CONDITIONS'].includes(String(approval.status))) {
    throw new ValidationError(`Finalization requires an approved parent request; current approval status is ${approval.status}`)
  }
  if (approval.requestedById === actorId) throw new ValidationError('The approval requester cannot finalize the same WorkItem')
  if (workItem.targets.some(target => !SUCCESSFUL_TARGET_STATUSES.has(String(target.status)))) {
    throw new ValidationError('All WorkItem targets must be submitted or accepted before finalization')
  }
  if (workItem.developmentScopes.some(scope => scope.mandatory && scope.status !== 'ACCEPTED')) {
    throw new ValidationError('All mandatory DevelopmentScopes must be accepted before finalization')
  }
  if (workItem.developmentScopes.some(scope => scope.mandatory && (!scope.specificationBinding || scope.specificationBinding.status !== 'CURRENT'))) {
    throw new ValidationError('All mandatory DevelopmentScopes must reference a current specification binding')
  }
  if (workItem.developmentScopes.some(scope => scope.mandatory && (!scope.currentHandoffGeneration || scope.currentHandoffGeneration.status !== 'PUBLISHED'))) {
    throw new ValidationError('All mandatory DevelopmentScopes must reference a published handoff generation')
  }
  if (workItem.completionPolicy === 'VERIFY_THEN_APPROVE' && workItem.developmentScopes.some(scope => scope.mandatory)) {
    const mandatoryScopes = workItem.developmentScopes.filter(scope => scope.mandatory)
    const latestSubmissionByScope = new Map<string, string>()
    for (const submission of workItem.implementationSubmissions) {
      if (submission.developmentScopeId && !latestSubmissionByScope.has(submission.developmentScopeId)) {
        latestSubmissionByScope.set(submission.developmentScopeId, submission.id)
      }
    }
    const verifiedScopes = new Set(
      workItem.reconciliationRuns
        .filter(run => {
          if (!run.developmentScopeId) return false
          const scope = workItem.developmentScopes.find(item => item.id === run.developmentScopeId)
          return Boolean(scope && isCurrentVerifiedScopeRun(run, scope, latestSubmissionByScope.get(scope.id)))
        })
        .map(run => run.developmentScopeId)
        .filter((scopeId): scopeId is string => Boolean(scopeId)),
    )
    const missing = mandatoryScopes.filter(scope => !verifiedScopes.has(scope.id))
    if (missing.length) throw new ValidationError(`Dynamic verification evidence is required for mandatory scope(s): ${missing.map(scope => scope.id).join(', ')}`)
  }
  const blockingDependencies = workItem.predecessorDependencies.filter(dependency => !['COMPLETED', 'ARCHIVED'].includes(String(dependency.predecessor.status)))
  if (blockingDependencies.length) {
    throw new ValidationError(`WorkItem is blocked by ${blockingDependencies.map(dependency => dependency.predecessor.workCode).join(', ')}`)
  }
  if (workItem.clarifications.length > 0) throw new ValidationError('Blocking WorkItem clarifications must be resolved before finalization')

  const expectedGeneration = options.expectedGeneration ?? workItem.finalizationGeneration
  if (expectedGeneration !== workItem.finalizationGeneration) throw new ConflictError('WorkItem finalization generation is stale')
  const finalOutput = finalOutputOf(workItem, options.approvalDecision)
  const evidenceDigest = createHash('sha256').update(JSON.stringify({
    workItemId,
    finalizationGeneration: expectedGeneration,
    bindings: workItem.specificationBindings.map(binding => ({ id: binding.id, generation: binding.bindingGeneration, hash: binding.resolvedContentHash })),
    scopes: workItem.developmentScopes.map(scope => ({ id: scope.id, status: scope.status, bindingId: scope.specificationBindingId, handoffId: scope.currentHandoffGenerationId })),
    submissions: workItem.implementationSubmissions.map(submission => ({ id: submission.id, scopeId: submission.developmentScopeId, repository: submission.repository, createdAt: submission.createdAt })),
    reconciliations: workItem.reconciliationRuns.map(run => ({ id: run.id, submissionId: run.submissionId, status: run.status, state: run.reconciliationState, generation: run.generation, bindingId: run.specificationBindingId, scopeId: run.developmentScopeId, handoffId: run.handoffGenerationId })),
  })).digest('hex')

  await withTenantDbTransaction(prisma, async tx => {
    const transitioned = await tx.workItem.updateMany({
      where: {
        id: workItemId,
        status: 'AWAITING_PARENT_APPROVAL',
        parentApprovalRequestId: workItem.parentApprovalRequestId,
        finalizationGeneration: expectedGeneration,
      },
      data: {
        status: 'COMPLETED',
        finalOutput: finalOutput as Prisma.InputJsonValue,
        approvedById: actorId,
        finalizationGeneration: { increment: 1 },
      },
    })
    if (transitioned.count !== 1) throw new ConflictError('WorkItem finalization is stale or has already been decided')
    await tx.workItemTarget.updateMany({
      where: { workItemId, status: { in: ['SUBMITTED', 'ACCEPTED'] } },
      data: { status: 'APPROVED', completedAt: new Date() },
    })
    await tx.workItemFinalizationRecord.create({
      data: {
        workItemId,
        finalizationGeneration: expectedGeneration,
        status: 'COMPLETED',
        actorId,
        finalOutput: finalOutput as Prisma.InputJsonValue,
        evidenceDigest,
        reason: options.reason ?? null,
        tenantId,
      },
    })
    await tx.workItemEvent.create({
      data: {
        workItemId,
        eventType: 'WORK_ITEM_FINALIZED',
        actorId,
        tenantId,
        payload: { finalizationGeneration: expectedGeneration, approvalDecision: options.approvalDecision, evidenceDigest } as Prisma.InputJsonValue,
      },
    })
    // Preserve the legacy approval event for consumers while making FINALIZED the authoritative
    // completion event. Consumers must never infer completion from APPROVED alone.
    await tx.workItemEvent.create({
      data: {
        workItemId,
        eventType: 'APPROVED',
        actorId,
        tenantId,
        payload: { finalizationGeneration: expectedGeneration, authoritativeEvent: 'WORK_ITEM_FINALIZED' } as Prisma.InputJsonValue,
      },
    })
  }, tenantId)

  await logEvent('WorkItemFinalized', 'WorkItem', workItemId, actorId, { finalizationGeneration: expectedGeneration, evidenceDigest })
  await publishOutbox('WorkItem', workItemId, 'WorkItemFinalized', { workItemId, finalizationGeneration: expectedGeneration, evidenceDigest })
  await releaseDependents(workItemId, actorId, tenantId)
  await import('../work-program/work-programs.service')
    .then(({ reconcileWorkProgramForWorkItem }) => reconcileWorkProgramForWorkItem(workItemId))
    .catch(() => undefined)
  await advanceSourceWorkflow(workItem, finalOutput, actorId, tenantId)
  return { workItemId, status: 'COMPLETED', finalizationGeneration: expectedGeneration + 1, finalOutput }
}
