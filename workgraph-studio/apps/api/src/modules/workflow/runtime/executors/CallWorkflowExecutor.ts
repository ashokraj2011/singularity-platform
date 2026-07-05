import type { WorkflowNode, WorkflowInstance, Prisma } from '@prisma/client'
import { prisma } from '../../../../lib/prisma'
import { withTenantDbTransaction } from '../../../../lib/tenant-db-context'
import { logEvent, publishOutbox } from '../../../../lib/audit'
import { cloneDesignToRun } from '../../lib/cloneDesignToRun'

// Statuses a child can be in where re-spawning would be wrong.
const NON_TERMINAL_CHILD_STATUSES = new Set(['DRAFT', 'PENDING', 'ACTIVE', 'PAUSED'])

/**
 * CallWorkflowExecutor spawns a child WorkflowInstance from the configured
 * template, marking the linkage in `parentInstanceId` and `parentNodeId`.
 *
 * Config: { templateId: string, version?: number, inputMap?: Record<string, string> }
 *
 * M94.6 (2026-05-28) — Bug fix: previously this created a bare DRAFT
 * WorkflowInstance with NO cloned design graph and never started it, so
 * the child sat DRAFT forever and the parent CALL_WORKFLOW node hung
 * ACTIVE indefinitely (it advances only on child completion). There was
 * also no idempotency guard, so a re-activated node spawned a fresh
 * orphan child each time. Repro: the M94.3 agentic-starter "Run agent
 * loop" node pointing at a workbench-profile child template — 3 empty
 * DRAFT children, parent stuck at 20%.
 *
 * Now: clone the template's design graph into runtime nodes (via the
 * same cloneDesignToRun the WorkItem-start path uses — which also
 * inherits the template's profile, M85.s4), link parent ↔ child, then
 * startInstance() the child so it actually runs. Idempotent: if a
 * non-terminal child is already linked, do nothing.
 */
export async function activateCallWorkflow(
  node: WorkflowNode,
  parent: WorkflowInstance,
): Promise<void> {
  const cfg = (node.config ?? {}) as Record<string, unknown>
  const tenantId = parent.tenantId ?? undefined
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
  if (!template) {
    // A configured CALL_WORKFLOW whose target template no longer exists (deleted,
    // or a stale/typo'd id) must FAIL the node with a clear reason — the previous
    // silent `return` left the node ACTIVE forever with no signal to the operator.
    const { failNode } = await import('../WorkflowRuntime')
    await failNode(node.instanceId, node.id, {
      message: `CALL_WORKFLOW target workflow template not found: ${templateId}`,
      code: 'CALL_WORKFLOW_TEMPLATE_MISSING',
    }, parent.createdById ?? undefined, parent.tenantId ?? undefined)
    return
  }

  // ── Idempotency guard ────────────────────────────────────────────────────
  // If a child is already linked and still running, don't spawn another.
  const existingChildId = typeof cfg._childInstanceId === 'string' ? cfg._childInstanceId : null
  if (existingChildId) {
    const existing = await withTenantDbTransaction(prisma, (tx) => tx.workflowInstance.findUnique({
      where: { id: existingChildId },
      select: { id: true, status: true },
    }), tenantId)
    if (existing && NON_TERMINAL_CHILD_STATUSES.has(existing.status)) {
      // Already have a live child. If it never started (stuck DRAFT),
      // kick it now; otherwise leave it be.
      if (existing.status === 'DRAFT') {
        const { startInstance } = await import('../WorkflowRuntime')
        await startInstance(existing.id, parent.createdById ?? undefined, parent.tenantId ?? undefined)
      }
      return
    }
  }

  // ── Build child context from inputMap + parent vars ───────────────────────
  // inputMap: assignments KVPairs stored as assignments array by NodeInspector
  type KVPair = { key: string; value: string }
  const assignments = Array.isArray(cfg.assignments) ? cfg.assignments as KVPair[] : []
  const inputMap: Record<string, string> = {}
  for (const pair of assignments) {
    if (pair.key && pair.value) inputMap[pair.key] = pair.value
  }
  const parentCtx = (parent.context ?? {}) as Record<string, unknown>
  const mappedVars: Record<string, unknown> = {}
  for (const [childKey, parentPath] of Object.entries(inputMap)) {
    mappedVars[childKey] = parentPath.split('.').reduce<unknown>(
      (acc, k) => (acc && typeof acc === 'object') ? (acc as Record<string, unknown>)[k] : undefined,
      parentCtx,
    )
  }
  // Inherit the parent's _vars (story / repoUrl / etc.) so a workbench
  // child has the inputs it needs, with explicit inputMap entries winning.
  const parentVars = (parentCtx._vars && typeof parentCtx._vars === 'object' && !Array.isArray(parentCtx._vars))
    ? parentCtx._vars as Record<string, unknown>
    : {}
  const childVars = { ...parentVars, ...mappedVars }

  // ── Clone the design graph into a runnable child instance ─────────────────
  // cloneDesignToRun copies phases/nodes/edges, hydrates _vars/_globals, and
  // sets profile from the template (workbench inheritance, M85.s4). Throws
  // if the template has no design nodes.
  const result = await cloneDesignToRun({
    templateId,
    name: `${template.name} (child of ${parent.name})`,
    vars: childVars,
    createdById: parent.createdById ?? undefined,
  })
  const childId = result.instance.id

  // Link parent ↔ child so child completion can advance this node.
  await withTenantDbTransaction(prisma, (tx) => tx.workflowInstance.update({
    where: { id: childId },
    data: { parentInstanceId: parent.id, parentNodeId: node.id },
  }), tenantId)

  await logEvent('SubworkflowSpawned', 'WorkflowInstance', childId, undefined, {
    parentInstanceId: parent.id,
    parentNodeId: node.id,
    templateId,
    clonedNodes: result.cloned.nodes,
  })
  await publishOutbox('WorkflowInstance', childId, 'SubworkflowSpawned', {
    parentInstanceId: parent.id,
    parentNodeId: node.id,
    childInstanceId: childId,
  })

  // Track the child link in the parent node config so completion of the child
  // can advance the parent node.
  await withTenantDbTransaction(prisma, (tx) => tx.workflowNode.update({
    where: { id: node.id },
    data: { config: { ...cfg, _childInstanceId: childId } as Prisma.InputJsonValue },
  }), tenantId)

  // ── Actually run the child ────────────────────────────────────────────────
  // Dynamic import avoids the WorkflowRuntime ↔ CallWorkflowExecutor cycle.
  const { startInstance } = await import('../WorkflowRuntime')
  await startInstance(childId, parent.createdById ?? undefined, parent.tenantId ?? undefined)
}
