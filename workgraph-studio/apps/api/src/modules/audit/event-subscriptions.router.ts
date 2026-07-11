/**
 * M11.e — subscription registry routes.
 *
 * Subscribers POST {subscriberId, eventPattern, targetUrl, secret?} once;
 * deliveries (with HMAC if `secret` set) flow whenever a matching event lands
 * in `event_outbox`.
 */

import { Router, type Request } from 'express'
import { z } from 'zod'
import { prisma } from '../../lib/prisma'
import { ForbiddenError, NotFoundError, ValidationError } from '../../lib/errors'
import { assertEventTargetUrlAllowed } from '../../lib/eventbus/target-url-policy'
import { publicSubscription, sealSubscriptionSecret } from '../../lib/eventbus/subscription-secret'
import { requireTenantFromRequest, resolveTenantFromRequest, tenantIsolationStrict } from '../../lib/tenant-isolation'
import { isAdminUser } from '../../lib/permissions/admin'

export const eventSubscriptionsRouter: Router = Router()

function tenantFilter(req: Request): Record<string, string> {
  const tenantId = tenantIsolationStrict()
    ? requireTenantFromRequest(req, 'event subscription operation')
    : resolveTenantFromRequest(req)
  return tenantId ? { tenantId } : {}
}

async function requireAdmin(req: Request): Promise<void> {
  if (!req.user?.userId || !(await isAdminUser(req.user.userId))) {
    throw new ForbiddenError('Event subscription configuration requires an administrator role.')
  }
}

const createSchema = z.object({
  subscriberId: z.string().min(1),
  eventPattern: z.string().min(1),
  targetUrl:    z.string().url(),
  secret:       z.string().min(16).max(512).optional(),
  metadata:     z.record(z.string(), z.unknown()).optional(),
})

eventSubscriptionsRouter.post('/', async (req, res, next) => {
  try {
    await requireAdmin(req)
    const body = createSchema.parse(req.body)
    try {
      await assertEventTargetUrlAllowed(body.targetUrl)
    } catch (err) {
      throw new ValidationError((err as Error).message)
    }
    const sub = await prisma.eventSubscription.create({
      data: {
        subscriberId: body.subscriberId,
        eventPattern: body.eventPattern,
        targetUrl:    body.targetUrl,
        secret:       sealSubscriptionSecret(body.secret),
        metadata:     body.metadata as object | undefined,
        createdById:  req.user?.userId,
        ...tenantFilter(req),
      },
    })
    res.status(201).json(publicSubscription(sub))
  } catch (err) { next(err) }
})

eventSubscriptionsRouter.get('/', async (req, res, next) => {
  try {
    const where: Record<string, unknown> = { ...tenantFilter(req) }
    if (req.query.subscriber_id) where.subscriberId = req.query.subscriber_id
    if (req.query.is_active === 'true')  where.isActive = true
    if (req.query.is_active === 'false') where.isActive = false
    const subs = await prisma.eventSubscription.findMany({ where, orderBy: { createdAt: 'desc' } })
    res.json({ items: subs.map(publicSubscription), total: subs.length })
  } catch (err) { next(err) }
})

eventSubscriptionsRouter.get('/:id', async (req, res, next) => {
  try {
    const sub = await prisma.eventSubscription.findFirst({ where: { id: req.params.id, ...tenantFilter(req) } })
    if (!sub) throw new NotFoundError('EventSubscription', req.params.id)
    res.json(publicSubscription(sub))
  } catch (err) { next(err) }
})

eventSubscriptionsRouter.patch('/:id', async (req, res, next) => {
  try {
    await requireAdmin(req)
    const body = createSchema.partial().parse(req.body)
    if (body.targetUrl !== undefined) {
      try {
        await assertEventTargetUrlAllowed(body.targetUrl)
      } catch (err) {
        throw new ValidationError((err as Error).message)
      }
    }
    const existing = await prisma.eventSubscription.findFirst({ where: { id: req.params.id, ...tenantFilter(req) } })
    if (!existing) throw new NotFoundError('EventSubscription', req.params.id)
    const sub = await prisma.eventSubscription.update({
      where: { id: existing.id },
      data: {
        ...(body.subscriberId !== undefined ? { subscriberId: body.subscriberId } : {}),
        ...(body.eventPattern !== undefined ? { eventPattern: body.eventPattern } : {}),
        ...(body.targetUrl    !== undefined ? { targetUrl:    body.targetUrl    } : {}),
        ...(body.secret       !== undefined ? { secret:       sealSubscriptionSecret(body.secret) } : {}),
        ...(body.metadata     !== undefined ? { metadata:     body.metadata as object } : {}),
      },
    })
    res.json(publicSubscription(sub))
  } catch (err) { next(err) }
})

eventSubscriptionsRouter.delete('/:id', async (req, res, next) => {
  try {
    await requireAdmin(req)
    const existing = await prisma.eventSubscription.findFirst({ where: { id: req.params.id, ...tenantFilter(req) } })
    if (!existing) throw new NotFoundError('EventSubscription', req.params.id)
    await prisma.eventSubscription.delete({ where: { id: existing.id } })
    res.status(204).end()
  } catch (err) { next(err) }
})

eventSubscriptionsRouter.get('/:id/deliveries', async (req, res, next) => {
  try {
    const deliveries = await prisma.eventDelivery.findMany({
      where:   { subscriptionId: req.params.id, subscription: tenantFilter(req) },
      orderBy: { createdAt: 'desc' },
      take:    100,
      include: { outbox: { select: { eventName: true, traceId: true, subjectKind: true, subjectId: true, emittedAt: true } } },
    })
    res.json({ items: deliveries, total: deliveries.length })
  } catch (err) { next(err) }
})
