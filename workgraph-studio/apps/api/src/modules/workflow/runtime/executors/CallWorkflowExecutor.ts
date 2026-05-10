import type { WorkflowNode, WorkflowInstance, Prisma } from '@prisma/client'
import { prisma } from '../../../../lib/prisma'
import { logEvent, publishOutbox } from '../../../../lib/audit'

/**
 * CallWorkflowExecutor spawns a child WorkflowInstance from the configured
 * template, marking the linkage in `parentInstanceId` and `parentNodeId`.
 *
 * Config: { templateId: string, version?: number, inputMap?: Record<string, string> }
 */
export async function activateCallWorkflow(
  node: WorkflowNode,
  parent: WorkflowInstance,
): Promise<void> {
  const cfg = (node.config ?? {}) as Record<string, unknown>
  const std = (cfg.standard && typeof cfg.standard === 'object' && !Array.isArray(cfg.standard))
    ? cfg.standard as Record<string, string>
    : {} as Record<string, string>

  // templateId stored in standard.templateId by NodeInspector
  const templateId = std.templateId ?? (typeof cfg.templateId === 'string' ? cfg.templateId : null)
  if (!templateId) {
    // No template configured — leave node ACTIVE; user must configure or fail it.
    return
  }

  const template = await prisma.workflow.findUnique({ where: { id: templateId } })
  if (!template) return

  // inputMap: assignments KVPairs stored as assignments array by NodeInspector
  type KVPair = { key: string; value: string }
  const assignments = Array.isArray(cfg.assignments) ? cfg.assignments as KVPair[] : []
  const inputMap: Record<string, string> = {}
  for (const pair of assignments) {
    if (pair.key && pair.value) inputMap[pair.key] = pair.value
  }
  const parentCtx = (parent.context ?? {}) as Record<string, unknown>
  const childCtx: Record<string, unknown> = {}
  for (const [childKey, parentPath] of Object.entries(inputMap)) {
    childCtx[childKey] = parentPath.split('.').reduce<unknown>(
      (acc, k) => (acc && typeof acc === 'object') ? (acc as Record<string, unknown>)[k] : undefined,
      parentCtx,
    )
  }

  const child = await prisma.workflowInstance.create({
    data: {
      templateId,
      name: `${template.name} (child of ${parent.name})`,
      parentInstanceId: parent.id,
      parentNodeId: node.id,
      context: childCtx as Prisma.InputJsonValue,
      status: 'DRAFT',
    },
  })

  await logEvent('SubworkflowSpawned', 'WorkflowInstance', child.id, undefined, {
    parentInstanceId: parent.id,
    parentNodeId: node.id,
    templateId,
  })
  await publishOutbox('WorkflowInstance', child.id, 'SubworkflowSpawned', {
    parentInstanceId: parent.id,
    parentNodeId: node.id,
    childInstanceId: child.id,
  })

  // Track the child link in the parent node config so completion of the child
  // can advance the parent node.
  await prisma.workflowNode.update({
    where: { id: node.id },
    data: { config: { ...cfg, _childInstanceId: child.id } as Prisma.InputJsonValue },
  })
}
