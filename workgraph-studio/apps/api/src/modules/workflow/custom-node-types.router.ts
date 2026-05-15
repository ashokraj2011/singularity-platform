import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../lib/prisma'
import { validate } from '../../middleware/validate'
import { NotFoundError } from '../../lib/errors'

export const customNodeTypesRouter: Router = Router()

const fieldDefSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  placeholder: z.string().default(''),
  multiline: z.boolean().default(false),
})

const createSchema = z.object({
  name: z.string().min(1).max(64).regex(/^[A-Z][A-Z0-9_]*$/, 'Must be UPPER_SNAKE_CASE'),
  label: z.string().min(1).max(80),
  description: z.string().optional(),
  color: z.string().default('#64748b'),
  icon: z.string().default('Box'),
  baseType: z.enum([
    'HUMAN_TASK', 'AGENT_TASK', 'APPROVAL', 'DECISION_GATE',
    'CONSUMABLE_CREATION', 'TOOL_REQUEST', 'POLICY_CHECK',
    'TIMER', 'SIGNAL_WAIT', 'CALL_WORKFLOW', 'WORK_ITEM', 'FOREACH',
  ]).default('HUMAN_TASK'),
  fields: z.array(fieldDefSchema).default([]),
  supportsForms: z.boolean().default(false),
  isActive: z.boolean().default(true),
})

const patchSchema = createSchema.partial().omit({ name: true })

customNodeTypesRouter.get('/', async (req, res, next) => {
  try {
    const types = await prisma.customNodeType.findMany({
      where: req.query.active === 'false' ? {} : { isActive: true },
      orderBy: { label: 'asc' },
    })
    res.json(types)
  } catch (err) {
    next(err)
  }
})

customNodeTypesRouter.post('/', validate(createSchema), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof createSchema>
    const type = await prisma.customNodeType.create({
      data: { ...body, createdById: req.user!.userId },
    })
    res.status(201).json(type)
  } catch (err) {
    next(err)
  }
})

customNodeTypesRouter.get('/:id', async (req, res, next) => {
  try {
    const type = await prisma.customNodeType.findUnique({ where: { id: req.params.id as string } })
    if (!type) throw new NotFoundError('CustomNodeType', req.params.id as string)
    res.json(type)
  } catch (err) {
    next(err)
  }
})

customNodeTypesRouter.patch('/:id', validate(patchSchema), async (req, res, next) => {
  try {
    const type = await prisma.customNodeType.update({
      where: { id: req.params.id as string },
      data: req.body,
    })
    res.json(type)
  } catch (err) {
    next(err)
  }
})

customNodeTypesRouter.delete('/:id', async (req, res, next) => {
  try {
    await prisma.customNodeType.delete({ where: { id: req.params.id as string } })
    res.status(204).end()
  } catch (err) {
    next(err)
  }
})
