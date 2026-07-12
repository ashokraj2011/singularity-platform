import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { currentTenantIdForDb, withTenantDbTransaction } from '../../lib/tenant-db-context'

export type CreateNotificationInput = {
  tenantId?: string
  userId?: string
  teamId?: string
  kind: string
  source?: string
  threadKey?: string
  title: string
  message: string
  severity?: string
  entityType?: string
  entityId?: string
  href?: string
  payload?: Record<string, unknown>
  why?: Record<string, unknown>
  deliveryPolicy?: Record<string, unknown>
  dueAt?: Date
}

export async function createNotification(input: CreateNotificationInput) {
  const tenantId = input.tenantId ?? currentTenantIdForDb() ?? 'default'
  const notification = await withTenantDbTransaction(prisma, tx => tx.workNotification.create({
    data: {
      userId: input.userId,
      teamId: input.teamId,
      tenantId,
      kind: input.kind,
      source: input.source ?? 'PLATFORM',
      threadKey: input.threadKey,
      title: input.title,
      message: input.message,
      severity: input.severity ?? 'info',
      entityType: input.entityType,
      entityId: input.entityId,
      href: input.href,
      payload: (input.payload ?? {}) as Prisma.InputJsonValue,
      why: (input.why ?? {}) as Prisma.InputJsonValue,
      deliveryPolicy: (input.deliveryPolicy ?? {}) as Prisma.InputJsonValue,
      dueAt: input.dueAt,
    },
  }), tenantId)

  // Delivery records are durable even when an external channel is not configured.
  // Dispatchers can claim them later without losing the in-app notification.
  const preference = input.userId
    ? await withTenantDbTransaction(prisma, tx => tx.notificationPreference.findUnique({ where: { tenantId_userId: { tenantId, userId: input.userId! } } }), tenantId).catch(() => null)
    : null
  const configuredChannels = Array.isArray(preference?.channels) ? preference!.channels : undefined
  const policyChannels = Array.isArray(input.deliveryPolicy?.channels) ? input.deliveryPolicy.channels : undefined
  const channels = [...new Set((policyChannels ?? configuredChannels ?? ['IN_APP']).filter((channel): channel is string => Boolean(typeof channel === 'string' && channel.trim())).map(channel => channel.toUpperCase()))]
  if (channels.length) {
    await withTenantDbTransaction(prisma, tx => tx.notificationDelivery.createMany({
      data: channels.map(channel => ({ notificationId: notification.id, tenantId, channel })),
      skipDuplicates: true,
    }), tenantId).catch(() => undefined)
  }
  return notification
}

export async function listNotifications(userId: string, options: { status?: string; limit?: number } = {}) {
  const tenantId = currentTenantIdForDb() ?? 'default'
  const take = Math.min(Math.max(options.limit ?? 50, 1), 200)
  return withTenantDbTransaction(prisma, async tx => {
    const user = await tx.user.findUnique({ where: { id: userId }, select: { teamId: true } })
    return tx.workNotification.findMany({
      where: {
        tenantId,
        ...(options.status ? { status: options.status } : {}),
        AND: [
          { OR: [{ userId }, ...(user?.teamId ? [{ teamId: user.teamId }] : [])] },
          { OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: new Date() } }] },
        ],
      },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      take,
    })
  }, tenantId)
}

async function ownedNotification(id: string, userId: string) {
  const tenantId = currentTenantIdForDb() ?? 'default'
  return withTenantDbTransaction(prisma, async tx => {
    const user = await tx.user.findUnique({ where: { id: userId }, select: { teamId: true } })
    return tx.workNotification.findFirst({
      where: { id, tenantId, OR: [{ userId }, ...(user?.teamId ? [{ teamId: user.teamId }] : [])] },
    })
  }, tenantId)
}

export async function markNotification(id: string, userId: string, action: 'read' | 'resolve' | 'snooze', until?: Date) {
  const existing = await ownedNotification(id, userId)
  if (!existing) return null
  const tenantId = currentTenantIdForDb() ?? 'default'
  return withTenantDbTransaction(prisma, tx => tx.workNotification.update({
    where: { id },
    data: action === 'read'
      ? { status: 'READ', readAt: new Date() }
      : action === 'resolve'
        ? { status: 'RESOLVED', resolvedAt: new Date(), readAt: existing.readAt ?? new Date() }
        : { status: 'SNOOZED', snoozedUntil: until ?? new Date(Date.now() + 60 * 60 * 1000) },
  }), tenantId)
}
