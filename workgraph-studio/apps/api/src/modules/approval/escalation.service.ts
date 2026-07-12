import { prisma } from '../../lib/prisma'
import { adminPrisma } from '../../lib/admin-prisma'
import { withTenantDbTransaction } from '../../lib/tenant-db-context'
import { createNotification } from '../notifications/notifications.service'

type EscalationTarget = { userId?: string; teamId?: string; roleKey?: string; skillKey?: string; afterSeconds?: number }

function targetRouting(target: EscalationTarget, capabilityId?: string | null): { assignmentMode: string; assignedToId?: string; teamId?: string; roleKey?: string; skillKey?: string } | null {
  const selectors = [target.userId, target.teamId, target.roleKey, target.skillKey].filter(Boolean)
  if (selectors.length !== 1) return null
  if (target.userId) return { assignmentMode: 'DIRECT_USER', assignedToId: target.userId }
  if (target.teamId) return { assignmentMode: 'TEAM_QUEUE', teamId: target.teamId }
  if (target.roleKey && capabilityId) return { assignmentMode: 'ROLE_BASED', roleKey: target.roleKey }
  if (target.skillKey) return { assignmentMode: 'SKILL_BASED', skillKey: target.skillKey }
  return null
}

function targets(policy: unknown): EscalationTarget[] {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return []
  const rows = (policy as Record<string, unknown>).levels
  return Array.isArray(rows) ? rows.filter(row => row && typeof row === 'object').map(row => row as EscalationTarget) : []
}

export async function sweepApprovalEscalations(now = new Date()): Promise<number> {
  // Escalation is a cross-tenant background sweep. Use the optional owner
  // connection for discovery, then perform every mutation tenant-scoped.
  const sweepReader = adminPrisma ?? prisma
  const requests = await sweepReader.approvalRequest.findMany({
    where: { status: 'PENDING', nextEscalationAt: { lte: now } },
    take: 100,
  })
  let escalated = 0
  for (const request of requests) {
    const policy = targets(request.escalationPolicy)
    const target = policy[request.escalationLevel]
    const tenantId = request.tenantId ?? 'default'
    const routing = target ? targetRouting(target, request.capabilityId) : null
    if (!target || !routing) {
      await withTenantDbTransaction(prisma, tx => tx.approvalRequest.updateMany({ where: { id: request.id, status: 'PENDING' }, data: { nextEscalationAt: null } }), tenantId)
      continue
    }
    const nextLevel = request.escalationLevel + 1
    const updated = await withTenantDbTransaction(prisma, async tx => {
      const result = await tx.approvalRequest.updateMany({
        where: { id: request.id, status: 'PENDING', escalationLevel: request.escalationLevel },
        data: {
          assignedToId: routing.assignedToId ?? null,
          teamId: routing.teamId ?? null,
          roleKey: routing.roleKey ?? null,
          skillKey: routing.skillKey ?? null,
          assignmentMode: routing.assignmentMode,
          escalationLevel: nextLevel,
          lastEscalatedAt: now,
          nextEscalationAt: target.afterSeconds ? new Date(now.getTime() + target.afterSeconds * 1000) : null,
        },
      })
      if (!result.count) return result
      await tx.approvalEscalation.create({
        data: {
          requestId: request.id,
          level: nextLevel,
          targetUserId: target.userId,
          targetTeamId: target.teamId,
          targetRoleKey: target.roleKey,
          targetSkillKey: target.skillKey,
          reason: 'Approval escalation policy deadline elapsed',
        },
      })
      return result
    }, tenantId).catch(() => ({ count: 0 }))
    if (!updated.count) continue
    await createNotification({
      tenantId: request.tenantId ?? 'default',
      userId: target.userId,
      teamId: target.teamId,
      kind: 'APPROVAL_ESCALATED',
      title: 'Approval escalated',
      message: 'A pending approval reached its escalation deadline and needs attention.',
      severity: 'error',
      entityType: 'ApprovalRequest',
      entityId: request.id,
      href: `/approvals/${request.id}`,
      payload: { level: nextLevel, roleKey: target.roleKey, skillKey: target.skillKey },
    }).catch(() => undefined)
    escalated += 1
  }
  return escalated
}

export function startApprovalEscalationSweep(): void {
  const intervalMs = Math.max(10_000, Number(process.env.APPROVAL_ESCALATION_SWEEP_MS ?? 30_000))
  setInterval(() => { void sweepApprovalEscalations().catch(err => console.warn('[approval-escalation] sweep failed', err)) }, intervalMs)
}
