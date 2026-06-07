import { Prisma } from '@prisma/client'
import type { WorkflowInstance, WorkflowNode } from '@prisma/client'
import { prisma } from '../../../lib/prisma'
import { logEvent, createReceipt, publishOutbox } from '../../../lib/audit'
import { ValidationError } from '../../../lib/errors'
import { resolveNextNodes, isComplete } from './GraphTraverser'
import { activateHumanTask } from './executors/HumanTaskExecutor'
import { activateWorkbenchTask } from './executors/WorkbenchTaskExecutor'
import { activateAgentTask } from './executors/AgentTaskExecutor'
import { activateApproval } from './executors/ApprovalExecutor'
import { activateDecisionGate } from './executors/DecisionGateExecutor'
import { activateConsumableCreation } from './executors/ConsumableCreationExecutor'
import { activateToolRequest } from './executors/ToolRequestExecutor'
import { activateGitPush } from './executors/GitPushExecutor'
import { activatePolicyCheck } from './executors/PolicyCheckExecutor'
import { activateEvalGate } from './executors/EvalGateExecutor'
import { activateRunPython } from './executors/RunPythonExecutor'
import { activateTimer } from './executors/TimerExecutor'
import { activateSignalWait } from './executors/SignalWaitExecutor'
import { activateCallWorkflow } from './executors/CallWorkflowExecutor'
import { activateWorkItem, handleWorkItemChildCompletion } from '../../work-items/work-items.service'
import { activateForeach } from './executors/ForeachExecutor'
import { activateInclusiveGateway } from './executors/InclusiveGatewayExecutor'
import { activateEventGateway } from './executors/EventGatewayExecutor'
import { activateDataSink } from './executors/DataSinkExecutor'
import { activateParallelFork } from './executors/ParallelForkExecutor'
import { activateParallelJoin } from './executors/ParallelJoinExecutor'
import { activateSignalEmit } from './executors/SignalEmitExecutor'
import { activateEventEmit } from './executors/EventEmitExecutor'
import { activateSetContext } from './executors/SetContextExecutor'
import { activateErrorCatch } from './executors/ErrorCatchExecutor'

type PendingAdvance = { nodeId: string }
const RESTARTABLE_NODE_STATUSES = new Set(['COMPLETED', 'FAILED', 'BLOCKED'])

type ArtifactBinding = {
  id?: string
  name?: string
  bindingPath?: string
  required?: boolean
}

type KVPair = { key?: string; path?: string; value?: string }

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

function walk(root: Record<string, unknown> | undefined, path: string): unknown {
  if (!root) return undefined
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc !== null && typeof acc === 'object') return (acc as Record<string, unknown>)[key]
    return undefined
  }, root)
}

function resolveRuntimeRef(context: Record<string, unknown>, path: string): unknown {
  if (path.startsWith('server.')) return resolveServerRuntimeRef(path.slice('server.'.length))
  if (path.startsWith('globals.')) return walk(context._globals as Record<string, unknown>, path.slice('globals.'.length))
  if (path.startsWith('vars.')) return walk(context._vars as Record<string, unknown>, path.slice('vars.'.length))
  if (path.startsWith('params.')) return walk(context._params as Record<string, unknown>, path.slice('params.'.length))
  const stripped = path.startsWith('context.') ? path.slice('context.'.length)
    : path.startsWith('output.') ? path.slice('output.'.length)
    : path
  return walk(context, stripped)
}

function resolveServerRuntimeRef(path: string): unknown {
  const now = new Date()
  switch (path) {
    case 'now':
    case 'iso':
      return now.toISOString()
    case 'epochMs':
      return now.valueOf()
    case 'epochSeconds':
      return Math.floor(now.valueOf() / 1000)
    case 'date':
      return now.toISOString().slice(0, 10)
    case 'time':
      return now.toISOString().slice(11, 19)
    case 'timezone':
      return 'UTC'
    default:
      return undefined
  }
}

function resolveAssignmentValue(raw: unknown, context: Record<string, unknown>): unknown {
  if (typeof raw !== 'string') return raw
  const match = raw.match(/^\{\{(.+?)\}\}$/)
  if (match) return resolveRuntimeRef(context, match[1].trim())
  try { return JSON.parse(raw) } catch { return raw }
}

function applyGlobalAssignments(context: Record<string, unknown>, node: WorkflowNode): void {
  const cfg = (node.config ?? {}) as Record<string, unknown>
  const assignments: KVPair[] = Array.isArray(cfg.globalAssignments) ? cfg.globalAssignments as KVPair[] : []
  if (assignments.length === 0) return
  const globals = { ...((context._globals ?? {}) as Record<string, unknown>) }
  context._globals = globals
  for (const entry of assignments) {
    const rawKey = (entry.key ?? entry.path ?? '').trim()
    if (!rawKey) continue
    const path = rawKey.startsWith('globals.') ? rawKey.slice('globals.'.length)
      : rawKey.startsWith('_globals.') ? rawKey.slice('_globals.'.length)
      : rawKey
    setPath(globals, path, resolveAssignmentValue(entry.value, context))
  }
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
  // M24.5 — write completedAt for the insights Gantt
  await prisma.$transaction([
    prisma.workflowNode.update({
      where: { id: completedNodeId },
      data: { status: 'COMPLETED', completedAt: new Date() },
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
  applyGlobalAssignments(mergedContext, completedNode)

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
    const completedAt = new Date()
    await prisma.workflowInstance.update({
      where: { id: instanceId },
      data: { status: 'COMPLETED', completedAt },
    })
    const eventId = await logEvent('WorkflowCompleted', 'WorkflowInstance', instanceId, actorId)
    await createReceipt('WORKFLOW_COMPLETED', 'WorkflowInstance', instanceId, {
      instanceId,
      completedAt: completedAt.toISOString(),
    }, eventId)
    await publishOutbox('WorkflowInstance', instanceId, 'WorkflowCompleted', { instanceId })
    const completedInstance = await prisma.workflowInstance.findUniqueOrThrow({ where: { id: instanceId } })
    await handleWorkItemChildCompletion(completedInstance, actorId)

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

    await prisma.workflowNode.update({
      where: { id: nextNode.id },
      data: { status: 'ACTIVE', startedAt: new Date() },
    })

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

    await executeServerNode(nextNode, instance, context, actorId)

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
    await prisma.workflowNode.update({
      where: { id: node.id },
      data: { status: 'ACTIVE', startedAt: new Date() },
    })
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

function reachableDownstreamNodeIds(startNodeId: string, edges: { sourceNodeId: string; targetNodeId: string }[]): string[] {
  const bySource = new Map<string, string[]>()
  for (const edge of edges) {
    const targets = bySource.get(edge.sourceNodeId) ?? []
    targets.push(edge.targetNodeId)
    bySource.set(edge.sourceNodeId, targets)
  }
  const seen = new Set<string>()
  const queue = [...(bySource.get(startNodeId) ?? [])]
  while (queue.length > 0) {
    const nodeId = queue.shift()!
    if (nodeId === startNodeId || seen.has(nodeId)) continue
    seen.add(nodeId)
    queue.push(...(bySource.get(nodeId) ?? []))
  }
  return [...seen]
}

function clearBlockedContext(context: Record<string, unknown>, nodeType?: string): Record<string, unknown> {
  const next = { ...context }
  const knownKeys = ['_blockedByGitPush', '_blockedByPolicyCheck', '_blockedByEvalGate']
  for (const key of knownKeys) {
    if (
      !nodeType ||
      (nodeType === 'GIT_PUSH' && key === '_blockedByGitPush') ||
      (nodeType === 'POLICY_CHECK' && key === '_blockedByPolicyCheck') ||
      (nodeType === 'EVAL_GATE' && key === '_blockedByEvalGate')
    ) {
      delete next[key]
    }
  }
  return next
}

function filterPendingAdvances(context: Record<string, unknown>, resetNodeIds: string[]): void {
  const pending = Array.isArray(context._pendingAdvance)
    ? (context._pendingAdvance as PendingAdvance[])
    : []
  if (pending.length === 0) return
  const reset = new Set(resetNodeIds)
  const remaining = pending.filter(item => !reset.has(item.nodeId))
  if (remaining.length > 0) context._pendingAdvance = remaining
  else delete context._pendingAdvance
}

// M98 — Degrade an unexpected server-node executor error into a recoverable
// BLOCKED node + PAUSED instance instead of letting it bubble up and strand the
// run with no clear recovery path. Used for GIT_PUSH: the local commit is
// already durable, so a push/transport failure must never be terminal. The
// operator can fix the cause and retry, or use force-complete to advance.
// (GitPushExecutor already self-blocks on classified push errors; this catches
// the *unexpected* throws it can't classify.)
async function degradeNodeToBlocked(
  instance: WorkflowInstance,
  node: WorkflowNode,
  err: unknown,
  actorId?: string,
): Promise<void> {
  const reason = err instanceof Error ? err.message : String(err)
  await prisma.$transaction([
    prisma.workflowNode.update({
      where: { id: node.id },
      data: { status: 'BLOCKED', completedAt: new Date() },
    }),
    prisma.workflowInstance.update({
      where: { id: instance.id },
      data: { status: 'PAUSED' },
    }),
    prisma.workflowMutation.create({
      data: {
        instanceId: instance.id,
        nodeId: node.id,
        mutationType: 'NODE_SOFT_BLOCKED',
        beforeState: { status: node.status } as Prisma.InputJsonValue,
        afterState: { status: 'BLOCKED', reason } as Prisma.InputJsonValue,
        performedById: actorId,
      },
    }),
  ])
  await logEvent('WorkflowNodeSoftBlocked', 'WorkflowNode', node.id, actorId, {
    instanceId: instance.id,
    nodeType: node.nodeType,
    reason,
  })
  await publishOutbox('WorkflowNode', node.id, 'NodeSoftBlocked', { instanceId: instance.id, nodeId: node.id })
}

function executableNodeType(node: WorkflowNode): string {
  if (node.nodeType !== 'CUSTOM') return node.nodeType
  const cfg = (node.config ?? {}) as Record<string, unknown>
  const baseType = typeof cfg._baseType === 'string' ? cfg._baseType : ''
  return baseType && baseType !== 'CUSTOM' ? baseType : 'HUMAN_TASK'
}

async function executeServerNode(
  node: WorkflowNode,
  instance: WorkflowInstance,
  context: Record<string, unknown>,
  actorId?: string,
): Promise<void> {
  switch (executableNodeType(node)) {
    case 'START':
    case 'END':
      await advance(instance.id, node.id, context, actorId)
      break
    case 'HUMAN_TASK':
      await activateHumanTask(node, instance)
      break
    case 'WORKBENCH_TASK':
      await activateWorkbenchTask(node, instance)
      break
    case 'AGENT_TASK':
      await activateAgentTask(node, instance)
      break
    case 'APPROVAL':
      await activateApproval(node, instance, actorId)
      break
    case 'DECISION_GATE':
      await activateDecisionGate(node, instance)
      await advance(instance.id, node.id, context, actorId)
      break
    case 'CONSUMABLE_CREATION':
      await activateConsumableCreation(node, instance)
      break
    case 'TOOL_REQUEST':
      await activateToolRequest(node, instance)
      break
    case 'GIT_PUSH': {
      // M98 — never let a git push problem hard-fail the run. activateGitPush
      // already self-blocks on classified push errors (BLOCKED + PAUSED); this
      // guard catches any *unexpected* throw and degrades it the same way so a
      // transport/credential hiccup is always recoverable (retry or
      // "Complete & advance"), never a stranded run.
      let pushResult: Awaited<ReturnType<typeof activateGitPush>> | null = null
      try {
        pushResult = await activateGitPush(node, instance, actorId)
      } catch (err) {
        await degradeNodeToBlocked(instance, node, err, actorId)
      }
      if (pushResult?.pushed) await advance(instance.id, node.id, pushResult.output, actorId)
      break
    }
    case 'POLICY_CHECK': {
      const result = await activatePolicyCheck(node, instance, actorId)
      if (result.passed) await advance(instance.id, node.id, result.output, actorId)
      break
    }
    case 'EVAL_GATE': {
      const result = await activateEvalGate(node, instance, actorId)
      if (result.passed) await advance(instance.id, node.id, result.output, actorId)
      break
    }
    case 'RUN_PYTHON': {
      const result = await activateRunPython(node, instance, actorId)
      if (result.passed) await advance(instance.id, node.id, result.output, actorId)
      else await failNode(instance.id, node.id, {
        message: 'RUN_PYTHON node failed',
        code: 'RUN_PYTHON_FAILED',
        details: result.output.runPython,
      }, actorId)
      break
    }
    case 'TIMER':
      await activateTimer(node, instance)
      break
    case 'SIGNAL_WAIT':
      await activateSignalWait(node, instance)
      break
    case 'CALL_WORKFLOW':
      await activateCallWorkflow(node, instance)
      break
    case 'WORK_ITEM':
      await activateWorkItem(node, instance, actorId)
      break
    case 'FOREACH':
      await activateForeach(node, instance)
      break
    case 'INCLUSIVE_GATEWAY':
      await activateInclusiveGateway(node, instance)
      await advance(instance.id, node.id, context, actorId)
      break
    case 'EVENT_GATEWAY':
      await activateEventGateway(node, instance)
      break
    case 'DATA_SINK':
      await activateDataSink(node, instance)
      await advance(instance.id, node.id, context, actorId)
      break
    case 'PARALLEL_FORK':
      await activateParallelFork(node, instance)
      await advance(instance.id, node.id, context, actorId)
      break
    case 'PARALLEL_JOIN':
      await activateParallelJoin(node, instance)
      break
    case 'SIGNAL_EMIT':
      await activateSignalEmit(node, instance)
      await advance(instance.id, node.id, context, actorId)
      break
    case 'EVENT_EMIT': {
      // Publish to the configured sink (eventbus/Kafka/SQS/SNS/AMQP). On a
      // delivery error the executor honours failOnError: passed=false → fail
      // the node; passed=true (failOnError off) → advance best-effort with the
      // error recorded in the node output.
      const result = await activateEventEmit(node, instance, actorId)
      if (result.passed) await advance(instance.id, node.id, { ...context, ...result.output }, actorId)
      else await failNode(instance.id, node.id, {
        message: 'EVENT_EMIT node failed',
        code: result.output.eventEmit.code ?? 'EVENT_EMIT_FAILED',
        details: result.output.eventEmit,
      }, actorId)
      break
    }
    case 'SET_CONTEXT':
      await activateSetContext(node, instance)
      await advance(instance.id, node.id, context, actorId)
      break
    case 'ERROR_CATCH':
      await activateErrorCatch(node, instance)
      await advance(instance.id, node.id, context, actorId)
      break
    default:
      await activateHumanTask(node, instance)
      break
  }
}

async function executeActivatedNode(
  node: WorkflowNode,
  instance: WorkflowInstance,
  context: Record<string, unknown>,
  actorId?: string,
): Promise<void> {
  if (node.executionLocation !== 'SERVER') {
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000)
    await prisma.pendingExecution.create({
      data: {
        instanceId: instance.id,
        nodeId: node.id,
        location: node.executionLocation,
        payload: context as any,
        expiresAt,
      },
    })
    await logEvent('NodePendingExecution', 'WorkflowNode', node.id, actorId, {
      instanceId: instance.id,
      location: node.executionLocation,
    } as any)
    return
  }

  await executeServerNode(node, instance, context, actorId)
}

export async function restartNode(
  instanceId: string,
  nodeId: string,
  actorId?: string,
): Promise<{ restartedNodeId: string; resetNodeIds: string[] }> {
  const instance = await prisma.workflowInstance.findUniqueOrThrow({ where: { id: instanceId } })
  const node = await prisma.workflowNode.findFirst({ where: { id: nodeId, instanceId } })
  if (!node) throw new ValidationError('Workflow node was not found in this run')
  if (!RESTARTABLE_NODE_STATUSES.has(node.status)) {
    throw new ValidationError('Only completed, failed, or blocked workflow nodes can be restarted')
  }

  const edges = await prisma.workflowEdge.findMany({
    where: { instanceId },
    select: { sourceNodeId: true, targetNodeId: true },
  })
  const downstreamIds = reachableDownstreamNodeIds(nodeId, edges)
  const resetNodeIds = [nodeId, ...downstreamIds]
  const context = clearBlockedContext((instance.context ?? {}) as Record<string, unknown>)
  filterPendingAdvances(context, resetNodeIds)

  await prisma.$transaction([
    prisma.pendingExecution.deleteMany({
      where: { instanceId, nodeId: { in: resetNodeIds } },
    }),
    prisma.workflowNode.updateMany({
      where: { instanceId, id: { in: downstreamIds } },
      data: { status: 'PENDING', startedAt: null, completedAt: null },
    }),
    prisma.workflowNode.update({
      where: { id: nodeId },
      data: { status: 'ACTIVE', startedAt: new Date(), completedAt: null },
    }),
    prisma.workflowInstance.update({
      where: { id: instanceId },
      data: { status: 'ACTIVE', completedAt: null, context: context as unknown as Prisma.InputJsonValue },
    }),
    prisma.workflowMutation.create({
      data: {
        instanceId,
        nodeId,
        mutationType: 'NODE_RESTARTED',
        beforeState: { status: node.status, downstreamNodeIds: downstreamIds } as Prisma.InputJsonValue,
        afterState: { status: 'ACTIVE', resetNodeIds } as Prisma.InputJsonValue,
        performedById: actorId,
      },
    }),
  ])

  await logEvent('WorkflowNodeRestarted', 'WorkflowNode', nodeId, actorId, {
    instanceId,
    previousStatus: node.status,
    resetNodeIds,
  })
  await publishOutbox('WorkflowNode', nodeId, 'NodeRestarted', { instanceId, nodeId, resetNodeIds })

  const refreshedInstance = await prisma.workflowInstance.findUniqueOrThrow({ where: { id: instanceId } })
  const refreshedNode = await prisma.workflowNode.findUniqueOrThrow({ where: { id: nodeId } })
  await executeActivatedNode(refreshedNode, refreshedInstance, context, actorId)
  await processAttachments(refreshedNode, refreshedInstance, 'on_activate', actorId)
  await scheduleDeadlines(refreshedNode)

  return { restartedNodeId: nodeId, resetNodeIds }
}

/**
 * M98 — Operator escape hatch: force a node to COMPLETED with a recorded
 * comment, then advance the workflow downstream.
 *
 * Unlike restartNode() (which re-runs the node) this accepts the node as DONE
 * as-is and moves on. It is the manual override for a run that got stuck
 * because a node FAILED / BLOCKED (e.g. a GitHub push the operator finished by
 * hand, or a stage that can't proceed automatically) so the workflow can be
 * advanced without re-executing the node.
 *
 * Works on any non-COMPLETED node regardless of WHY the run is stuck. The key
 * move is flipping the instance back to ACTIVE first: advance() queues (rather
 * than runs) when the instance is not ACTIVE, so without this a force-complete
 * on a FAILED/PAUSED instance would silently do nothing downstream.
 *
 * The operator comment is captured in a dedicated NODE_MANUAL_COMPLETION
 * WorkflowMutation (audit trail) and merged into the run context under
 * _manualCompletions so downstream stages can see the human note.
 */
export async function forceCompleteNode(
  instanceId: string,
  nodeId: string,
  comment: string,
  output: Record<string, unknown> = {},
  actorId?: string,
): Promise<void> {
  const instance = await prisma.workflowInstance.findUniqueOrThrow({ where: { id: instanceId } })
  const node = await prisma.workflowNode.findFirst({ where: { id: nodeId, instanceId } })
  if (!node) throw new ValidationError('Workflow node was not found in this run')
  if (node.status === 'COMPLETED') {
    throw new ValidationError('This node is already completed')
  }

  const note = comment.trim()
  if (!note) throw new ValidationError('A comment is required to manually complete a node')

  // Clear stuck/blocked markers and re-open the instance so advance() runs
  // inline rather than queuing the transition (advance() gates on ACTIVE).
  const baseContext = clearBlockedContext((instance.context ?? {}) as Record<string, unknown>)
  const priorCompletions = Array.isArray(baseContext._manualCompletions)
    ? (baseContext._manualCompletions as unknown[])
    : []
  const manualEntry = {
    nodeId,
    nodeLabel: node.label,
    comment: note,
    actorId: actorId ?? null,
    previousStatus: node.status,
    at: new Date().toISOString(),
  }
  const nextContext: Record<string, unknown> = {
    ...baseContext,
    _manualCompletions: [...priorCompletions, manualEntry],
  }

  await prisma.$transaction([
    // Drop any in-flight client/desktop execution claim so a stale runner
    // can't later report status for a node we're closing out manually.
    prisma.pendingExecution.deleteMany({ where: { instanceId, nodeId } }),
    prisma.workflowInstance.update({
      where: { id: instanceId },
      data: {
        status: 'ACTIVE',
        completedAt: null,
        context: nextContext as unknown as Prisma.InputJsonValue,
      },
    }),
    prisma.workflowMutation.create({
      data: {
        instanceId,
        nodeId,
        mutationType: 'NODE_MANUAL_COMPLETION',
        beforeState: { status: node.status, instanceStatus: instance.status } as Prisma.InputJsonValue,
        afterState: { status: 'COMPLETED', comment: note } as Prisma.InputJsonValue,
        performedById: actorId,
      },
    }),
  ])

  await logEvent('WorkflowNodeManuallyCompleted', 'WorkflowNode', nodeId, actorId, {
    instanceId,
    previousStatus: node.status,
    instanceStatusBefore: instance.status,
    comment: note,
  })
  await publishOutbox('WorkflowNode', nodeId, 'NodeManuallyCompleted', { instanceId, nodeId })

  // advance() reads the instance fresh — now ACTIVE — so it runs inline:
  // marks the node COMPLETED, merges output, fires on_complete attachments,
  // activates downstream nodes, and completes the instance if this was terminal.
  await advance(instanceId, nodeId, { ...output, _manualCompletion: manualEntry }, actorId)
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
    data: { status: 'FAILED', completedAt: new Date() },
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
      await prisma.workflowNode.update({
        where: { id: target.id },
        data: { status: 'ACTIVE', startedAt: new Date() },
      })
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
        case 'WORKBENCH_TASK':
          await activateWorkbenchTask(target, instance)
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
        case 'GIT_PUSH': {
          const result = await activateGitPush(target, instance, actorId)
          if (result.pushed) await advance(instanceId, target.id, result.output, actorId)
          break
        }
        case 'POLICY_CHECK': {
          const result = await activatePolicyCheck(target, instance, actorId)
          if (result.passed) await advance(instanceId, target.id, { ...errorContext, ...result.output }, actorId)
          break
        }
        case 'EVAL_GATE': {
          const result = await activateEvalGate(target, instance, actorId)
          if (result.passed) await advance(instanceId, target.id, result.output, actorId)
          break
        }
        case 'TIMER':
          await activateTimer(target, instance)
          break
        case 'SIGNAL_WAIT':
          await activateSignalWait(target, instance)
          break
        case 'CALL_WORKFLOW':
          await activateCallWorkflow(target, instance)
          break
        case 'WORK_ITEM':
          await activateWorkItem(target, instance, actorId)
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
        case 'EVENT_EMIT': {
          // "Emit an alert event on failure" — a natural error-boundary handler.
          // The failing node's error is already in errorContext._lastError, so a
          // payloadPath of `_lastError` surfaces it to the sink.
          const result = await activateEventEmit(target, instance, actorId)
          if (result.passed) await advance(instanceId, target.id, { ...errorContext, ...result.output }, actorId)
          break
        }
        case 'CUSTOM': {
          const cfg = (target.config ?? {}) as Record<string, unknown>
          const bt = cfg._baseType as string | undefined
          switch (bt) {
            case 'HUMAN_TASK': await activateHumanTask(target, instance); break
            case 'TOOL_REQUEST': await activateToolRequest(target, instance); break
            case 'GIT_PUSH': {
              const result = await activateGitPush(target, instance, actorId)
              if (result.pushed) await advance(instanceId, target.id, result.output, actorId)
              break
            }
            default: await activateHumanTask(target, instance); break
          }
          break
        }
      }
    }
    return { retried: false, recovered: true, instanceFailed: false }
  }

  // (2026-05-31) Failure isolation is the DEFAULT for every node type. A single
  // node failure must NOT cascade into failing the whole run + SAGA compensations
  // (which would undo / strand every previously-completed node — "all nodes
  // fail"). The node is already marked FAILED above; pause the instance so ONLY
  // the failing node shows failed, completed nodes are preserved, and the run
  // stays resumable (fix the cause + retry the node, or cancel to terminate).
  // ERROR_BOUNDARY edges (handled above) remain the way to express explicit
  // recovery routing.
  //
  // Workflows that genuinely need fail-fast + SAGA rollback can opt a node into
  // the legacy cascade behavior with config.failurePolicy = 'CASCADE'.
  const failurePolicy = String(cfg.failurePolicy ?? '').toUpperCase()
  if (failurePolicy !== 'CASCADE') {
    await prisma.workflowInstance.update({
      where: { id: instanceId },
      data: { status: 'PAUSED' },
    })
    await logEvent('WorkflowNodeFailureIsolated', 'WorkflowNode', nodeId, actorId, {
      instanceId,
      nodeType: executableNodeType(node),
      error: failure,
      note: 'Node failure isolated; instance paused (not failed), completed nodes preserved, no compensations.',
    })
    await publishOutbox('WorkflowInstance', instanceId, 'WorkflowPaused', { instanceId, blockedNodeId: nodeId })
    return { retried: false, recovered: false, instanceFailed: false }
  }

  // failurePolicy = CASCADE (opt-in) — legacy fail-fast: mark the instance FAILED
  // and run SAGA compensations for completed nodes that declared compensationConfig.
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
    await prisma.workflowNode.update({
      where: { id: node.id },
      data: { status: 'SKIPPED', completedAt: new Date() },
    })
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
