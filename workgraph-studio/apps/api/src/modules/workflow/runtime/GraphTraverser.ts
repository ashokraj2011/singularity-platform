import type { WorkflowInstance, WorkflowNode, WorkflowEdge } from '@prisma/client'
import { prisma } from '../../../lib/prisma'
import { evaluateEdge } from './EdgeEvaluator'
import { logEvent } from '../../../lib/audit'

/**
 * Selects which edges to fire after `completedNode` finishes.
 *
 * Strategies (keyed off the source node's type):
 *   DECISION_GATE       — XOR (single branch).  Pick the first matching edge in
 *                         priority order; if none match, fire the edge marked
 *                         `condition.isDefault === true`; if no default exists
 *                         a `PathStall` audit event is emitted and **no**
 *                         downstream edges fire.
 *   INCLUSIVE_GATEWAY   — OR (one or more).  Fire all matching edges; if none
 *                         match, fire the default edge if present.
 *   anything else       — Plain fan-out.  Fire all edges that evaluate truthy.
 *
 * PARALLEL_JOIN edges are still handled via atomic increment of
 * `completed_joins` against `expected_joins`.
 */

type EdgeWithMeta = {
  edge: WorkflowEdge
  priority: number
  isDefault: boolean
}

function readEdgeMeta(edges: WorkflowEdge[]): EdgeWithMeta[] {
  return edges.map((edge, idx) => {
    const cond = (edge.condition ?? {}) as Record<string, unknown>
    return {
      edge,
      priority: typeof cond.priority === 'number' ? cond.priority : idx,
      isDefault: cond.isDefault === true,
    }
  })
}

function pickXor(edges: EdgeWithMeta[], context: Record<string, unknown>): EdgeWithMeta | null {
  const sorted = [...edges].sort((a, b) =>
    a.priority !== b.priority ? a.priority - b.priority : a.edge.id.localeCompare(b.edge.id),
  )
  // Skip default-marked edges in the matching pass — they only fire as fallback.
  for (const m of sorted) {
    if (m.isDefault) continue
    if (evaluateEdge(m.edge, context)) return m
  }
  // No match → look for a default-marked edge
  return sorted.find(m => m.isDefault) ?? null
}

function pickInclusive(edges: EdgeWithMeta[], context: Record<string, unknown>): EdgeWithMeta[] {
  const matched = edges.filter(m => !m.isDefault && evaluateEdge(m.edge, context))
  if (matched.length > 0) return matched
  const def = edges.find(m => m.isDefault)
  return def ? [def] : []
}

function pickAllMatching(edges: EdgeWithMeta[], context: Record<string, unknown>): EdgeWithMeta[] {
  // Default still acts as fallback for plain fan-out (non-gateway nodes don't
  // typically use defaults, but support it for consistency).
  const matched = edges.filter(m => !m.isDefault && evaluateEdge(m.edge, context))
  if (matched.length > 0) return matched
  const def = edges.find(m => m.isDefault)
  return def ? [def] : []
}

export async function resolveNextNodes(
  instance: WorkflowInstance,
  completedNode: WorkflowNode,
  outgoing: WorkflowEdge[],
  context: Record<string, unknown>,
): Promise<WorkflowNode[]> {
  // ── Step 1: split PARALLEL_JOIN edges out and route them through the join counter
  const joinEdges  = outgoing.filter(e => e.edgeType === 'PARALLEL_JOIN')
  const otherEdges = outgoing.filter(e => e.edgeType !== 'PARALLEL_JOIN' && e.edgeType !== 'ERROR_BOUNDARY')

  const out: WorkflowNode[] = []

  // ── Step 2: pick edges per strategy
  const meta = readEdgeMeta(otherEdges)
  let chosen: EdgeWithMeta[] = []

  if (completedNode.nodeType === 'DECISION_GATE') {
    const pick = pickXor(meta, context)
    if (pick) {
      chosen = [pick]
    } else if (meta.length > 0) {
      // No matching branch + no default → PathStall.  Audit + leave the
      // workflow in its current state so the caller (failNode/etc) can decide.
      await logEvent('PathStall', 'WorkflowNode', completedNode.id, undefined, {
        instanceId: instance.id,
        sourceNodeId: completedNode.id,
        reason: 'No matching branch and no default branch on DECISION_GATE',
      })
    }
  } else if (completedNode.nodeType === 'INCLUSIVE_GATEWAY') {
    chosen = pickInclusive(meta, context)
    if (chosen.length === 0 && meta.length > 0) {
      await logEvent('PathStall', 'WorkflowNode', completedNode.id, undefined, {
        instanceId: instance.id,
        sourceNodeId: completedNode.id,
        reason: 'No matching branch and no default branch on INCLUSIVE_GATEWAY',
      })
    }
  } else {
    chosen = pickAllMatching(meta, context)
  }

  // ── Step 3: hydrate WorkflowNodes for the chosen edges
  for (const m of chosen) {
    const targetNode = await prisma.workflowNode.findUnique({
      where: { id: m.edge.targetNodeId },
    })
    if (!targetNode) continue
    out.push(targetNode)
  }

  // ── Step 4: handle PARALLEL_JOIN with the same atomic increment as before
  for (const edge of joinEdges) {
    if (!evaluateEdge(edge, context)) continue
    const targetNode = await prisma.workflowNode.findUnique({ where: { id: edge.targetNodeId } })
    if (!targetNode) continue

    await prisma.$executeRaw`
      UPDATE workflow_nodes
      SET config = jsonb_set(
        config,
        '{completed_joins}',
        (COALESCE((config->>'completed_joins')::int, 0) + 1)::text::jsonb
      )
      WHERE id = ${targetNode.id}::uuid
    `
    const refreshed = await prisma.workflowNode.findUnique({ where: { id: targetNode.id } })
    if (!refreshed) continue
    const cfg = refreshed.config as Record<string, unknown>
    const expected  = Number(cfg.expected_joins ?? 0)
    const completed = Number(cfg.completed_joins ?? 0)
    if (completed >= expected) out.push(refreshed)
  }

  return out
}

export async function isComplete(instance: WorkflowInstance): Promise<boolean> {
  const activeOrPending = await prisma.workflowNode.count({
    where: {
      instanceId: instance.id,
      status: { in: ['PENDING', 'ACTIVE'] },
    },
  })
  return activeOrPending === 0
}
