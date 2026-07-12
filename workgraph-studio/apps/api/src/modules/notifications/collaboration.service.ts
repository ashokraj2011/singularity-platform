import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { withTenantDbTransaction, currentTenantIdForDb } from '../../lib/tenant-db-context'
import { NotFoundError, ValidationError } from '../../lib/errors'
import { createNotification } from './notifications.service'

type JsonRecord = Record<string, unknown>

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue
}

function mentionsFromBody(body: string): string[] {
  return [...new Set(Array.from(body.matchAll(/(^|\s)@([A-Za-z0-9._-]{2,80})/g)).map(match => match[2]))]
}

async function assertCommentEntity(entityType: string, entityId: string, tenantId: string) {
  const found = await withTenantDbTransaction(prisma, async tx => {
    switch (entityType.toUpperCase()) {
      case 'WORKFLOWINSTANCE':
      case 'WORKFLOW_INSTANCE':
      case 'RUN':
        return tx.workflowInstance.findFirst({ where: { id: entityId }, select: { id: true } })
      case 'WORKITEM':
      case 'WORK_ITEM':
        return tx.workItem.findFirst({ where: { id: entityId }, select: { id: true } })
      case 'WORKFLOWNODE':
      case 'WORKFLOW_NODE':
        return tx.workflowNode.findFirst({ where: { id: entityId }, select: { id: true } })
      case 'APPROVALREQUEST':
      case 'APPROVAL_REQUEST':
        return tx.approvalRequest.findFirst({ where: { id: entityId }, select: { id: true } })
      case 'DOCUMENT':
        return tx.document.findFirst({ where: { id: entityId }, select: { id: true } })
      default:
        return null
    }
  }, tenantId)
  if (!found) throw new NotFoundError(entityType, entityId)
}

export async function listComments(args: { entityType: string; entityId: string; userId: string }) {
  const tenantId = currentTenantIdForDb() ?? 'default'
  await assertCommentEntity(args.entityType, args.entityId, tenantId)
  return withTenantDbTransaction(prisma, tx => tx.workComment.findMany({
    where: { tenantId, entityType: args.entityType, entityId: args.entityId },
    orderBy: { createdAt: 'asc' },
    take: 500,
  }), tenantId)
}

export async function createComment(args: { entityType: string; entityId: string; body: string; parentId?: string; userId: string }) {
  const tenantId = currentTenantIdForDb() ?? 'default'
  const body = args.body.trim()
  if (!body) throw new ValidationError('Comment body is required')
  await assertCommentEntity(args.entityType, args.entityId, tenantId)
  if (args.parentId) {
    const parent = await withTenantDbTransaction(prisma, tx => tx.workComment.findFirst({ where: { id: args.parentId, tenantId, entityType: args.entityType, entityId: args.entityId } }), tenantId)
    if (!parent) throw new ValidationError('Parent comment does not belong to this entity')
  }
  const mentions = mentionsFromBody(body)
  const comment = await withTenantDbTransaction(prisma, tx => tx.workComment.create({
    data: { tenantId, entityType: args.entityType, entityId: args.entityId, authorId: args.userId, parentId: args.parentId, body, mentions: json(mentions) },
  }), tenantId)

  // Mentions are resolved only against users in this tenant. Unknown handles are
  // retained in the comment for audit but never generate a notification.
  if (mentions.length) {
    const users = await withTenantDbTransaction(prisma, tx => tx.user.findMany({ where: { OR: mentions.flatMap(handle => [{ id: handle }, { email: handle }]) }, select: { id: true } }), tenantId)
    for (const user of users) {
      await createNotification({
        tenantId,
        userId: user.id,
        kind: 'MENTION',
        source: 'COLLABORATION',
        threadKey: `${args.entityType}:${args.entityId}`,
        title: 'You were mentioned',
        message: `${args.userId} mentioned you on ${args.entityType}.`,
        entityType: args.entityType,
        entityId: args.entityId,
        href: `/workflows/work/${args.entityType.toLowerCase()}/${args.entityId}`,
        why: { reason: 'You were explicitly mentioned in a comment', commentId: comment.id },
      }).catch(() => undefined)
    }
  }
  return comment
}

export async function resolveComment(id: string, userId: string) {
  const tenantId = currentTenantIdForDb() ?? 'default'
  const existing = await withTenantDbTransaction(prisma, tx => tx.workComment.findFirst({ where: { id, tenantId } }), tenantId)
  if (!existing) throw new NotFoundError('Comment', id)
  return withTenantDbTransaction(prisma, tx => tx.workComment.update({ where: { id }, data: { status: 'RESOLVED', resolvedAt: new Date(), resolvedBy: userId } }), tenantId)
}

export async function getNotificationPreferences(userId: string) {
  const tenantId = currentTenantIdForDb() ?? 'default'
  return withTenantDbTransaction(prisma, tx => tx.notificationPreference.findUnique({ where: { tenantId_userId: { tenantId, userId } } }), tenantId)
}

export async function saveNotificationPreferences(userId: string, input: { categories?: JsonRecord; channels?: string[]; digestMode?: string; quietHours?: JsonRecord; severityMin?: string; timezone?: string }) {
  const tenantId = currentTenantIdForDb() ?? 'default'
  return withTenantDbTransaction(prisma, tx => tx.notificationPreference.upsert({
    where: { tenantId_userId: { tenantId, userId } },
    create: { tenantId, userId, categories: json(input.categories ?? {}), channels: json(input.channels ?? ['IN_APP']), digestMode: input.digestMode ?? 'IMMEDIATE', quietHours: json(input.quietHours ?? {}), severityMin: input.severityMin ?? 'info', timezone: input.timezone ?? 'UTC' },
    update: { ...(input.categories ? { categories: json(input.categories) } : {}), ...(input.channels ? { channels: json(input.channels) } : {}), ...(input.digestMode ? { digestMode: input.digestMode } : {}), ...(input.quietHours ? { quietHours: json(input.quietHours) } : {}), ...(input.severityMin ? { severityMin: input.severityMin } : {}), ...(input.timezone ? { timezone: input.timezone } : {}) },
  }), tenantId)
}

export async function listSubscriptions(userId: string) {
  const tenantId = currentTenantIdForDb() ?? 'default'
  return withTenantDbTransaction(prisma, tx => tx.notificationSubscription.findMany({ where: { tenantId, OR: [{ userId }, { userId: null }] }, orderBy: { createdAt: 'desc' }, take: 200 }), tenantId)
}

export async function createSubscription(userId: string, input: { teamId?: string; entityType?: string; entityId?: string; capabilityId?: string; workflowId?: string; severityMin?: string; channels?: string[] }) {
  const tenantId = currentTenantIdForDb() ?? 'default'
  return withTenantDbTransaction(prisma, tx => tx.notificationSubscription.create({
    data: { tenantId, userId, teamId: input.teamId, entityType: input.entityType, entityId: input.entityId, capabilityId: input.capabilityId, workflowId: input.workflowId, severityMin: input.severityMin ?? 'info', channels: json(input.channels ?? ['IN_APP']) },
  }), tenantId)
}

export async function deleteSubscription(id: string, userId: string) {
  const tenantId = currentTenantIdForDb() ?? 'default'
  const existing = await withTenantDbTransaction(prisma, tx => tx.notificationSubscription.findFirst({ where: { id, tenantId, userId } }), tenantId)
  if (!existing) throw new NotFoundError('NotificationSubscription', id)
  return withTenantDbTransaction(prisma, tx => tx.notificationSubscription.delete({ where: { id } }), tenantId)
}

export async function listDelegations(userId: string) {
  const tenantId = currentTenantIdForDb() ?? 'default'
  return withTenantDbTransaction(prisma, tx => tx.outOfOfficeDelegation.findMany({ where: { tenantId, OR: [{ principalUserId: userId }, { delegateUserId: userId }] }, orderBy: { startsAt: 'desc' }, take: 100 }), tenantId)
}

export async function createDelegation(userId: string, input: { delegateUserId: string; startsAt: Date; endsAt: Date; reason?: string }) {
  if (input.endsAt <= input.startsAt) throw new ValidationError('Delegation end must be after its start')
  if (input.delegateUserId === userId) throw new ValidationError('A user cannot delegate to themselves')
  const tenantId = currentTenantIdForDb() ?? 'default'
  return withTenantDbTransaction(prisma, tx => tx.outOfOfficeDelegation.create({ data: { tenantId, principalUserId: userId, delegateUserId: input.delegateUserId, startsAt: input.startsAt, endsAt: input.endsAt, reason: input.reason, createdById: userId } }), tenantId)
}

export async function revokeDelegation(id: string, userId: string) {
  const tenantId = currentTenantIdForDb() ?? 'default'
  const existing = await withTenantDbTransaction(prisma, tx => tx.outOfOfficeDelegation.findFirst({ where: { id, tenantId, principalUserId: userId } }), tenantId)
  if (!existing) throw new NotFoundError('OutOfOfficeDelegation', id)
  return withTenantDbTransaction(prisma, tx => tx.outOfOfficeDelegation.update({ where: { id }, data: { status: 'REVOKED', revokedAt: new Date() } }), tenantId)
}

export async function notificationAudit(id: string, userId: string) {
  const tenantId = currentTenantIdForDb() ?? 'default'
  const notification = await withTenantDbTransaction(prisma, tx => tx.workNotification.findFirst({ where: { id, tenantId, OR: [{ userId }, { userId: null }] }, select: { id: true } }), tenantId)
  if (!notification) throw new NotFoundError('WorkNotification', id)
  return withTenantDbTransaction(prisma, tx => tx.notificationAudit.findMany({ where: { notificationId: id, tenantId }, orderBy: { createdAt: 'asc' } }), tenantId)
}

export async function retryNotificationDelivery(id: string, deliveryId: string, userId: string) {
  const tenantId = currentTenantIdForDb() ?? 'default'
  const delivery = await withTenantDbTransaction(prisma, tx => tx.notificationDelivery.findFirst({ where: { id: deliveryId, notificationId: id, tenantId } }), tenantId)
  if (!delivery) throw new NotFoundError('NotificationDelivery', deliveryId)
  const notification = await withTenantDbTransaction(prisma, tx => tx.workNotification.findFirst({ where: { id, tenantId, OR: [{ userId }, { userId: null }] }, select: { id: true } }), tenantId)
  if (!notification) throw new NotFoundError('WorkNotification', id)
  const updated = await withTenantDbTransaction(prisma, tx => tx.notificationDelivery.update({ where: { id: deliveryId }, data: { status: 'PENDING', nextAttemptAt: new Date(), lastError: null, attempts: { increment: 1 } } }), tenantId)
  await withTenantDbTransaction(prisma, tx => tx.notificationAudit.create({ data: { notificationId: id, tenantId, actorId: userId, action: 'DELIVERY_RETRY', channel: delivery.channel, details: json({ deliveryId }) } }), tenantId)
  return updated
}
