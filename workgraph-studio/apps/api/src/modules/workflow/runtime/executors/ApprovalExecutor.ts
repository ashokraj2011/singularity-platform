import type { WorkflowNode, WorkflowInstance } from '@prisma/client'
import { prisma } from '../../../../lib/prisma'
import { logEvent, publishOutbox } from '../../../../lib/audit'
import {
  resolveAssignmentRouting,
  mirrorTeamQueueRouting,
  buildEntityRoutingFields,
  getTemplateCapabilityId,
} from '../../../task/lib/assignment'

export async function activateApproval(
  node: WorkflowNode,
  instance: WorkflowInstance,
  actorId?: string,
): Promise<void> {
  const cfg = (node.config ?? {}) as Record<string, unknown>

  const capabilityId = await getTemplateCapabilityId(instance)
  // Approvals historically used `approverUserId`; keep that as a fallback for
  // legacy workflows that haven't migrated to the structured assignmentMode.
  const legacyApprover = cfg.approverUserId as string | undefined
  const routing = await mirrorTeamQueueRouting(resolveAssignmentRouting(
    {
      assignmentMode: (cfg.assignmentMode as string | undefined) ?? (legacyApprover ? 'DIRECT_USER' : undefined),
      assignedToId:   (cfg.assignedToId  as string | undefined) ?? legacyApprover,
      teamId:         cfg.teamId   as string | undefined,
      roleKey:        cfg.roleKey  as string | undefined,
      skillKey:       cfg.skillKey as string | undefined,
    },
    capabilityId,
    (instance.context ?? {}) as Record<string, unknown>,
  ))

  const fields = buildEntityRoutingFields(routing)

  const request = await prisma.approvalRequest.create({
    data: {
      instanceId:     instance.id,
      nodeId:         node.id,
      subjectType:    'WorkflowNode',
      subjectId:      node.id,
      requestedById:  actorId ?? instance.createdById ?? 'system',
      assignedToId:   fields.assignedToId,
      assignmentMode: fields.assignmentMode,
      teamId:         fields.teamId,
      roleKey:        fields.roleKey,
      skillKey:       fields.skillKey,
      capabilityId:   fields.capabilityId,
    },
  })

  await logEvent('ApprovalRequested', 'ApprovalRequest', request.id, actorId, {
    nodeId:         node.id,
    instanceId:     instance.id,
    assignmentMode: routing.mode,
    teamId:         routing.teamId,
    roleKey:        routing.roleKey,
    skillKey:       routing.skillKey,
    capabilityId:   routing.capabilityId,
  })
  await publishOutbox('ApprovalRequest', request.id, 'ApprovalRequested', { requestId: request.id })
}
