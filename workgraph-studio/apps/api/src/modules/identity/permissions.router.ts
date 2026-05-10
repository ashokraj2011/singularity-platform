import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../lib/prisma'
import { validate } from '../../middleware/validate'

export const permissionsRouter: Router = Router()

const createPermissionSchema = z.object({
  name: z.string().min(1),
  resource: z.string().min(1),
  action: z.string().min(1),
  description: z.string().optional(),
})

permissionsRouter.post('/', validate(createPermissionSchema), async (req, res, next) => {
  try {
    const permission = await prisma.permission.create({ data: req.body })
    res.status(201).json(permission)
  } catch (err) {
    next(err)
  }
})

permissionsRouter.get('/', async (_req, res, next) => {
  try {
    const permissions = await prisma.permission.findMany({ orderBy: { name: 'asc' } })
    res.json(permissions)
  } catch (err) {
    next(err)
  }
})
