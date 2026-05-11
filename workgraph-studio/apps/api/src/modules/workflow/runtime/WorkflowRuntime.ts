import { Prisma } from '@prisma/client'
import type { WorkflowInstance, WorkflowNode } from '@prisma/client'
import { prisma } from '../../../lib/prisma'
import { logEvent, createReceipt, publishOutbox } from '../../../lib/audit'
import { ValidationError } from '../../../lib/errors'
import { resolveNextNodes, isComplete } from './GraphTraverser'
import { activateHumanTask } from './executors/HumanTaskExecutor'
import { activateAgentTask } from './executors/AgentTaskExecutor'
import { activateApproval } from './executors/ApprovalExecutor'
import { activateDecisionGate } from './executors/DecisionGateExecutor'
import { activateConsumableCreation } from './executors/ConsumableCreationExecutor'
import { activateToolRequest } from './executors/ToolRequestExecutor'
import { activatePolicyCheck } from './executors/PolicyCheckExecutor'
import { activateTimer } from './executors/TimerExecutor'
import { activateSignalWait } from './executors/SignalWaitExecutor'
import { activateCallWorkflow } from './executors/CallWorkflowExecutor'
import { activateForeach } from './executors/ForeachExecutor'
import { activateInclusiveGateway } from './executors/InclusiveGatewayExecutor'
import { activateEventGateway } from './executors/EventGatewayExecutor'
import { activateDataSink } from './executors/DataSinkExecutor'
import { activateParallelFork } from './executors/ParallelForkExecutor'
import { activateParallelJoin } from './executors/ParallelJoinExecutor'
import { activateSignalEmit } from './executors/SignalEmitExecutor'
import { activateSetContext } from './executors/SetContextExecutor'
import { activateErrorCatch } from './executors/ErrorCatchExecutor'

type PendingAdvance = { nodeId: string }

type ArtifactBinding = {
  id?: string
  name?: string
  bindingPath?: string
  required?: boolean
}

/**
 * For each OUTPUT artifact with a bindingPath, write the corresponding output
 * field into context at that path. Looks up the output value first by artifact
 * name, then by its `id`.
 */
function applyOutputBindings(
  context: Record<string, unknown>,
  node: { config: unknown },
  output: Record<string, unknown>,
): void {
  const cfg = (node.config ?? {}) as Record<string, unknown>
  const outputs = Array.isArray(cfg.outputArtifacts) ? cfg.outputArtifacts as ArtifactBinding[] : []

  for (const a of outputs) {
    const path = typeof a.bindingPath === 'string' ? a.bindingPath.trim() : ''
    if (!path) continue
    const value = (a.name && a.name in output) ? output[a.name]
                : (a.id && a.id in output) ? output[a.id]
                : undefined
    if (value === undefined) continue
    setPath(context, path, value)
  }
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.').filter(Boolean)
  if (segments.length === 0) return
  let cursor: Record<string, unknown> = target
  for (let i = 0; i < segments.length - 1; i++) {
    const key = segments[i]
    const next = cursor[key]
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      cursor[key] = {}
    }
    cursor = cursor[key] as Record<string, unknown>
  }
  cursor[segments[segments.length - 1]] = value
}

export async function advance(
  instanceId: string,
  completedNodeId: string,
  output: Record<string, unknown>,
  actorId?: string,
): Promise<void> {
  const instance = await prisma.workflowInstance.findUniqueOrThrow({ where: { id: instanceId } })
  const completedNode = await prisma.workflowNode.findUniqueOrThrow({ where: { id: completedNodeId } })

  const beforeStatus = completedNode.status

  // 1. Mark node COMPLETED + write mutation
  await prisma.$transaction([
    prisma.workflowNode.update({
      where: { id: completedNodeId },
      data: { status: 'COMPLETED' },
    }),
    prisma.workflowMutation.create({
      data: {
        instanceId,
        nodeId: completedNodeId,
        mutationType: 'NODE_STATUS_CHANGE',
        beforeState: { status: beforeStatus } as unknown as Prisma.InputJsonValue,
        afterState: { status: 'COMPLETED', output } as unknown as Prisma.InputJsonValue,
        performedById: actorId,
      },
    }),
  ])

  await logEvent('WorkflowNodeCompleted', 'WorkflowNode', completedNodeId, actorId, {
    instanceId,
    output,
  })
  await publishOutbox('WorkflowNode', completedNodeId, 'NodeCompleted', { instanceId, nodeId: completedNodeId })

  // Fire on_complete attachments
  await processAttachments(completedNode, instance, 'on_complete', actorId)

  // 2. Merge output into instance context. Apply node's outputArtifacts bindingPath
  // so well-known artifacts land at typed paths.
  const currentContext = (instance.context ?? {}) as Record<string, unknown>
  const mergedContext: Record<string, unknown> = { ...currentContext, ...output }
  applyOutputBindings(mergedContext, completedNode, output)

  // Gate: if instance is not ACTIVE, queue this advance and stop.
  // resume() will replay queued advances when the instance is reactivated.
  if (instance.status !== 'ACTIVE') {
    const pending = Array.isArray(mergedContext._pendingAdvance)
      ? (mergedContext._pendingAdvance as PendingAdvance[])
      : []
    pending.push({ nodeId: completedNodeId })
    mergedContext._pendingAdvance = pending
    await prisma.workflowInstance.update({
      where: { id: instanceId },
      data: { context: mergedContext as unknown as Prisma.InputJsonValue },
    })
    return
  }

  await prisma.workflowInstance.update({
    where: { id: instanceId },
    data: { context: mergedContext as unknown as Prisma.InputJsonValue },
  })

  // 3 + 4. Resolve next nodes and activate them
  await activateDownstream(instance, completedNode, mergedContext, actorId)

  // 5. Check for instance completion
  if (await isComplete(instance)) {
    await prisma.workflowInstance.update({
      where: { id: instanceId },
      data: { status: 'COMPLETED', completedAt: new Date() },
    })
    const eventId = await logEvent('WorkflowCompleted', 'WorkflowInstance', instanceId, actorId)
    await createReceipt('WORKFLOW_COMPLETED', 'WorkflowInstance', instanceId, {
      instanceId,
      completedAt: new Date().toISOString(),
    }, eventId)
    await publishOutbox('WorkflowInstance', instanceId, 'WorkflowCompleted', { instanceId })

    // If this instance is a child, advance the parent's CALL_WORKFLOW node.
    if (instance.parentInstanceId && instance.parentNodeId) {
      const parentCtx = (instance.context ?? {}) as Record<string, unknown>
      await advance(instance.parentInstanceId, instance.parentNodeId, {
        _childCompleted: { instanceId, context: parentCtx },
      }, actorId)
    }
  }
}

async function activateDownstream(
  instance: WorkflowInstance,
  completedNode: WorkflowNode,
  context: Record<string, unknown>,
  actorId?: string,
): Promise<void> {
  const outgoing = await prisma.workflowEdge.findMany({
    where: { sourceNodeId: completedNode.id },
  })

  const nextNodes = await resolveNextNodes(instance, completedNode, outgoing, context)

  for (const nextNode of nextNodes) {
    // Skip if already non-pending (race-safety)
    const fresh = await prisma.workflowNode.findUnique({ where: { id: nextNode.id } })
    if (!fresh || fresh.status !== 'PENDING') continue

    await prisma.workflowNode.update({ where: { id: nextNode.id }, data: { status: 'ACTIVE' } })

    await prisma.workflowMutation.create({
      data: {
        instanceId: instance.id,
        nodeId: nextNode.id,
        mutationType: 'NODE_STATUS_CHANGE',
        beforeState: { status: 'PENDING' },
        afterState: { status: 'ACTIVE' },
        performedById: actorId,
      },
    })

    // ── Execution location gate ─────────────────────────────────────────
    if (nextNode.executionLocation !== 'SERVER') {
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000) // 24h default
      await prisma.pendingExecution.create({
        data: {
          instanceId: instance.id,
          nodeId: nextNode.id,
          location: nextNode.executionLocation,
          payload: context as any,
          expiresAt,
        },
      })
      await logEvent('NodePendingExecution', 'WorkflowNode', nextNode.id, undefined, { instanceId: instance.id, location: nextNode.executionLocation } as any)
      continue
    }

    switch (nextNode.nodeType) {
      case 'START':
        // START is a pass-through; auto-advance immediately
        await advance(instance.id, nextNode.id, context, actorId)
        break
      case 'END':
        // END marks itself complete; isComplete() will then close the instance
        await advance(instance.id, nextNode.id, context, actorId)
        break
      case 'HUMAN_TASK':
        await activateHumanTask(nextNode, instance)
        break
      case 'AGENT_TASK':
        await activateAgentTask(nextNode, instance)
        break
      case 'APPROVAL':
        await activateApproval(nextNode, instance, actorId)
        break
      case 'DECISION_GATE':
        await activateDecisionGate(nextNode, instance)
        await advance(instance.id, nextNode.id, context, actorId)
        break
      case 'CONSUMABLE_CREATION':
        await activateConsumableCreation(nextNode, instance)
        break
      case 'TOOL_REQUEST':
        await activateToolRequest(nextNode, instance)
        break
      case 'POLICY_CHECK':
        await activatePolicyCheck(nextNode, instance)
        await advance(instance.id, nextNode.id, context, actorId)
        break
      case 'TIMER':
        await activateTimer(nextNode, instance)
        break
      case 'SIGNAL_WAIT':
        await activateSignalWait(nextNode, instance)
        break
      case 'CALL_WORKFLOW':
        await activateCallWorkflow(nextNode, instance)
        break
      case 'FOREACH':
        await activateForeach(nextNode, instance)
        break
      case 'INCLUSIVE_GATEWAY':
        await activateInclusiveGateway(nextNode, instance)
        await advance(instance.id, nextNode.id, context, actorId)
        break
      case 'EVENT_GATEWAY':
        await activateEventGateway(nextNode, instance)
        break
      case 'DATA_SINK':
        await activateDataSink(nextNode, instance)
        await advance(instance.id, nextNode.id, context, actorId)
        break
      case 'PARALLEL_FORK':
        await activateParallelFork(nextNode, instance)
        await advance(instance.id, nextNode.id, context, actorId)
        break
      case 'PARALLEL_JOIN':
        await activateParallelJoin(nextNode, instance)
        // PARALLEL_JOIN waits for all branches; advance() is triggered by GraphTraverser
        // once expected_joins are met. Do not call advance() here.
        break
      case 'SIGNAL_EMIT':
        await activateSignalEmit(nextNode, instance)
        await advance(instance.id, nextNode.id, context, actorId)
        break
      case 'SET_CONTEXT':
        await activateSetContext(nextNode, instance)
        await advance(instance.id, nextNode.id, context, actorId)
        break
      case 'ERROR_CATCH':
        await activateErrorCatch(nextNode, instance)
        await advance(instance.id, nextNode.id, context, actorId)
        break
      case 'CUSTOM': {
        // Delegate to the base executor defined in config.customTypeId → CustomNodeType.baseType
        const customCfg = (nextNode.config ?? {}) as Record<string, unknown>
        const baseType = customCfg._baseType as string | undefined
        switch (baseType) {
          case 'HUMAN_TASK': await activateHumanTask(nextNode, instance); break
          case 'AGENT_TASK': await activateAgentTask(nextNode, instance); break
          case 'APPROVAL': await activateApproval(nextNode, instance, actorId); break
          case 'CONSUMABLE_CREATION': await activateConsumableCreation(nextNode, instance); break
          case 'TOOL_REQUEST': await activateToolRequest(nextNode, instance); break
          case 'POLICY_CHECK':
            await activatePolicyCheck(nextNode, instance)
            await advance(instance.id, nextNode.id, context, actorId)
            break
          case 'TIMER': await activateTimer(nextNode, instance); break
          case 'SIGNAL_WAIT': await activateSignalWait(nextNode, instance); break
          case 'CALL_WORKFLOW': await activateCallWorkflow(nextNode, instance); break
          case 'FOREACH': await activateForeach(nextNode, instance); break
          default: await activateHumanTask(nextNode, instance); break
        }
        break
      }
    }

	    // Fire on_activate attachments and schedule any deadlines
	    await processAttachments(nextNode, instance, 'on_activate', actorId)
	    await scheduleDeadlines(nextNode)
  }
}

export async function startInstance(instanceId: string, actorId?: string): Promise<{ id: string; startNodes: string[] }> {
  // Find nodes with no incoming edges → activate them.
  const allNodes = await prisma.workflowNode.findMany({ where: { instanceId } })
  const allEdges = await prisma.workflowEdge.findMany({ where: { instanceId } })
  if (allNodes.length === 0) {
    throw new ValidationError('Cannot start workflow run because the design has no nodes')
  }
  const targetNodeIds = new Set(allEdges.map(e => e.targetNodeId))
  const startNodes = allNodes.filter(n => !targetNodeIds.has(n.id))
  if (startNodes.length === 0) {
    throw new ValidationError('Cannot start workflow run because the graph has no entry node')
  }

  const instance = await prisma.workflowInstance.update({
    where: { id: instanceId },
    data: { status: 'ACTIVE', startedAt: new Date() },
  })

  for (const node of startNodes) {
    await prisma.workflowNode.update({ where: { id: node.id }, data: { status: 'ACTIVE' } })
    await prisma.workflowMutation.create({
      data: {
        instanceId,
        nodeId: node.id,
        mutationType: 'NODE_STATUS_CHANGE',
        beforeState: { status: 'PENDING' },
        afterState: { status: 'ACTIVE' },
        performedById: actorId,
      },
    })
    await processStartNodeAttachments(node, instance, actorId)
    // START nodes are pass-through: advance immediately so downstream activates.
    if (node.nodeType === 'START') {
      await advance(instanceId, node.id, (instance.context ?? {}) as Record<string, unknown>, actorId)
    }
  }

  await logEvent('WorkflowStarted', 'WorkflowInstance', instance.id, actorId)
  const eventId = await logEvent('WorkflowActivated', 'WorkflowInstance', instance.id, actorId)
  await createReceipt('WORKFLOW_STARTED', 'WorkflowInstance', instance.id, {
    instanceId: instance.id,
    startedAt: instance.startedAt?.toISOString(),
  }, eventId)

  return { id: instance.id, startNodes: startNodes.map(n => n.id) }
}

// ─── Failure handling ─────────────────────────────────────────────────────────

type RetryPolicy = {
  maxAttempts?: number
  initialIntervalMs?: number
  backoffCoefficient?: number
  nonRetryableErrors?: string[]
}

type FailureInfo = {
  message: string
  code?: string
  details?: Record<string, unknown>
}

/**
 * Mark a node as FAILED, applying its retry policy first.
 * - If attempts < maxAttempts and error is retryable, re-activate the node (immediate retry; backoff TBD).
 * - Else, follow ERROR_BOUNDARY outgoing edges if any.
 * - Else, mark instance FAILED.
 */
export async function failNode(
  instanceId: string,
  nodeId: string,
  failure: FailureInfo,
  actorId?: string,
): Promise<{ retried: boolean; recovered: boolean; instanceFailed: boolean }> {
  const instance = await prisma.workflowInstance.findUniqueOrThrow({ where: { id: instanceId } })
  const node = await prisma.workflowNode.findUniqueOrThrow({ where: { id: nodeId } })
  const cfg = (node.config ?? {}) as Record<string, unknown>
  const policy = (cfg.retryPolicy ?? {}) as RetryPolicy
  const attemptsSoFar = Number(cfg._attempts ?? 0)
  const maxAttempts = Number(policy.maxAttempts ?? 1)
  const isNonRetryable = Array.isArray(policy.nonRetryableErrors)
    && failure.code !== undefined
    && policy.nonRetryableErrors.includes(failure.code)

  const canRetry = !isNonRetryable && attemptsSoFar + 1 < maxAttempts

  if (canRetry) {
    // Increment attempt count, mark ACTIVE (re-activated)
    const updatedCfg = { ...cfg, _attempts: attemptsSoFar + 1, _lastError: failure }
    await prisma.workflowNode.update({
      where: { id: nodeId },
      data: { status: 'ACTIVE', config: updatedCfg as Prisma.InputJsonValue },
    })
    await prisma.workflowMutation.create({
      data: {
        instanceId,
        nodeId,
        mutationType: 'NODE_RETRY',
        beforeState: { status: 'ACTIVE', attempts: attemptsSoFar } as Prisma.InputJsonValue,
        afterState: { status: 'ACTIVE', attempts: attemptsSoFar + 1, error: failure } as unknown as Prisma.InputJsonValue,
        performedById: actorId,
      },
    })
    await logEvent('WorkflowNodeRetried', 'WorkflowNode', nodeId, actorId, {
      instanceId,
      attempt: attemptsSoFar + 1,
      maxAttempts,
      error: failure,
    })
    await publishOutbox('WorkflowNode', nodeId, 'NodeRetried', { instanceId, nodeId, attempt: attemptsSoFar + 1 })
    return { retried: true, recovered: false, instanceFailed: false }
  }

  // Retries exhausted (or non-retryable). Mark FAILED first.
  await prisma.workflowNode.update({
    where: { id: nodeId },
    data: { status: 'FAILED' },
  })
  await prisma.workflowMutation.create({
    data: {
      instanceId,
      nodeId,
      mutationType: 'NODE_STATUS_CHANGE',
      beforeState: { status: node.status, attempts: attemptsSoFar } as Prisma.InputJsonValue,
      afterState: { status: 'FAILED', error: failure } as unknown as Prisma.InputJsonValue,
      performedById: actorId,
    },
  })
  await logEvent('WorkflowNodeFailed', 'WorkflowNode', nodeId, actorId, { instanceId, error: failure })
  await publishOutbox('WorkflowNode', nodeId, 'NodeFailed', { instanceId, nodeId, error: failure })

  // Fire on_fail attachments
  await processAttachments(node, instance, 'on_fail', actorId)

  // Look for ERROR_BOUNDARY outgoing edges
  const errorEdges = await prisma.workflowEdge.findMany({
    where: { sourceNodeId: nodeId, edgeType: 'ERROR_BOUNDARY' },
  })

  if (errorEdges.length > 0) {
    // Follow error-boundary edges to recovery handler
    const ctx = (instance.context ?? {}) as Record<string, unknown>
    const errorContext = { ...ctx, _lastError: failure }
    await prisma.workflowInstance.update({
      where: { id: instanceId },
      data: { context: errorContext as unknown as Prisma.InputJsonValue },
    })

    for (const edge of errorEdges) {
      const target = await prisma.workflowNode.findUnique({ where: { id: edge.targetNodeId } })
      if (!target || target.status !== 'PENDING') continue
      // Treat the failed node as if it had completed (with error context) for routing purposes.
      // We bypass evaluateEdge filter and call activateDownstream's body directly for these edges.
      await prisma.workflowNode.update({ where: { id: target.id }, data: { status: 'ACTIVE' } })
      await prisma.workflowMutation.create({
        data: {
          instanceId,
          nodeId: target.id,
          mutationType: 'NODE_STATUS_CHANGE',
          beforeState: { status: 'PENDING' } as Prisma.InputJsonValue,
          afterState: { status: 'ACTIVE', via: 'ERROR_BOUNDARY' } as Prisma.InputJsonValue,
          performedById: actorId,
        },
      })
      switch (target.nodeType) {
        case 'HUMAN_TASK':
          await activateHumanTask(target, instance)
          break
        case 'AGENT_TASK':
          await activateAgentTask(target, instance)
          break
        case 'APPROVAL':
          await activateApproval(target, instance, actorId)
          break
        case 'DECISION_GATE':
          await activateDecisionGate(target, instance)
          await advance(instanceId, target.id, errorContext, actorId)
          break
        case 'CONSUMABLE_CREATION':
          await activateConsumableCreation(target, instance)
          break
        case 'TOOL_REQUEST':
          await activateToolRequest(target, instance)
          break
        case 'POLICY_CHECK':
          await activatePolicyCheck(target, instance)
          await advance(instanceId, target.id, errorContext, actorId)
          break
        case 'TIMER':
          await activateTimer(target, instance)
          break
        case 'SIGNAL_WAIT':
          await activateSignalWait(target, instance)
          break
        case 'CALL_WORKFLOW':
          await activateCallWorkflow(target, instance)
          break
        case 'FOREACH':
          await activateForeach(target, instance)
          break
        case 'INCLUSIVE_GATEWAY':
          await activateInclusiveGateway(target, instance)
          await advance(instanceId, target.id, errorContext, actorId)
          break
        case 'EVENT_GATEWAY':
          await activateEventGateway(target, instance)
          break
        case 'ERROR_CATCH':
          await activateErrorCatch(target, instance)
          await advance(instanceId, target.id, errorContext, actorId)
          break
        case 'SET_CONTEXT':
          await activateSetContext(target, instance)
          await advance(instanceId, target.id, errorContext, actorId)
          break
        case 'CUSTOM': {
          const cfg = (target.config ?? {}) as Record<string, unknown>
          const bt = cfg._baseType as string | undefined
          switch (bt) {
            case 'HUMAN_TASK': await activateHumanTask(target, instance); break
            case 'TOOL_REQUEST': await activateToolRequest(target, instance); break
            default: await activateHumanTask(target, instance); break
          }
          break
        }
      }
    }
    return { retried: false, recovered: true, instanceFailed: false }
  }

  // No error handler; fail the instance.
  await prisma.workflowInstance.update({
    where: { id: instanceId },
    data: { status: 'FAILED', completedAt: new Date() },
  })
  const eventId = await logEvent('WorkflowFailed', 'WorkflowInstance', instanceId, actorId, { failedNodeId: nodeId, error: failure })
  await createReceipt('WORKFLOW_FAILED', 'WorkflowInstance', instanceId, {
    instanceId,
    failedNodeId: nodeId,
    failedAt: new Date().toISOString(),
    error: failure,
  }, eventId)
  await publishOutbox('WorkflowInstance', instanceId, 'WorkflowFailed', { instanceId, failedNodeId: nodeId })

  // Run SAGA compensations for any completed nodes that declared compensationConfig.
  await runCompensations(instanceId, actorId)

  return { retried: false, recovered: false, instanceFailed: true }
}

// ─── Lifecycle ops ────────────────────────────────────────────────────────────

export async function pauseInstance(instanceId: string, actorId?: string): Promise<void> {
  const instance = await prisma.workflowInstance.findUniqueOrThrow({ where: { id: instanceId } })
  if (instance.status !== 'ACTIVE') return

  await prisma.workflowInstance.update({
    where: { id: instanceId },
    data: { status: 'PAUSED' },
  })
  await prisma.workflowMutation.create({
    data: {
      instanceId,
      mutationType: 'INSTANCE_STATUS_CHANGE',
      beforeState: { status: 'ACTIVE' },
      afterState: { status: 'PAUSED' },
      performedById: actorId,
    },
  })
  await logEvent('WorkflowPaused', 'WorkflowInstance', instanceId, actorId)
  await publishOutbox('WorkflowInstance', instanceId, 'WorkflowPaused', { instanceId })
}

export async function resumeInstance(instanceId: string, actorId?: string): Promise<void> {
  const instance = await prisma.workflowInstance.findUniqueOrThrow({ where: { id: instanceId } })
  if (instance.status !== 'PAUSED') return

  // Reactivate first so queued advances can proceed
  await prisma.workflowInstance.update({
    where: { id: instanceId },
    data: { status: 'ACTIVE' },
  })
  await prisma.workflowMutation.create({
    data: {
      instanceId,
      mutationType: 'INSTANCE_STATUS_CHANGE',
      beforeState: { status: 'PAUSED' },
      afterState: { status: 'ACTIVE' },
      performedById: actorId,
    },
  })
  await logEvent('WorkflowResumed', 'WorkflowInstance', instanceId, actorId)
  await publishOutbox('WorkflowInstance', instanceId, 'WorkflowResumed', { instanceId })

  // Drain queued advances
  const refreshed = await prisma.workflowInstance.findUniqueOrThrow({ where: { id: instanceId } })
  const context = (refreshed.context ?? {}) as Record<string, unknown>
  const pending = Array.isArray(context._pendingAdvance)
    ? (context._pendingAdvance as PendingAdvance[])
    : []

  if (pending.length === 0) return

  // Clear queue first to avoid re-processing on partial failure
  delete context._pendingAdvance
  await prisma.workflowInstance.update({
    where: { id: instanceId },
    data: { context: context as unknown as Prisma.InputJsonValue },
  })

  for (const { nodeId } of pending) {
    const completedNode = await prisma.workflowNode.findUnique({ where: { id: nodeId } })
    if (!completedNode || completedNode.status !== 'COMPLETED') continue
    const currentInstance = await prisma.workflowInstance.findUniqueOrThrow({ where: { id: instanceId } })
    if (currentInstance.status !== 'ACTIVE') break
    const ctx = (currentInstance.context ?? {}) as Record<string, unknown>
    await activateDownstream(currentInstance, completedNode, ctx, actorId)
  }

  // Re-check completion
  const finalInstance = await prisma.workflowInstance.findUniqueOrThrow({ where: { id: instanceId } })
  if (finalInstance.status === 'ACTIVE' && (await isComplete(finalInstance))) {
    await prisma.workflowInstance.update({
      where: { id: instanceId },
      data: { status: 'COMPLETED', completedAt: new Date() },
    })
    const eventId = await logEvent('WorkflowCompleted', 'WorkflowInstance', instanceId, actorId)
    await createReceipt('WORKFLOW_COMPLETED', 'WorkflowInstance', instanceId, {
      instanceId,
      completedAt: new Date().toISOString(),
    }, eventId)
    await publishOutbox('WorkflowInstance', instanceId, 'WorkflowCompleted', { instanceId })
  }
}

export async function cancelInstance(
  instanceId: string,
  reason: string | undefined,
  actorId?: string,
): Promise<void> {
  const instance = await prisma.workflowInstance.findUniqueOrThrow({ where: { id: instanceId } })
  if (instance.status === 'COMPLETED' || instance.status === 'CANCELLED' || instance.status === 'FAILED') return

  // Skip all PENDING / ACTIVE nodes
  const liveNodes = await prisma.workflowNode.findMany({
    where: { instanceId, status: { in: ['PENDING', 'ACTIVE'] } },
  })
  for (const node of liveNodes) {
    await prisma.workflowNode.update({ where: { id: node.id }, data: { status: 'SKIPPED' } })
    await prisma.workflowMutation.create({
      data: {
        instanceId,
        nodeId: node.id,
        mutationType: 'NODE_STATUS_CHANGE',
        beforeState: { status: node.status },
        afterState: { status: 'SKIPPED', reason: 'instance_cancelled' },
        performedById: actorId,
      },
    })
  }

  await prisma.workflowInstance.update({
    where: { id: instanceId },
    data: { status: 'CANCELLED', completedAt: new Date() },
  })
  await prisma.workflowMutation.create({
    data: {
      instanceId,
      mutationType: 'INSTANCE_STATUS_CHANGE',
      beforeState: { status: instance.status },
      afterState: { status: 'CANCELLED', reason },
      performedById: actorId,
    },
  })
  const eventId = await logEvent('WorkflowCancelled', 'WorkflowInstance', instanceId, actorId, { reason })
  await createReceipt('WORKFLOW_CANCELLED', 'WorkflowInstance', instanceId, {
    instanceId,
    cancelledAt: new Date().toISOString(),
    reason,
    skippedNodeIds: liveNodes.map(n => n.id),
  }, eventId)
  await publishOutbox('WorkflowInstance', instanceId, 'WorkflowCancelled', { instanceId, reason })
}

// ─── Attachment processing ─────────────────────────────────────────────────

type AttachmentRaw = {
  id?: string
  type?: string
  trigger?: string
  enabled?: boolean
  durationMs?: number
  deadlineEdge?: string
  toolName?: string
  actionName?: string
  inputPayload?: string
  channel?: string
  recipient?: string
  message?: string
}

/**
 * Called by the /start handler for nodes that are activated at workflow launch.
 * Fires on_activate attachments and schedules deadline timers.
 */
export async function processStartNodeAttachments(
  node: WorkflowNode,
  instance: WorkflowInstance,
  actorId?: string,
): Promise<void> {
  await processAttachments(node, instance, 'on_activate', actorId)
  await scheduleDeadlines(node)
}

/**
 * For any `deadline` attachments on the node, record `_deadlineFireAt` and
 * `_deadlineEdge` in the node config so TimerSweep can fire them.
 */
async function scheduleDeadlines(node: WorkflowNode): Promise<void> {
  const cfg = (node.config ?? {}) as Record<string, unknown>
  const attachments = Array.isArray(cfg.attachments) ? cfg.attachments as AttachmentRaw[] : []
  const deadlines = attachments.filter(a => a.enabled !== false && a.trigger === 'deadline' && a.durationMs && a.durationMs > 0)
  if (deadlines.length === 0) return

  // Use the attachment with the shortest duration
  const earliest = deadlines.reduce((min, a) => (a.durationMs! < min.durationMs!) ? a : min)
  const fireAt = new Date(Date.now() + earliest.durationMs!)

  await prisma.workflowNode.update({
    where: { id: node.id },
    data: {
      config: {
        ...cfg,
        _deadlineFireAt: fireAt.toISOString(),
        _deadlineEdge: earliest.deadlineEdge ?? '',
        _deadlineAttachmentId: earliest.id ?? '',
      } as unknown as Prisma.InputJsonValue,
    },
  })
}

/**
 * Fire tool / notification attachments for a specific lifecycle trigger.
 * Called after node activates (on_activate), after node completes (on_complete),
 * and after node fails (on_fail). Never throws — errors are logged and swallowed.
 */
async function processAttachments(
  node: WorkflowNode,
  instance: WorkflowInstance,
  trigger: 'on_activate' | 'on_complete' | 'on_fail',
  actorId?: string,
): Promise<void> {
  const cfg = (node.config ?? {}) as Record<string, unknown>
  const attachments = Array.isArray(cfg.attachments) ? cfg.attachments as AttachmentRaw[] : []
  const matching = attachments.filter(a => a.enabled !== false && a.trigger === trigger)
  if (matching.length === 0) return

  for (const att of matching) {
    try {
      if (att.type === 'tool' && att.toolName) {
        const tool = await prisma.tool.findFirst({ where: { name: att.toolName } })
        if (!tool) {
          await logEvent('AttachmentToolNotFound', 'WorkflowNode', node.id, actorId, {
            instanceId: instance.id, trigger, toolName: att.toolName,
          })
          continue
        }
        let payload: Record<string, unknown> = {}
        try { if (att.inputPayload) payload = JSON.parse(att.inputPayload) } catch { /* bad JSON — use empty */ }
        await prisma.toolRun.create({
          data: {
            toolId: tool.id,
            instanceId: instance.id,
            inputPayload: payload as unknown as Prisma.InputJsonValue,
            requestedById: actorId,
            idempotencyKey: `att:${instance.id}:${node.id}:${att.id ?? att.toolName}:${trigger}`,
          },
        })
        await logEvent('AttachmentToolTriggered', 'WorkflowNode', node.id, actorId, {
          instanceId: instance.id, trigger, toolName: att.toolName, attachmentId: att.id,
        })
        await publishOutbox('WorkflowNode', node.id, 'AttachmentToolTriggered', {
          instanceId: instance.id, nodeId: node.id, trigger, toolName: att.toolName,
        })
      } else if (att.type === 'notification') {
        await logEvent('AttachmentNotificationTriggered', 'WorkflowNode', node.id, actorId, {
          instanceId: instance.id, trigger, channel: att.channel,
          recipient: att.recipient, message: att.message, attachmentId: att.id,
        })
        await publishOutbox('WorkflowNode', node.id, 'AttachmentNotification', {
          instanceId: instance.id, nodeId: node.id, trigger,
          channel: att.channel, recipient: att.recipient, message: att.message,
        })
      }
    } catch (err) {
      console.error('processAttachments error:', err)
    }
  }
}

// ─── SAGA Compensations ───────────────────────────────────────────────────────

type CompensationConfig = {
  // 'tool_request' | 'human_task' — what kind of compensation action to spawn
  type: 'tool_request' | 'human_task'
  // For tool_request: toolId, actionId, inputPayload
  toolId?: string
  actionId?: string
  inputPayload?: Record<string, unknown>
  // For human_task: assignee, description
  assignee?: string
  description?: string
}

/**
 * Walk all COMPLETED nodes for this instance in reverse creation order and fire
 * their compensationConfig actions, producing an audit trail for each.
 * Called after instance failure (or optionally on explicit cancel if configured).
 */
export async function runCompensations(instanceId: string, actorId?: string): Promise<void> {
  const completedNodes = await prisma.workflowNode.findMany({
    where: { instanceId, status: 'COMPLETED', compensationConfig: { not: Prisma.JsonNull } },
    orderBy: { createdAt: 'desc' }, // reverse order
  })

  if (completedNodes.length === 0) return

  const instance = await prisma.workflowInstance.findUniqueOrThrow({ where: { id: instanceId } })

  await logEvent('CompensationStarted', 'WorkflowInstance', instanceId, actorId, {
    nodeCount: completedNodes.length,
  })

  for (const node of completedNodes) {
    const cfg = (node.compensationConfig ?? {}) as CompensationConfig

    await prisma.workflowMutation.create({
      data: {
        instanceId,
        nodeId: node.id,
        mutationType: 'COMPENSATION_STARTED',
        beforeState: { nodeId: node.id, nodeType: node.nodeType } as Prisma.InputJsonValue,
        afterState: { compensationType: cfg.type } as Prisma.InputJsonValue,
        performedById: actorId,
      },
    })

    if (cfg.type === 'tool_request' && cfg.toolId) {
      // Spawn a ToolRun as the compensation action
      const run = await prisma.toolRun.create({
        data: {
          toolId: cfg.toolId,
          actionId: cfg.actionId,
          instanceId,
          inputPayload: ((cfg.inputPayload ?? {}) as unknown as Prisma.InputJsonValue),
          requestedById: actorId,
          idempotencyKey: `compensation:${instanceId}:${node.id}`,
        },
      })
      await logEvent('CompensationToolRequested', 'ToolRun', run.id, actorId, {
        instanceId, nodeId: node.id,
      })
      await publishOutbox('ToolRun', run.id, 'ToolRequested', { runId: run.id, isCompensation: true })
    } else if (cfg.type === 'human_task') {
      // Spawn a Task as the compensation action
      const task = await prisma.task.create({
        data: {
          instanceId,
          nodeId: node.id,
          title: `Compensate: ${node.label}`,
          description: cfg.description ?? `Undo the effects of step "${node.label}"`,
          status: 'OPEN',
          createdById: actorId,
        },
      })
      await logEvent('CompensationTaskCreated', 'Task', task.id, actorId, {
        instanceId, nodeId: node.id,
      })
    }
  }

  await logEvent('CompensationCompleted', 'WorkflowInstance', instanceId, actorId, {
    nodeCount: completedNodes.length,
  })
  await publishOutbox('WorkflowInstance', instanceId, 'CompensationStarted', {
    instanceId,
    nodeCount: completedNodes.length,
  })
}
