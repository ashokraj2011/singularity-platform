/**
 * M11.e — subscription registry routes.
 *
 * Subscribers POST {subscriberId, eventPattern, targetUrl, secret?} once;
 * deliveries (with HMAC if `secret` set) flow whenever a matching event lands
 * in `event_outbox`.
 */

import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../lib/prisma'
import { NotFoundError } from '../../lib/errors'

export const eventSubscriptionsRouter: Router = Router()

const createSchema = z.object({
  subscriberId: z.string().min(1),
  eventPattern: z.string().min(1),
  targetUrl:    z.string().url(),
  secret:       z.string().optional(),
  metadata:     z.record(z.string(), z.unknown()).optional(),
})

eventSubscriptionsRouter.post('/', async (req, res, next) => {
  try {
    const body = createSchema.parse(req.body)
    const sub = await prisma.eventSubscription.create({
      data: {
        subscriberId: body.subscriberId,
        eventPattern: body.eventPattern,
        targetUrl:    body.targetUrl,
        secret:       body.secret,
        metadata:     body.metadata as object | undefined,
        createdById:  req.user?.userId,
      },
    })
    res.status(201).json(sub)
  } catch (err) { next(err) }
})

eventSubscriptionsRouter.get('/', async (req, res, next) => {
  try {
    const where: Record<string, unknown> = {}
    if (req.query.subscriber_id) where.subscriberId = req.query.subscriber_id
    if (req.query.is_active === 'true')  where.isActive = true
    if (req.query.is_active === 'false') where.isActive = false
    const subs = await prisma.eventSubscription.findMany({ where, orderBy: { createdAt: 'desc' } })
    res.json({ items: subs, total: subs.length })
  } catch (err) { next(err) }
})

eventSubscriptionsRouter.get('/:id', async (req, res, next) => {
  try {
    const sub = await prisma.eventSubscription.findUnique({ where: { id: req.params.id } })
    if (!sub) throw new NotFoundError('EventSubscription', req.params.id)
    res.json(sub)
  } catch (err) { next(err) }
})

eventSubscriptionsRouter.patch('/:id', async (req, res, next) => {
  try {
    const body = createSchema.partial().parse(req.body)
    const sub = await prisma.eventSubscription.update({
      where: { id: req.params.id },
      data: {
        ...(body.subscriberId !== undefined ? { subscriberId: body.subscriberId } : {}),
        ...(body.eventPattern !== undefined ? { eventPattern: body.eventPattern } : {}),
        ...(body.targetUrl    !== undefined ? { targetUrl:    body.targetUrl    } : {}),
        ...(body.secret       !== undefined ? { secret:       body.secret       } : {}),
        ...(body.metadata     !== undefined ? { metadata:     body.metadata as object } : {}),
      },
    })
    res.json(sub)
  } catch (err) { next(err) }
})

eventSubscriptionsRouter.delete('/:id', async (req, res, next) => {
  try {
    await prisma.eventSubscription.delete({ where: { id: req.params.id } })
    res.status(204).end()
  } catch (err) { next(err) }
})

eventSubscriptionsRouter.get('/:id/deliveries', async (req, res, next) => {
  try {
    const deliveries = await prisma.eventDelivery.findMany({
      where:   { subscriptionId: req.params.id },
      orderBy: { createdAt: 'desc' },
      take:    100,
      include: { outbox: { select: { eventName: true, traceId: true, subjectKind: true, subjectId: true, emittedAt: true } } },
    })
    res.json({ items: deliveries, total: deliveries.length })
  } catch (err) { next(err) }
})
