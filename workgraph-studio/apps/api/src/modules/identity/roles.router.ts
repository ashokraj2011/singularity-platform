import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../lib/prisma'
import { validate } from '../../middleware/validate'

export const rolesRouter: Router = Router()

const createRoleSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
})

rolesRouter.post('/', validate(createRoleSchema), async (req, res, next) => {
  try {
    const role = await prisma.role.create({ data: req.body })
    res.status(201).json(role)
  } catch (err) {
    next(err)
  }
})

rolesRouter.get('/', async (_req, res, next) => {
  try {
    const roles = await prisma.role.findMany({ orderBy: { name: 'asc' } })
    res.json(roles)
  } catch (err) {
    next(err)
  }
})

rolesRouter.post('/:id/permissions', async (req, res, next) => {
  try {
    const { permissionId } = z.object({ permissionId: z.string().uuid() }).parse(req.body)
    await prisma.rolePermission.upsert({
      where: { roleId_permissionId: { roleId: req.params.id, permissionId } },
      create: { roleId: req.params.id, permissionId },
      update: {},
    })
    res.status(204).end()
  } catch (err) {
    next(err)
  }
})
