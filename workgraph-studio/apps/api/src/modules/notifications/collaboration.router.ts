import { Router } from 'express'
import { z } from 'zod'
import { validate } from '../../middleware/validate'
import {
  createComment,
  createDelegation,
  createSubscription,
  deleteSubscription,
  getNotificationPreferences,
  listComments,
  listDelegations,
  listSubscriptions,
  notificationAudit,
  resolveComment,
  retryNotificationDelivery,
  revokeDelegation,
  saveNotificationPreferences,
} from './collaboration.service'

export const collaborationRouter: Router = Router()

const commentSchema = z.object({ entityType: z.string().min(1).max(80), entityId: z.string().min(1), body: z.string().min(1).max(20_000), parentId: z.string().uuid().optional() })
collaborationRouter.get('/comments', async (req, res, next) => {
  try {
    const entityType = String(req.query.entityType ?? '')
    const entityId = String(req.query.entityId ?? '')
    if (!entityType || !entityId) return res.status(400).json({ error: 'entityType and entityId are required' })
    res.json(await listComments({ entityType, entityId, userId: req.user!.userId }))
  } catch (err) { next(err) }
})
collaborationRouter.post('/comments', validate(commentSchema), async (req, res, next) => {
  try { res.status(201).json(await createComment({ ...req.body, userId: req.user!.userId })) } catch (err) { next(err) }
})
collaborationRouter.post('/comments/:id/resolve', async (req, res, next) => {
  try { res.json(await resolveComment(req.params.id, req.user!.userId)) } catch (err) { next(err) }
})

const preferenceSchema = z.object({
  channels: z.array(z.enum(['IN_APP', 'EMAIL', 'SLACK', 'TEAMS', 'WEBHOOK', 'MOBILE'])).optional(),
  digestMode: z.enum(['IMMEDIATE', 'HOURLY', 'DAILY', 'OFF']).optional(),
  quietHours: z.record(z.unknown()).optional(),
  severityMin: z.enum(['info', 'warning', 'error', 'critical']).optional(),
  timezone: z.string().max(80).optional(),
})
collaborationRouter.get('/preferences', async (req, res, next) => {
  try { res.json(await getNotificationPreferences(req.user!.userId)) } catch (err) { next(err) }
})
collaborationRouter.put('/preferences', validate(preferenceSchema), async (req, res, next) => {
  try { res.json(await saveNotificationPreferences(req.user!.userId, req.body)) } catch (err) { next(err) }
})

const subscriptionSchema = z.object({
  teamId: z.string().optional(), entityType: z.string().optional(), entityId: z.string().optional(), capabilityId: z.string().optional(), workflowId: z.string().optional(),
  severityMin: z.enum(['info', 'warning', 'error', 'critical']).optional(),
  channels: z.array(z.enum(['IN_APP', 'EMAIL', 'SLACK', 'TEAMS', 'WEBHOOK', 'MOBILE'])).optional(),
}).refine(input => Boolean(input.entityId || input.capabilityId || input.workflowId || input.teamId), 'A subscription target is required')
collaborationRouter.get('/subscriptions', async (req, res, next) => {
  try { res.json(await listSubscriptions(req.user!.userId)) } catch (err) { next(err) }
})
collaborationRouter.post('/subscriptions', validate(subscriptionSchema), async (req, res, next) => {
  try { res.status(201).json(await createSubscription(req.user!.userId, req.body)) } catch (err) { next(err) }
})
collaborationRouter.delete('/subscriptions/:id', async (req, res, next) => {
  try { res.json(await deleteSubscription(req.params.id, req.user!.userId)) } catch (err) { next(err) }
})

const delegationSchema = z.object({ delegateUserId: z.string().min(1), startsAt: z.string().datetime(), endsAt: z.string().datetime(), reason: z.string().max(500).optional() })
collaborationRouter.get('/delegations', async (req, res, next) => {
  try { res.json(await listDelegations(req.user!.userId)) } catch (err) { next(err) }
})
collaborationRouter.post('/delegations', validate(delegationSchema), async (req, res, next) => {
  try { res.status(201).json(await createDelegation(req.user!.userId, { ...req.body, startsAt: new Date(req.body.startsAt), endsAt: new Date(req.body.endsAt) })) } catch (err) { next(err) }
})
collaborationRouter.post('/delegations/:id/revoke', async (req, res, next) => {
  try { res.json(await revokeDelegation(req.params.id, req.user!.userId)) } catch (err) { next(err) }
})

collaborationRouter.get('/notifications/:id/audit', async (req, res, next) => {
  try { res.json(await notificationAudit(req.params.id, req.user!.userId)) } catch (err) { next(err) }
})
collaborationRouter.post('/notifications/:id/deliveries/:deliveryId/retry', async (req, res, next) => {
  try { res.json(await retryNotificationDelivery(req.params.id, req.params.deliveryId, req.user!.userId)) } catch (err) { next(err) }
})
