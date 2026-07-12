import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { currentTenantIdForDb, withTenantDbTransaction } from '../../lib/tenant-db-context'
import { NotFoundError, ValidationError } from '../../lib/errors'

const TERMINAL_WORK_ITEM_STATUSES = new Set(['COMPLETED', 'ARCHIVED'])

export async function listWorkItemDependencies(workItemId: string, tenantId?: string | null) {
  const scope = tenantId ?? undefined
  return withTenantDbTransaction(prisma, async tx => {
    const [predecessors, successors] = await Promise.all([
      tx.workItemDependency.findMany({ where: { successorId: workItemId, ...(scope ? { tenantId: scope } : {}) }, include: { predecessor: true }, orderBy: { createdAt: 'asc' } }),
      tx.workItemDependency.findMany({ where: { predecessorId: workItemId, ...(scope ? { tenantId: scope } : {}) }, include: { successor: true }, orderBy: { createdAt: 'asc' } }),
    ])
    return { predecessors, successors }
  }, scope ?? currentTenantIdForDb())
}

async function assertNoCycle(tx: Prisma.TransactionClient, predecessorId: string, successorId: string, tenantId?: string | null): Promise<void> {
  if (predecessorId === successorId) throw new ValidationError('A WorkItem cannot depend on itself')
  const edges = await tx.workItemDependency.findMany({
    where: tenantId ? { tenantId } : undefined,
    select: { predecessorId: true, successorId: true },
  })
  if (dependencyGraphWouldCycle(edges, predecessorId, successorId)) throw new ValidationError('This dependency would create a cycle')
}

export function dependencyGraphWouldCycle(edges: Array<{ predecessorId: string; successorId: string }>, predecessorId: string, successorId: string): boolean {
  if (predecessorId === successorId) return true
  const adjacency = new Map<string, string[]>()
  for (const edge of edges) adjacency.set(edge.predecessorId, [...(adjacency.get(edge.predecessorId) ?? []), edge.successorId])
  const seen = new Set<string>()
  const visit = (id: string): boolean => {
    if (id === predecessorId) return true
    if (seen.has(id)) return false
    seen.add(id)
    return (adjacency.get(id) ?? []).some(visit)
  }
  return visit(successorId)
}

export async function createWorkItemDependency(input: {
  predecessorId: string
  successorId: string
  dependencyType?: string
  condition?: unknown
  createdById?: string
  tenantId?: string | null
}) {
  const tenantId = input.tenantId ?? currentTenantIdForDb() ?? 'default'
  return withTenantDbTransaction(prisma, async tx => {
    const [predecessor, successor] = await Promise.all([
      tx.workItem.findUnique({ where: { id: input.predecessorId }, select: { id: true, tenantId: true } }),
      tx.workItem.findUnique({ where: { id: input.successorId }, select: { id: true, tenantId: true } }),
    ])
    if (!predecessor) throw new NotFoundError('WorkItem', input.predecessorId)
    if (!successor) throw new NotFoundError('WorkItem', input.successorId)
    if (predecessor.tenantId !== successor.tenantId || (predecessor.tenantId ?? 'default') !== tenantId) {
      throw new ValidationError('Dependency endpoints must belong to the same tenant')
    }
    await assertNoCycle(tx, input.predecessorId, input.successorId, predecessor.tenantId)
    return tx.workItemDependency.create({
      data: {
        predecessorId: input.predecessorId,
        successorId: input.successorId,
        dependencyType: String(input.dependencyType ?? 'BLOCKS').toUpperCase(),
        condition: input.condition as Prisma.InputJsonValue | undefined,
        createdById: input.createdById,
        tenantId: predecessor.tenantId ?? 'default',
      },
      include: { predecessor: true, successor: true },
    })
  }, tenantId)
}

export async function deleteWorkItemDependency(id: string, tenantId?: string | null) {
  const scope = tenantId ?? currentTenantIdForDb() ?? 'default'
  return withTenantDbTransaction(prisma, async tx => {
    const existing = await tx.workItemDependency.findFirst({ where: { id, tenantId: scope } })
    if (!existing) throw new NotFoundError('WorkItemDependency', id)
    return tx.workItemDependency.delete({ where: { id } })
  }, scope)
}

export async function getBlockingDependencies(workItemId: string, tenantId?: string | null) {
  const scope = tenantId ?? currentTenantIdForDb()
  return withTenantDbTransaction(prisma, tx => tx.workItemDependency.findMany({
    where: { successorId: workItemId, dependencyType: 'BLOCKS', ...(tenantId ? { tenantId } : {}) },
    include: { predecessor: { select: { id: true, workCode: true, title: true, status: true } } },
    orderBy: { createdAt: 'asc' },
  }), scope)
}

export async function assertWorkItemDependenciesComplete(workItemId: string, tenantId?: string | null): Promise<void> {
  const blockers = await getBlockingDependencies(workItemId, tenantId)
  const incomplete = blockers.filter(row => !TERMINAL_WORK_ITEM_STATUSES.has(row.predecessor.status))
  if (incomplete.length > 0) {
    throw new ValidationError(`WorkItem is blocked by ${incomplete.map(row => row.predecessor.workCode).join(', ')}`, {
      code: 'WORK_ITEM_DEPENDENCY_BLOCKED',
      details: { blockers: incomplete.map(row => ({ id: row.predecessor.id, workCode: row.predecessor.workCode, status: row.predecessor.status })) },
    })
  }
}
