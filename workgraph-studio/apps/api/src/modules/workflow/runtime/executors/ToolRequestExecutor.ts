import type { WorkflowNode, WorkflowInstance } from '@prisma/client'
import { Prisma } from '@prisma/client'
import { prisma } from '../../../../lib/prisma'
import { logEvent, publishOutbox } from '../../../../lib/audit'

export async function activateToolRequest(
  node: WorkflowNode,
  instance: WorkflowInstance,
): Promise<void> {
  const cfg = node.config as Record<string, unknown>
  const toolId = cfg.toolId as string | undefined
  if (!toolId) return

  // Idempotency key: deterministic per (instance, node, attempt). Retries reuse the key
  // so a re-execution returns the existing run instead of creating a duplicate.
  const attempt = Number(cfg._attempts ?? 0)
  const idempotencyKey = `${instance.id}:${node.id}:${attempt}`

  // Dedupe: if a run with this key already exists, skip creation.
  const existing = await prisma.toolRun.findFirst({ where: { toolId, idempotencyKey } })
  if (existing) {
    await logEvent('ToolRequestDeduplicated', 'ToolRun', existing.id, undefined, {
      nodeId: node.id, instanceId: instance.id, idempotencyKey,
    })
    return
  }

  const run = await prisma.toolRun.create({
    data: {
      toolId,
      actionId: cfg.actionId as string | undefined,
      instanceId: instance.id,
      inputPayload: ((cfg.inputPayload as Record<string, unknown>) ?? {}) as unknown as Prisma.InputJsonValue,
      requestedById: instance.createdById ?? undefined,
      idempotencyKey,
    },
  })

  await logEvent('ToolRequested', 'ToolRun', run.id, undefined, {
    nodeId: node.id,
    instanceId: instance.id,
    idempotencyKey,
  })
  await publishOutbox('ToolRun', run.id, 'ToolRequested', { runId: run.id })
}
