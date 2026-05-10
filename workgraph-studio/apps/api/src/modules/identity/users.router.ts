import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { prisma } from '../../lib/prisma'
import { validate } from '../../middleware/validate'
import { parsePagination, toPageResponse } from '../../lib/pagination'
import { NotFoundError } from '../../lib/errors'

export const usersRouter: Router = Router()

const createUserSchema = z.object({
  email: z.string().email(),
  displayName: z.string().min(1),
  password: z.string().min(8),
  teamId: z.string().uuid().optional(),
})

const updateUserSchema = z.object({
  displayName: z.string().min(1).optional(),
  teamId: z.string().uuid().nullable().optional(),
  isActive: z.boolean().optional(),
})

function toDTO(user: Record<string, unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { passwordHash, ...rest } = user as { passwordHash: string; [key: string]: unknown }
  return rest
}

usersRouter.post('/', validate(createUserSchema), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof createUserSchema>
    const passwordHash = await bcrypt.hash(body.password, 12)
    const user = await prisma.user.create({
      data: { email: body.email, displayName: body.displayName, passwordHash, teamId: body.teamId },
      include: { team: true, roles: { include: { role: true } }, skills: { include: { skill: true } } },
    })
    res.status(201).json(toDTO(user))
  } catch (err) {
    next(err)
  }
})

usersRouter.get('/', async (req, res, next) => {
  try {
    const pg = parsePagination(req.query as Record<string, unknown>)
    const [users, total] = await Promise.all([
      prisma.user.findMany({
        skip: pg.skip, take: pg.take,
        include: { team: true, roles: { include: { role: true } }, skills: { include: { skill: true } } },
        orderBy: { displayName: 'asc' },
      }),
      prisma.user.count(),
    ])
    res.json(toPageResponse(users.map(toDTO), total, pg))
  } catch (err) {
    next(err)
  }
})

usersRouter.get('/:id', async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      include: { team: true, roles: { include: { role: true } }, skills: { include: { skill: true } } },
    })
    if (!user) throw new NotFoundError('User', req.params.id)
    res.json(toDTO(user))
  } catch (err) {
    next(err)
  }
})

usersRouter.patch('/:id', validate(updateUserSchema), async (req, res, next) => {
  try {
    const user = await prisma.user.update({
      where: { id: req.params.id as string },
      data: req.body,
      include: { team: true, roles: { include: { role: true } }, skills: { include: { skill: true } } },
    })
    res.json(toDTO(user))
  } catch (err) {
    next(err)
  }
})

usersRouter.post('/:id/roles', async (req, res, next) => {
  try {
    const { roleId } = z.object({ roleId: z.string().uuid() }).parse(req.body)
    await prisma.userRole.upsert({
      where: { userId_roleId: { userId: req.params.id, roleId } },
      create: { userId: req.params.id, roleId },
      update: {},
    })
    res.status(204).end()
  } catch (err) {
    next(err)
  }
})

usersRouter.post('/:id/skills', async (req, res, next) => {
  try {
    const { skillId, proficiencyLevel } = z.object({
      skillId: z.string().uuid(),
      proficiencyLevel: z.number().int().min(1).max(5).optional(),
    }).parse(req.body)
    await prisma.userSkill.upsert({
      where: { userId_skillId: { userId: req.params.id, skillId } },
      create: { userId: req.params.id, skillId, proficiencyLevel },
      update: { proficiencyLevel },
    })
    res.status(204).end()
  } catch (err) {
    next(err)
  }
})
