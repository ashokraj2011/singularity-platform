import type { WorkflowNode, WorkflowInstance } from '@prisma/client'
import { prisma } from '../../../../lib/prisma'
import { withTenantDbTransaction } from '../../../../lib/tenant-db-context'
import { logEvent, publishOutbox } from '../../../../lib/audit'
import {
  resolveAssignmentRouting,
  mirrorTeamQueueRouting,
  buildTaskAssignmentInputs,
  getTemplateCapabilityId,
  assertAssignmentResolved,
} from '../../../task/lib/assignment'

export async function activateHumanTask(
  node: WorkflowNode,
  instance: WorkflowInstance,
): Promise<void> {
  const cfg = (node.config ?? {}) as Record<string, unknown>
  const standard = cfg.standard && typeof cfg.standard === 'object' && !Array.isArray(cfg.standard)
    ? cfg.standard as Record<string, unknown>
    : {}
  const requiredRole = typeof standard.role === 'string' ? standard.role : undefined
  const configuredRole = (cfg.roleKey as string | undefined) ?? requiredRole
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
  }, routing, `Human task "${node.label}"`)
  if (routing.mode === 'ROLE_BASED' && !routing.roleKey) {
    throw new Error(`Human task "${node.label}" requires a role. Select a role or provide a runtime placeholder such as {{instance.vars.requiredRole}} before the node activates.`)
  }

  const inputs = buildTaskAssignmentInputs(routing)

  const task = await withTenantDbTransaction(prisma, (tx) => tx.task.create({
    data: {
      instanceId:     instance.id,
      nodeId:         node.id,
      title:          node.label,
      assignmentMode: inputs.assignmentMode as never,
      ...(inputs.assignments ? { assignments: inputs.assignments } : {}),
      ...(inputs.queueItems  ? { queueItems:  inputs.queueItems  } : {}),
    },
  }), instance.tenantId ?? undefined)

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
