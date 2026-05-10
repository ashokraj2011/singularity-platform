import { Prisma } from '@prisma/client'
import { prisma } from '../../../lib/prisma'
import { evaluateToolPolicy } from './PolicyEngine'
import { mockExecute } from './runners/MockExecutionRunner'
import { logEvent, createReceipt, publishOutbox } from '../../../lib/audit'
import { NotFoundError, ForbiddenError } from '../../../lib/errors'

export async function requestToolRun(
  toolId: string,
  actionId: string | undefined,
  instanceId: string | undefined,
  inputPayload: Record<string, unknown>,
  requestedById: string,
  idempotencyKey?: string,
): Promise<string> {
  const tool = await prisma.tool.findUnique({ where: { id: toolId }, include: { actions: true } })
  if (!tool) throw new NotFoundError('Tool', toolId)
  if (!tool.isActive) throw new ForbiddenError('Tool is disabled')

  // Idempotency: if a run with the same (toolId, idempotencyKey) exists, return it.
  if (idempotencyKey) {
    const existing = await prisma.toolRun.findFirst({
      where: { toolId, idempotencyKey },
    })
    if (existing) return existing.id
  }

  const action = actionId ? tool.actions.find(a => a.id === actionId) : tool.actions[0]

  // 1. Policy check
  const policyDecision = await evaluateToolPolicy(toolId, requestedById, inputPayload)
  if (policyDecision === 'DENY') {
    const run = await prisma.toolRun.create({
      data: { toolId, actionId, instanceId, inputPayload: inputPayload as unknown as Prisma.InputJsonValue, requestedById, idempotencyKey, status: 'REJECTED' },
    })
    await logEvent('ToolRunDenied', 'ToolRun', run.id, requestedById, { reason: 'PolicyDenied' })
    return run.id
  }

  // 2. Approval gate
  const needsApproval = policyDecision === 'REQUIRES_APPROVAL' || tool.requiresApproval
  if (needsApproval) {
    const run = await prisma.toolRun.create({
      data: { toolId, actionId, instanceId, inputPayload: inputPayload as unknown as Prisma.InputJsonValue, requestedById, idempotencyKey, status: 'PENDING_APPROVAL' },
    })
    await logEvent('ToolRequested', 'ToolRun', run.id, requestedById)
    await publishOutbox('ToolRun', run.id, 'ToolRequested', { runId: run.id, needsApproval: true })
    return run.id
  }

  // 3. Execute immediately (LOW risk / auto-approved)
  return executeToolRun(toolId, actionId, instanceId, inputPayload, requestedById, action?.name ?? 'execute', idempotencyKey)
}

export async function executeToolRun(
  toolId: string,
  actionId: string | undefined,
  instanceId: string | undefined,
  inputPayload: Record<string, unknown>,
  requestedById: string,
  actionName: string,
  idempotencyKey?: string,
): Promise<string> {
  const tool = await prisma.tool.findUnique({ where: { id: toolId } })
  if (!tool) throw new NotFoundError('Tool', toolId)

  const run = await prisma.toolRun.create({
    data: {
      toolId, actionId, instanceId, inputPayload: inputPayload as unknown as Prisma.InputJsonValue, requestedById,
      idempotencyKey,
      status: 'RUNNING', startedAt: new Date(),
    },
  })

  try {
    const output = await mockExecute(tool.name, actionName, inputPayload)
    await prisma.toolRun.update({
      where: { id: run.id },
      data: { status: 'COMPLETED', outputPayload: output as unknown as Prisma.InputJsonValue, completedAt: new Date() },
    })

    const eventId = await logEvent('ToolExecuted', 'ToolRun', run.id, requestedById, {
      toolId, actionName, output,
    })
    await createReceipt('TOOL_RUN_EXECUTION', 'ToolRun', run.id, {
      runId: run.id,
      toolId,
      actionName,
      inputPayload,
      outputPayload: output,
      executedBy: requestedById,
    }, eventId)
    await publishOutbox('ToolRun', run.id, 'ToolExecuted', { runId: run.id })

    return run.id
  } catch (err) {
    await prisma.toolRun.update({
      where: { id: run.id },
      data: { status: 'FAILED' },
    })
    throw err
  }
}
