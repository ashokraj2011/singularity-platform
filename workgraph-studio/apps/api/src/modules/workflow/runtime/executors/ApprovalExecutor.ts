import { Prisma, type WorkflowNode, type WorkflowInstance, type ApprovalRequest } from '@prisma/client'
import { prisma } from '../../../../lib/prisma'
import { withTenantDbTransaction } from '../../../../lib/tenant-db-context'
import { logEvent, publishOutbox } from '../../../../lib/audit'
import { createNotification } from '../../../notifications/notifications.service'
import {
  resolveAssignmentRouting,
  mirrorTeamQueueRouting,
  buildEntityRoutingFields,
  getTemplateCapabilityId,
  assertAssignmentResolved,
} from '../../../task/lib/assignment'
import { validateApprovalRouting } from '../../../../lib/permissions/approval'

export async function activateApproval(
  node: WorkflowNode,
  instance: WorkflowInstance,
  actorId?: string,
): Promise<ApprovalRequest> {
  const tenantId = instance.tenantId ?? undefined
  const existing = await withTenantDbTransaction(prisma, (tx) => tx.approvalRequest.findFirst({
    where: {
      instanceId: instance.id,
      nodeId: node.id,
      subjectType: 'WorkflowNode',
      subjectId: node.id,
      status: 'PENDING',
    },
    orderBy: { createdAt: 'desc' },
  }), tenantId)
  if (existing) return existing

  const cfg = (node.config ?? {}) as Record<string, unknown>

  const capabilityId = await getTemplateCapabilityId(instance)
  // Approvals historically used `approverUserId`; keep that as a fallback for
  // legacy workflows that haven't migrated to the structured assignmentMode.
  const legacyApprover = cfg.approverUserId as string | undefined
  const standard = cfg.standard && typeof cfg.standard === 'object' && !Array.isArray(cfg.standard)
    ? cfg.standard as Record<string, unknown>
    : {}
  const requiredRole = typeof standard.role === 'string' ? standard.role : undefined
  const configuredRole = (cfg.roleKey as string | undefined) ?? requiredRole
  const configuredMode = (cfg.assignmentMode as string | undefined)
    ?? (legacyApprover ? 'DIRECT_USER' : configuredRole ? 'ROLE_BASED' : undefined)
  const routing = await mirrorTeamQueueRouting(resolveAssignmentRouting(
    {
      assignmentMode: configuredMode,
      assignedToId:   (cfg.assignedToId  as string | undefined) ?? legacyApprover,
      teamId:         cfg.teamId   as string | undefined,
      roleKey:        configuredRole,
      skillKey:       cfg.skillKey as string | undefined,
    },
    capabilityId,
    (instance.context ?? {}) as Record<string, unknown>,
  ))
  assertAssignmentResolved({
    assignmentMode: configuredMode,
    assignedToId: (cfg.assignedToId as string | undefined) ?? legacyApprover,
    teamId: cfg.teamId as string | undefined,
    roleKey: configuredRole,
    skillKey: cfg.skillKey as string | undefined,
  }, routing, `Approval "${node.label}"`)
  if (routing.mode === 'ROLE_BASED' && !routing.roleKey) {
    throw new Error(`Approval "${node.label}" requires a role. Select a role or provide a runtime placeholder such as {{instance.vars.requiredRole}} before the node activates.`)
  }

  const fields = buildEntityRoutingFields(routing)
  if (configuredMode || cfg.assignedToId || cfg.teamId || configuredRole || cfg.skillKey) {
    try {
      validateApprovalRouting(fields)
    } catch (error) {
      throw new Error(`Approval node ${node.label} has invalid human routing: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const quorumRaw = Number(cfg.quorumRequired ?? cfg.approvalQuorum ?? cfg.minVotes ?? standard.quorumRequired ?? standard.approvalQuorum ?? standard.minVotes ?? 1)
  const quorumRequired = Number.isFinite(quorumRaw) ? Math.min(100, Math.max(1, Math.trunc(quorumRaw))) : 1
  const adminOverride = cfg.adminOverride !== false
  const escalationPolicy = cfg.escalationPolicy && typeof cfg.escalationPolicy === 'object' && !Array.isArray(cfg.escalationPolicy)
    ? cfg.escalationPolicy as Record<string, unknown>
    : {}
  const levels = Array.isArray(escalationPolicy.levels) ? escalationPolicy.levels as Array<Record<string, unknown>> : []
  const firstAfterSeconds = Number(levels[0]?.afterSeconds)
  const escalateAfterMs = Number.isFinite(firstAfterSeconds) && firstAfterSeconds > 0
    ? firstAfterSeconds * 1000
    : Number(cfg.escalateAfterMinutes) > 0 ? Number(cfg.escalateAfterMinutes) * 60_000 : 0

  const request = await withTenantDbTransaction(prisma, (tx) => tx.approvalRequest.create({
    data: {
      instanceId:     instance.id,
      tenantId:       instance.tenantId ?? null,
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
      quorumRequired,
      adminOverride,
      escalationPolicy: escalationPolicy as Prisma.InputJsonValue,
      ...(escalateAfterMs > 0 ? { nextEscalationAt: new Date(Date.now() + escalateAfterMs) } : {}),
    },
  }), tenantId)

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
  if (request.assignedToId || request.teamId) {
    await createNotification({
      tenantId: instance.tenantId ?? 'default',
      userId: request.assignedToId ?? undefined,
      teamId: request.teamId ?? undefined,
      kind: 'APPROVAL_REQUIRED',
      title: 'Approval required',
      message: `Approval is required for ${node.label}. ${quorumRequired > 1 ? `${quorumRequired} approvals are required.` : ''}`.trim(),
      severity: 'warning',
      entityType: 'ApprovalRequest',
      entityId: request.id,
      href: `/approvals/${request.id}`,
      payload: { instanceId: instance.id, nodeId: node.id, quorumRequired, skillKey: request.skillKey },
    }).catch(() => undefined)
  }
  return request
}
