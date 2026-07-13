import type { WorkflowNode, WorkflowInstance } from '@prisma/client'
import { prisma } from '../../../../lib/prisma'
import { withTenantDbTransaction } from '../../../../lib/tenant-db-context'
import { logEvent, publishOutbox } from '../../../../lib/audit'
import {
  resolveAssignmentRouting,
  mirrorTeamQueueRouting,
  buildEntityRoutingFields,
  getTemplateCapabilityId,
  assertAssignmentResolved,
} from '../../../task/lib/assignment'

export async function activateConsumableCreation(
  node: WorkflowNode,
  instance: WorkflowInstance,
): Promise<void> {
  const cfg = (node.config ?? {}) as Record<string, unknown>
  const typeId = cfg.consumableTypeId as string | undefined
  if (!typeId) return
  const standard = cfg.standard && typeof cfg.standard === 'object' && !Array.isArray(cfg.standard)
    ? cfg.standard as Record<string, unknown>
    : {}
  const configuredRole = (cfg.roleKey as string | undefined)
    ?? (typeof standard.role === 'string' ? standard.role : undefined)
  const configuredMode = (cfg.assignmentMode as string | undefined) ?? (configuredRole ? 'ROLE_BASED' : undefined)

  const capabilityId = await getTemplateCapabilityId(instance)
  const routing = await mirrorTeamQueueRouting(resolveAssignmentRouting(
    {
      assignmentMode: configuredMode,
      assignedToId:   cfg.assignedToId   as string | undefined,
      teamId:         cfg.teamId         as string | undefined,
      roleKey:        configuredRole,
      skillKey:       cfg.skillKey       as string | undefined,
    },
    capabilityId,
    (instance.context ?? {}) as Record<string, unknown>,
  ))
  assertAssignmentResolved({
    assignmentMode: configuredMode,
    assignedToId: cfg.assignedToId as string | undefined,
    teamId: cfg.teamId as string | undefined,
    roleKey: configuredRole,
    skillKey: cfg.skillKey as string | undefined,
  }, routing, `Consumable "${node.label}"`)

  const fields = buildEntityRoutingFields(routing)

  const consumable = await withTenantDbTransaction(prisma, (tx) => tx.consumable.create({
    data: {
      typeId,
      instanceId:     instance.id,
      nodeId:         node.id,
      name:           node.label,
      createdById:    instance.createdById ?? undefined,
      assignedToId:   fields.assignedToId,
      assignmentMode: fields.assignmentMode,
      teamId:         fields.teamId,
      roleKey:        fields.roleKey,
      skillKey:       fields.skillKey,
      capabilityId:   fields.capabilityId,
    },
  }), instance.tenantId ?? undefined)

  await logEvent('ConsumableCreated', 'Consumable', consumable.id, undefined, {
    nodeId:         node.id,
    instanceId:     instance.id,
    assignmentMode: routing.mode,
  })
  await publishOutbox('Consumable', consumable.id, 'ConsumableCreated', { consumableId: consumable.id })
}
