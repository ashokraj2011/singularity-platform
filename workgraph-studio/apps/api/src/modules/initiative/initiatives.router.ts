import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../lib/prisma'
import { validate } from '../../middleware/validate'
import { parsePagination, toPageResponse } from '../../lib/pagination'
import { NotFoundError } from '../../lib/errors'
import { logEvent, publishOutbox } from '../../lib/audit'

export const initiativesRouter: Router = Router()

const createInitiativeSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
})

const updateInitiativeSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  status: z.string().optional(),
})

initiativesRouter.post('/', validate(createInitiativeSchema), async (req, res, next) => {
  try {
    const initiative = await prisma.initiative.create({
      data: { ...req.body, createdById: req.user!.userId },
      include: { owners: true },
    })
    await logEvent('InitiativeCreated', 'Initiative', initiative.id, req.user!.userId)
    await publishOutbox('Initiative', initiative.id, 'InitiativeCreated', { initiativeId: initiative.id })
    res.status(201).json(initiative)
  } catch (err) {
    next(err)
  }
})

initiativesRouter.get('/', async (req, res, next) => {
  try {
    const pg = parsePagination(req.query as Record<string, unknown>)
    const search = req.query.search as string | undefined

    const where = search
      ? { title: { contains: search, mode: 'insensitive' as const } }
      : {}

    const [initiatives, total] = await Promise.all([
      prisma.initiative.findMany({
        where, skip: pg.skip, take: pg.take,
        include: { owners: true },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.initiative.count({ where }),
    ])
    res.json(toPageResponse(initiatives, total, pg))
  } catch (err) {
    next(err)
  }
})

initiativesRouter.get('/:id', async (req, res, next) => {
  try {
    const initiative = await prisma.initiative.findUnique({
      where: { id: req.params.id },
      include: { owners: true, documents: true, workflows: true },
    })
    if (!initiative) throw new NotFoundError('Initiative', req.params.id)
    res.json(initiative)
  } catch (err) {
    next(err)
  }
})

initiativesRouter.patch('/:id', validate(updateInitiativeSchema), async (req, res, next) => {
  try {
    const initiative = await prisma.initiative.update({
      where: { id: req.params.id as string },
      data: req.body,
      include: { owners: true },
    })
    res.json(initiative)
  } catch (err) {
    next(err)
  }
})

initiativesRouter.post('/:id/owners', async (req, res, next) => {
  try {
    const { userId } = z.object({ userId: z.string().uuid() }).parse(req.body)
    await prisma.initiativeOwner.upsert({
      where: { initiativeId_userId: { initiativeId: req.params.id, userId } },
      create: { initiativeId: req.params.id, userId },
      update: {},
    })
    res.status(204).end()
  } catch (err) {
    next(err)
  }
})

initiativesRouter.post('/:id/documents', async (req, res, next) => {
  try {
    const { documentId } = z.object({ documentId: z.string().uuid() }).parse(req.body)
    const doc = await prisma.initiativeDocument.create({
      data: { initiativeId: req.params.id, documentId },
    })
    res.status(201).json(doc)
  } catch (err) {
    next(err)
  }
})

initiativesRouter.get('/:id/documents', async (req, res, next) => {
  try {
    const docs = await prisma.initiativeDocument.findMany({
      where: { initiativeId: req.params.id },
      orderBy: { createdAt: 'desc' },
    })
    res.json(docs)
  } catch (err) {
    next(err)
  }
})

initiativesRouter.get('/:id/consumables', async (req, res, next) => {
  try {
    const initiative = await prisma.initiative.findUnique({
      where: { id: req.params.id },
      include: { workflows: { include: { consumables: { include: { type: true } } } } },
    })
    if (!initiative) throw new NotFoundError('Initiative', req.params.id)
    const consumables = initiative.workflows.flatMap(w => w.consumables)
    res.json(consumables)
  } catch (err) {
    next(err)
  }
})
