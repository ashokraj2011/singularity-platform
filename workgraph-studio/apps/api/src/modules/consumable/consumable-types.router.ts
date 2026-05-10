import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../lib/prisma'
import { validate } from '../../middleware/validate'

export const consumableTypesRouter: Router = Router()

const createTypeSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  schemaDef: z.record(z.unknown()).default({}),
  ownerRoleId: z.string().uuid().optional(),
  requiresApproval: z.boolean().default(true),
  allowVersioning: z.boolean().default(true),
})

consumableTypesRouter.post('/', validate(createTypeSchema), async (req, res, next) => {
  try {
    const type = await prisma.consumableType.create({ data: req.body })
    res.status(201).json(type)
  } catch (err) {
    next(err)
  }
})

consumableTypesRouter.get('/', async (_req, res, next) => {
  try {
    const types = await prisma.consumableType.findMany({ orderBy: { name: 'asc' } })
    res.json(types)
  } catch (err) {
    next(err)
  }
})

consumableTypesRouter.get('/:id', async (req, res, next) => {
  try {
    const type = await prisma.consumableType.findUnique({ where: { id: req.params.id } })
    if (!type) { res.status(404).json({ code: 'NOT_FOUND', message: 'ConsumableType not found' }); return }
    res.json(type)
  } catch (err) {
    next(err)
  }
})
