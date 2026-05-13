import type { WorkflowNode, WorkflowInstance } from '@prisma/client'
import { prisma } from '../../../../lib/prisma'
import { logEvent, publishOutbox } from '../../../../lib/audit'
import {
  resolveAssignmentRouting,
  mirrorTeamQueueRouting,
  buildTaskAssignmentInputs,
  getTemplateCapabilityId,
} from '../../../task/lib/assignment'

export async function activateHumanTask(
  node: WorkflowNode,
  instance: WorkflowInstance,
): Promise<void> {
  const cfg = (node.config ?? {}) as Record<string, unknown>

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

  const inputs = buildTaskAssignmentInputs(routing)

  const task = await prisma.task.create({
    data: {
      instanceId:     instance.id,
      nodeId:         node.id,
      title:          node.label,
      assignmentMode: inputs.assignmentMode as never,
      ...(inputs.assignments ? { assignments: inputs.assignments } : {}),
      ...(inputs.queueItems  ? { queueItems:  inputs.queueItems  } : {}),
    },
  })

  const eventId = await logEvent('TaskCreated', 'Task', task.id, undefined, {
    nodeId:         node.id,
    instanceId:     instance.id,
    assignmentMode: routing.mode,
    teamId:         routing.teamId,
    roleKey:        routing.roleKey,
    skillKey:       routing.skillKey,
    capabilityId:   routing.capabilityId,
  })
  await publishOutbox('Task', task.id, 'TaskCreated', { taskId: task.id, eventId })
}
