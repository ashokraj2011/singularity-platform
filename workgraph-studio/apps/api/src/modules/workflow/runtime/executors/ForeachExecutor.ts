import type { WorkflowNode, WorkflowInstance, Prisma } from '@prisma/client'
import { prisma } from '../../../../lib/prisma'

/**
 * ForeachExecutor records the iteration plan on the node config.
 * Real fan-out execution requires sub-workflow or inner-graph support;
 * MVP records the collection size and marks the node COMPLETED, treating each
 * item as a single context iteration produced by upstream tools.
 *
 * Config: { collectionPath: string, itemVar: string, parallel?: boolean, maxConcurrency?: number|string }
 * Designer stores standard fields under `standard`; maxConcurrency can be a
 * literal number, `globals.X`, or `{{globals.X}}`.
 */

function walk(root: Record<string, unknown> | undefined, path: string): unknown {
  if (!root) return undefined
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc !== null && typeof acc === 'object') return (acc as Record<string, unknown>)[key]
    return undefined
  }, root)
}

function resolvePath(ctx: Record<string, unknown>, path: string): unknown {
  const trimmed = path.trim()
  const match = trimmed.match(/^\{\{(.+?)\}\}$/)
  const ref = (match ? match[1] : trimmed).trim()
  if (ref.startsWith('globals.')) return walk(ctx._globals as Record<string, unknown>, ref.slice('globals.'.length))
  if (ref.startsWith('vars.')) return walk(ctx._vars as Record<string, unknown>, ref.slice('vars.'.length))
  if (ref.startsWith('params.')) return walk(ctx._params as Record<string, unknown>, ref.slice('params.'.length))
  const stripped = ref.startsWith('context.') ? ref.slice('context.'.length)
    : ref.startsWith('output.') ? ref.slice('output.'.length)
    : ref
  return walk(ctx, stripped)
}

function readStd(cfg: Record<string, unknown>): Record<string, unknown> {
  return cfg.standard && typeof cfg.standard === 'object' && !Array.isArray(cfg.standard)
    ? cfg.standard as Record<string, unknown>
    : {}
}

function readString(cfg: Record<string, unknown>, key: string): string | undefined {
  const std = readStd(cfg)
  const value = std[key] ?? cfg[key]
  return typeof value === 'string' ? value : undefined
}

function resolveNumber(value: unknown, ctx: Record<string, unknown>, fallback: number): number {
  const resolved = typeof value === 'string' && (value.includes('{{') || value.includes('.') || value.startsWith('globals'))
    ? resolvePath(ctx, value)
    : value
  const n = Number(resolved)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

export async function activateForeach(
  node: WorkflowNode,
  instance: WorkflowInstance,
): Promise<void> {
  const cfg = (node.config ?? {}) as Record<string, unknown>
  const std = readStd(cfg)
  const collectionPath = readString(cfg, 'collectionPath')
  const ctx = (instance.context ?? {}) as Record<string, unknown>

  let collection: unknown[] = []
  if (collectionPath) {
    const resolved = resolvePath(ctx, collectionPath)
    if (Array.isArray(resolved)) collection = resolved
  }
  const maxConcurrency = resolveNumber(std.maxConcurrency ?? cfg.maxConcurrency, ctx, 1)
  const parallel = String(std.parallel ?? cfg.parallel ?? '').toLowerCase() === 'true'

  await prisma.workflowNode.update({
    where: { id: node.id },
    data: {
      config: { ...cfg, _items: collection.length, _completed: 0, _parallel: parallel, _maxConcurrency: maxConcurrency } as Prisma.InputJsonValue,
    },
  })

  // For MVP, mark COMPLETED if collection is empty; otherwise leave ACTIVE for
  // an external orchestrator to fan out and signal back.
  if (collection.length === 0) {
    await prisma.workflowNode.update({
      where: { id: node.id },
      data: { status: 'COMPLETED', completedAt: new Date() },
    })
  }
}
