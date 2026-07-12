import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { withTenantDbTransaction, currentTenantIdForDb } from '../../lib/tenant-db-context'
import { NotFoundError, ValidationError } from '../../lib/errors'
import { restartNode } from './runtime/WorkflowRuntime'

export async function simulateWorkflow(workflowId: string, actorId: string, input: Record<string, unknown>, maxSteps = 200) {
  const tenantId = currentTenantIdForDb() ?? 'default'
  const workflow = await withTenantDbTransaction(prisma, tx => tx.workflow.findUnique({
    where: { id: workflowId },
    include: { designNodes: true, designEdges: true },
  }), tenantId)
  if (!workflow) throw new NotFoundError('Workflow', workflowId)
  const incoming = new Set(workflow.designEdges.map(edge => edge.targetNodeId))
  const starts = workflow.designNodes.filter(node => node.nodeType === 'START' || !incoming.has(node.id))
  const queue = starts.map(node => node.id)
  const visited = new Set<string>()
  const steps: Array<Record<string, unknown>> = []
  const unresolved: Array<Record<string, unknown>> = []
  const agents: Array<Record<string, unknown>> = []
  const tools: Array<Record<string, unknown>> = []
  const approvals: Array<Record<string, unknown>> = []
  const sideEffects: Array<Record<string, unknown>> = []
  let estimatedTokens = 0
  let estimatedCost = 0
  let estimatedDurationSeconds = 0
  while (queue.length && steps.length < Math.min(Math.max(maxSteps, 1), 1000)) {
    const nodeId = queue.shift()!
    if (visited.has(nodeId)) continue
    visited.add(nodeId)
    const node = workflow.designNodes.find(candidate => candidate.id === nodeId)
    if (!node) continue
    const config = (node.config ?? {}) as Record<string, unknown>
    const requiresApproval = node.nodeType === 'APPROVAL' || config.requiresHumanApproval === true
    const nodeTokens = Number(config.estimatedTokens ?? config.estimatedTotalTokens ?? (node.nodeType === 'AGENT_TASK' || node.nodeType === 'DIRECT_LLM_TASK' || node.nodeType === 'VERIFIER' ? 2000 : 0))
    const nodeCost = Number(config.estimatedCost ?? 0)
    const nodeDuration = Number(config.estimatedDurationSeconds ?? config.timeoutSeconds ?? (node.nodeType === 'APPROVAL' ? 86_400 : 5))
    estimatedTokens += Number.isFinite(nodeTokens) ? Math.max(0, nodeTokens) : 0
    estimatedCost += Number.isFinite(nodeCost) ? Math.max(0, nodeCost) : 0
    estimatedDurationSeconds += Number.isFinite(nodeDuration) ? Math.max(0, nodeDuration) : 0
    const step = { nodeId: node.id, label: node.label, nodeType: node.nodeType, executionLocation: node.executionLocation, status: 'WOULD_RUN', requiresApproval, estimatedTokens: nodeTokens, estimatedCost: nodeCost, estimatedDurationSeconds: nodeDuration, sideEffectFree: true }
    steps.push(step)
    if (requiresApproval) {
      const approval = { nodeId: node.id, label: node.label, reason: 'Human approval required at runtime', assignmentMode: config.assignmentMode ?? config.approvalAssignmentMode ?? 'ROLE_BASED', roleKey: config.roleKey ?? config.approvalRoleKey, skillKey: config.skillKey ?? config.approvalSkillKey }
      unresolved.push(approval)
      approvals.push(approval)
    }
    if (node.nodeType === 'AGENT_TASK' || node.nodeType === 'DIRECT_LLM_TASK' || node.nodeType === 'VERIFIER') {
      agents.push({ nodeId: node.id, label: node.label, agentTemplateId: config.agentTemplateId ?? config.agentId, modelAlias: config.modelAlias ?? config.llmAlias, estimatedTokens: nodeTokens })
    }
    if (node.nodeType === 'TOOL_REQUEST' || node.nodeType === 'GIT_PUSH' || node.nodeType === 'RAISE_PR' || node.nodeType === 'CREATE_BRANCH') {
      tools.push({ nodeId: node.id, label: node.label, tool: config.tool ?? config.toolName ?? node.nodeType, executionLocation: node.executionLocation })
    }
    if (!['START', 'END', 'SET_CONTEXT', 'DECISION_GATE', 'PARALLEL_FORK', 'PARALLEL_JOIN'].includes(String(node.nodeType))) {
      sideEffects.push({ nodeId: node.id, type: node.nodeType, guarded: true, wouldExecute: true })
    }
    workflow.designEdges.filter(edge => edge.sourceNodeId === nodeId).forEach(edge => queue.push(edge.targetNodeId))
  }
  const result = {
    workflowId,
    input,
    mode: 'SIDE_EFFECT_FREE',
    sideEffectFree: true,
    steps,
    unresolved,
    predictedPath: steps.map(step => step.nodeId),
    agents,
    tools,
    approvals,
    sideEffects,
    truncated: queue.length > 0,
    summary: {
      nodeCount: steps.length,
      approvalCount: approvals.length,
      agentCount: agents.length,
      toolCount: tools.length,
      estimatedTokens,
      estimatedCost,
      estimatedDurationSeconds,
    },
  }
  const simulation = await withTenantDbTransaction(prisma, tx => tx.workflowSimulation.create({
    data: {
      workflowTemplateId: workflowId,
      createdById: actorId,
      tenantId,
      input: input as Prisma.InputJsonValue,
      result: result as Prisma.InputJsonValue,
      completedAt: new Date(),
    },
  }), tenantId)
  return { simulation, result }
}

export async function replayWorkflow(instanceId: string, actorId: string, checkpointId: string | undefined, mode: 'DRY_RUN' | 'RESUME') {
  const tenantId = currentTenantIdForDb() ?? 'default'
  const instance = await withTenantDbTransaction(prisma, tx => tx.workflowInstance.findUnique({ where: { id: instanceId }, include: { nodes: true } }), tenantId)
  if (!instance) throw new NotFoundError('WorkflowInstance', instanceId)
  const checkpoint = checkpointId
    ? await withTenantDbTransaction(prisma, tx => tx.workflowCheckpoint.findFirst({ where: { id: checkpointId, instanceId } }), tenantId)
    : await withTenantDbTransaction(prisma, tx => tx.workflowCheckpoint.findFirst({ where: { instanceId }, orderBy: { sequence: 'desc' } }), tenantId)
  if (!checkpoint) throw new ValidationError('No checkpoint exists for this workflow instance')
  const nodeStates = (checkpoint.nodeStates ?? {}) as Record<string, { status?: string }>
  const currentStates = Object.fromEntries(instance.nodes.map(node => [node.id, { status: node.status }]))
  const result = { mode, checkpointId: checkpoint.id, restoredContext: checkpoint.context, nodeStates, currentStates }
  const replay = await withTenantDbTransaction(prisma, tx => tx.workflowReplay.create({
    data: { instanceId, checkpointId: checkpoint.id, requestedById: actorId, status: 'REQUESTED', input: { mode } as Prisma.InputJsonValue },
  }), tenantId)
  if (mode === 'DRY_RUN') {
    const completed = await withTenantDbTransaction(prisma, tx => tx.workflowReplay.update({ where: { id: replay.id }, data: { status: 'COMPLETED', result: result as Prisma.InputJsonValue, completedAt: new Date() } }), tenantId)
    return { replay: completed, result }
  }
  try {
    if (!['PAUSED', 'FAILED', 'ACTIVE'].includes(instance.status)) {
      throw new ValidationError(`Workflow instance cannot be resumed from status ${instance.status}`)
    }
    await withTenantDbTransaction(prisma, async tx => {
      await tx.workflowInstance.update({ where: { id: instanceId }, data: { context: checkpoint.context as Prisma.InputJsonValue, status: 'ACTIVE' } })
      for (const [nodeId, state] of Object.entries(nodeStates)) {
        if (state.status) await tx.workflowNode.updateMany({ where: { id: nodeId, instanceId }, data: { status: state.status as any } })
      }
    }, tenantId)
    // A checkpoint is taken immediately after a node completes and before its
    // downstream activation. Restarting that node replays the exact boundary;
    // it does not restart the graph from its root as startInstance would.
    const replayNodeId = checkpoint.nodeId ?? Object.entries(nodeStates).find(([, state]) => state.status === 'ACTIVE')?.[0]
    if (!replayNodeId) throw new ValidationError('Checkpoint has no replayable node boundary')
    await restartNode(instanceId, replayNodeId, actorId, instance.tenantId ?? undefined)
    const completed = await withTenantDbTransaction(prisma, tx => tx.workflowReplay.update({ where: { id: replay.id }, data: { status: 'COMPLETED', result: result as Prisma.InputJsonValue, completedAt: new Date() } }), tenantId)
    return { replay: completed, result }
  } catch (err) {
    await withTenantDbTransaction(prisma, tx => tx.workflowReplay.update({ where: { id: replay.id }, data: { status: 'FAILED', error: err instanceof Error ? err.message : String(err), result: result as Prisma.InputJsonValue, completedAt: new Date() } }), tenantId).catch(() => undefined)
    throw err
  }
}
