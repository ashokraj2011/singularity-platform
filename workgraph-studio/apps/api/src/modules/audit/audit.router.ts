import { Router } from 'express'
import { prisma } from '../../lib/prisma'
import { parsePagination, toPageResponse } from '../../lib/pagination'

export const auditRouter: Router = Router()

auditRouter.get('/events', async (req, res, next) => {
  try {
    const { entityType, entityId } = req.query
    const pg = parsePagination(req.query as Record<string, unknown>)

    const where: Record<string, unknown> = {}
    if (entityType) where.entityType = entityType
    if (entityId) where.entityId = entityId

    const [events, total] = await Promise.all([
      prisma.eventLog.findMany({
        where,
        skip: pg.skip,
        take: pg.take,
        orderBy: { occurredAt: 'desc' },
      }),
      prisma.eventLog.count({ where }),
    ])

    res.json(toPageResponse(events, total, pg))
  } catch (err) {
    next(err)
  }
})

auditRouter.get('/receipts/:id', async (req, res, next) => {
  try {
    const receipt = await prisma.receipt.findUnique({ where: { id: req.params.id } })
    if (!receipt) {
      res.status(404).json({ code: 'NOT_FOUND', message: 'Receipt not found' })
      return
    }
    res.json(receipt)
  } catch (err) {
    next(err)
  }
})
