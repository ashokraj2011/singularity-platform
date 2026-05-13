import type { WorkflowNode, WorkflowInstance } from '@prisma/client'
import { Prisma } from '@prisma/client'
import { prisma } from '../../../../lib/prisma'

// PARALLEL_JOIN (AND-join) sets expected_joins from config so GraphTraverser's
// atomic counter knows when all branches have arrived.

function walk(root: Record<string, unknown> | undefined, path: string): unknown {
  if (!root) return undefined
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc !== null && typeof acc === 'object') return (acc as Record<string, unknown>)[key]
    return undefined
  }, root)
}

function resolvePath(ctx: Record<string, unknown>, value: unknown): unknown {
  if (typeof value !== 'string') return value
  const match = value.trim().match(/^\{\{(.+?)\}\}$/)
  const ref = (match ? match[1] : value).trim()
  if (ref.startsWith('globals.')) return walk(ctx._globals as Record<string, unknown>, ref.slice('globals.'.length))
  if (ref.startsWith('vars.')) return walk(ctx._vars as Record<string, unknown>, ref.slice('vars.'.length))
  if (ref.startsWith('params.')) return walk(ctx._params as Record<string, unknown>, ref.slice('params.'.length))
  return value
}

function expectedBranches(cfg: Record<string, unknown>, ctx: Record<string, unknown>): number {
  const std = cfg.standard && typeof cfg.standard === 'object' && !Array.isArray(cfg.standard)
    ? cfg.standard as Record<string, unknown>
    : {}
  const n = Number(resolvePath(ctx, cfg.expectedBranches ?? std.expectedBranches ?? 2))
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 2
}

export async function activateParallelJoin(
  node: WorkflowNode,
  instance: WorkflowInstance,
): Promise<void> {
  const cfg = (node.config ?? {}) as Record<string, unknown>
  const expected = expectedBranches(cfg, (instance.context ?? {}) as Record<string, unknown>)

  await prisma.workflowNode.update({
    where: { id: node.id },
    data: {
      status: 'ACTIVE',
      startedAt: new Date(),
      config: { ...cfg, expected_joins: expected, completed_joins: 0 } as Prisma.InputJsonValue,
    },
  })
}
