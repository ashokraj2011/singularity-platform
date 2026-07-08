import { Prisma, type WorkflowInstance, type WorkflowNode, type WorkflowEdge } from '@prisma/client'
import { prisma } from '../../../lib/prisma'
import { withTenantDbTransaction } from '../../../lib/tenant-db-context'
import { evaluateEdge } from './EdgeEvaluator'
import { logEvent } from '../../../lib/audit'

/**
 * Selects which edges to fire after `completedNode` finishes.
 *
 * Strategies (keyed off the source node's type):
 *   DECISION_GATE       — XOR (single branch).  Pick the first matching edge in
 *                         priority order; if none match, fire the edge marked
 *                         `condition.isDefault === true`; if no default exists
 *                         the source gateway is BLOCKED and the run is PAUSED
 *                         with `_blockedByPathStall` details.
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

function walk(root: Record<string, unknown> | undefined, path: string): unknown {
  if (!root) return undefined
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc !== null && typeof acc === 'object') return (acc as Record<string, unknown>)[key]
    return undefined
  }, root)
}

function resolveRef(context: Record<string, unknown>, value: unknown): unknown {
  if (typeof value !== 'string') return value
  const match = value.trim().match(/^\{\{(.+?)\}\}$/)
  const ref = (match ? match[1] : value).trim()
  if (ref.startsWith('globals.')) return walk(context._globals as Record<string, unknown>, ref.slice('globals.'.length))
  if (ref.startsWith('vars.')) return walk(context._vars as Record<string, unknown>, ref.slice('vars.'.length))
  if (ref.startsWith('params.')) return walk(context._params as Record<string, unknown>, ref.slice('params.'.length))
  return value
}

function expectedJoinCount(cfg: Record<string, unknown>, context: Record<string, unknown>): number {
  const std = cfg.standard && typeof cfg.standard === 'object' && !Array.isArray(cfg.standard)
    ? cfg.standard as Record<string, unknown>
    : {}
  const n = Number(resolveRef(context, cfg.expected_joins ?? cfg.expectedBranches ?? std.expectedBranches ?? 0))
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

async function blockPathStall(
  instance: WorkflowInstance,
  completedNode: WorkflowNode,
  context: Record<string, unknown>,
  reason: string,
  edges: EdgeWithMeta[],
): Promise<void> {
  const tenantId = instance.tenantId ?? undefined
  const block = {
    status: 'BLOCKED',
    code: 'PATH_STALL',
    reason,
    message: reason,
    sourceNodeId: completedNode.id,
    sourceNodeLabel: completedNode.label,
    nodeType: completedNode.nodeType,
    outgoingEdgeIds: edges.map(e => e.edge.id),
    retryable: true,
    fixCommands: [
      'Open the workflow designer, add a default branch or fix the branch conditions, then restart or force-complete this gate.',
    ],
  }
  await withTenantDbTransaction(prisma, async (tx) => {
    await tx.workflowNode.update({
      where: { id: completedNode.id },
      data: { status: 'BLOCKED', completedAt: new Date() },
    })
    await tx.workflowInstance.update({
      where: { id: instance.id },
      data: {
        status: 'PAUSED',
        context: { ...context, _blockedByPathStall: block } as unknown as Prisma.InputJsonValue,
      },
    })
    await tx.workflowMutation.create({
      data: {
        instanceId: instance.id,
        nodeId: completedNode.id,
        mutationType: 'PATH_STALL_BLOCKED',
        beforeState: { status: completedNode.status } as Prisma.InputJsonValue,
        afterState: block as Prisma.InputJsonValue,
      },
    })
  }, tenantId)
  await logEvent('PathStallBlocked', 'WorkflowNode', completedNode.id, undefined, {
    instanceId: instance.id,
    sourceNodeId: completedNode.id,
    reason,
    outgoingEdgeIds: edges.map(e => e.edge.id),
  })
}

export async function resolveNextNodes(
  instance: WorkflowInstance,
  completedNode: WorkflowNode,
  outgoing: WorkflowEdge[],
  context: Record<string, unknown>,
): Promise<WorkflowNode[]> {
  // RLS prep — instance is always in scope for callers (activateDownstream),
  // so derive tenantId here rather than adding a parameter.
  const tenantId = instance.tenantId ?? undefined
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
      await blockPathStall(
        instance,
        completedNode,
        context,
        'No matching branch and no default branch on DECISION_GATE',
        meta,
      )
    }
  } else if (completedNode.nodeType === 'INCLUSIVE_GATEWAY') {
    chosen = pickInclusive(meta, context)
    if (chosen.length === 0 && meta.length > 0) {
      await blockPathStall(
        instance,
        completedNode,
        context,
        'No matching branch and no default branch on INCLUSIVE_GATEWAY',
        meta,
      )
    }
  } else {
    chosen = pickAllMatching(meta, context)
  }

  // ── Step 3: hydrate WorkflowNodes for the chosen edges
  for (const m of chosen) {
    const targetNode = await withTenantDbTransaction(
      prisma,
      (tx) => tx.workflowNode.findUnique({ where: { id: m.edge.targetNodeId } }),
      tenantId,
    )
    if (!targetNode) continue
    out.push(targetNode)
  }

  // ── Step 4: handle PARALLEL_JOIN with the same atomic increment as before
  for (const edge of joinEdges) {
    if (!evaluateEdge(edge, context)) continue
    const targetNode = await withTenantDbTransaction(
      prisma,
      (tx) => tx.workflowNode.findUnique({ where: { id: edge.targetNodeId } }),
      tenantId,
    )
    if (!targetNode) continue

    // Read-modify-write + re-fetch grouped into one transaction (was 2 separate
    // statements under Postgres's default READ COMMITTED — the re-fetch already
    // saw its own prior write either way, so grouping only adds tenant scope,
    // not new atomicity).
    const refreshed = await withTenantDbTransaction(prisma, async (tx) => {
      await tx.$executeRaw`
        UPDATE workflow_nodes
        SET config = jsonb_set(
          config,
          '{completed_joins}',
          (COALESCE((config->>'completed_joins')::int, 0) + 1)::text::jsonb
        )
        WHERE id = ${targetNode.id}::uuid
      `
      return tx.workflowNode.findUnique({ where: { id: targetNode.id } })
    }, tenantId)
    if (!refreshed) continue
    const cfg = refreshed.config as Record<string, unknown>
    const expected  = expectedJoinCount(cfg, context)
    const completed = Number(cfg.completed_joins ?? 0)
    if (expected > 0 && completed >= expected) out.push(refreshed)
  }

  return out
}

export async function isComplete(instance: WorkflowInstance): Promise<boolean> {
  const activeOrPending = await withTenantDbTransaction(
    prisma,
    (tx) => tx.workflowNode.count({
      where: {
        instanceId: instance.id,
        status: { in: ['PENDING', 'ACTIVE'] },
      },
    }),
    instance.tenantId ?? undefined,
  )
  return activeOrPending === 0
}
