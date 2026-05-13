import type { WorkflowNode, WorkflowInstance } from '@prisma/client'
import { prisma } from '../../../../lib/prisma'
import { logEvent, publishOutbox } from '../../../../lib/audit'
import {
  resolveAssignmentRouting,
  mirrorTeamQueueRouting,
  buildEntityRoutingFields,
  getTemplateCapabilityId,
} from '../../../task/lib/assignment'

export async function activateConsumableCreation(
  node: WorkflowNode,
  instance: WorkflowInstance,
): Promise<void> {
  const cfg = (node.config ?? {}) as Record<string, unknown>
  const typeId = cfg.consumableTypeId as string | undefined
  if (!typeId) return

  const capabilityId = await getTemplateCapabilityId(instance)
  const routing = await mirrorTeamQueueRouting(resolveAssignmentRouting(
    {
      assignmentMode: cfg.assignmentMode as string | undefined,
      assignedToId:   cfg.assignedToId   as string | undefined,
      teamId:         cfg.teamId         as string | undefined,
      roleKey:        cfg.roleKey        as string | undefined,
      skillKey:       cfg.skillKey       as string | undefined,
    },
    capabilityId,
    (instance.context ?? {}) as Record<string, unknown>,
  ))

  const fields = buildEntityRoutingFields(routing)

  const consumable = await prisma.consumable.create({
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
  })

  await logEvent('ConsumableCreated', 'Consumable', consumable.id, undefined, {
    nodeId:         node.id,
    instanceId:     instance.id,
    assignmentMode: routing.mode,
  })
  await publishOutbox('Consumable', consumable.id, 'ConsumableCreated', { consumableId: consumable.id })
}
