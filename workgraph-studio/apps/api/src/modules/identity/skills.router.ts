import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../lib/prisma'
import { validate } from '../../middleware/validate'

export const skillsRouter: Router = Router()

const createSkillSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  category: z.string().optional(),
})

skillsRouter.post('/', validate(createSkillSchema), async (req, res, next) => {
  try {
    const skill = await prisma.skill.create({ data: req.body })
    res.status(201).json(skill)
  } catch (err) {
    next(err)
  }
})

skillsRouter.get('/', async (_req, res, next) => {
  try {
    const skills = await prisma.skill.findMany({ orderBy: { name: 'asc' } })
    res.json(skills)
  } catch (err) {
    next(err)
  }
})
