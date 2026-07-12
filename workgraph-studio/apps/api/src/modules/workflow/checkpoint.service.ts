import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { withTenantDbTransaction, currentTenantIdForDb } from '../../lib/tenant-db-context'
import { NotFoundError } from '../../lib/errors'

export async function createWorkflowCheckpoint(instanceId: string, actorId?: string, reason?: string, nodeId?: string, tenantId?: string) {
  const scopedTenant = tenantId ?? currentTenantIdForDb()
  const instance = await withTenantDbTransaction(prisma, tx => tx.workflowInstance.findUnique({ where: { id: instanceId }, include: { nodes: true } }), scopedTenant)
  if (!instance) throw new NotFoundError('WorkflowInstance', instanceId)
  const context = instance.context as Record<string, unknown>
  return withTenantDbTransaction(prisma, async tx => {
    const latest = await tx.workflowCheckpoint.findFirst({ where: { instanceId }, orderBy: { sequence: 'desc' }, select: { sequence: true } })
    return tx.workflowCheckpoint.create({
      data: {
        instanceId,
        sequence: (latest?.sequence ?? 0) + 1,
        checkpointType: reason ? 'MANUAL' : 'AUTO',
        nodeId,
        nodeStates: Object.fromEntries(instance.nodes.map(node => [node.id, { status: node.status, startedAt: node.startedAt, completedAt: node.completedAt }])) as Prisma.InputJsonValue,
        context: instance.context as Prisma.InputJsonValue,
        traceId: typeof context.traceId === 'string' ? context.traceId : undefined,
        reason,
        createdById: actorId,
      },
    })
  }, scopedTenant)
}

export async function listWorkflowCheckpoints(instanceId: string, tenantId?: string) {
  return withTenantDbTransaction(prisma, tx => tx.workflowCheckpoint.findMany({ where: { instanceId }, orderBy: { sequence: 'desc' }, take: 100 }), tenantId ?? currentTenantIdForDb())
}
