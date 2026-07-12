import { Router } from 'express'
import { z } from 'zod'
import { markNotification, listNotifications } from './notifications.service'
import { validate } from '../../middleware/validate'

export const notificationsRouter: Router = Router()

notificationsRouter.get('/', async (req, res, next) => {
  try {
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 50
    res.json(await listNotifications(req.user!.userId, {
      status: typeof req.query.status === 'string' ? req.query.status : undefined,
      limit: Number.isFinite(limit) ? limit : 50,
    }))
  } catch (err) { next(err) }
})

notificationsRouter.get('/unread-count', async (req, res, next) => {
  try {
    const rows = await listNotifications(req.user!.userId, { status: 'UNREAD', limit: 200 })
    res.json({ count: rows.length })
  } catch (err) { next(err) }
})

notificationsRouter.post('/:id/read', async (req, res, next) => {
  try { res.json(await markNotification(req.params.id, req.user!.userId, 'read')) } catch (err) { next(err) }
})

notificationsRouter.post('/:id/resolve', async (req, res, next) => {
  try { res.json(await markNotification(req.params.id, req.user!.userId, 'resolve')) } catch (err) { next(err) }
})

notificationsRouter.post('/:id/snooze', validate(z.object({ until: z.string().datetime().optional() })), async (req, res, next) => {
  try { res.json(await markNotification(req.params.id, req.user!.userId, 'snooze', req.body.until ? new Date(req.body.until) : undefined)) } catch (err) { next(err) }
})
