import { Router } from 'express'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { validate } from '../../middleware/validate'
import { normalizeMetadataKey } from './metadata.service'

export const metadataDefinitionsRouter: Router = Router()

const kinds = ['WORK_ITEM_TYPE', 'WORKFLOW_TYPE', 'NODE_TYPE', 'EVENT_TYPE', 'TRIGGER_PROFILE'] as const
const statuses = ['DRAFT', 'ACTIVE', 'DEPRECATED', 'ARCHIVED'] as const
const scopeTypes = ['GLOBAL', 'CAPABILITY', 'WORKFLOW', 'NODE'] as const

const jsonRecord = z.record(z.unknown()).default({})

const createSchema = z.object({
  kind: z.enum(kinds),
  key: z.string().min(1),
  version: z.number().int().positive().default(1),
  status: z.enum(statuses).default('ACTIVE'),
  scopeType: z.enum(scopeTypes).default('GLOBAL'),
  scopeId: z.string().min(1).default('*'),
  label: z.string().min(1),
  description: z.string().optional(),
  icon: z.string().optional(),
  color: z.string().optional(),
  category: z.string().optional(),
  schema: jsonRecord,
  defaults: jsonRecord,
  policy: jsonRecord,
  ui: jsonRecord,
  compatibility: jsonRecord,
})

const updateSchema = createSchema.partial().omit({ kind: true, key: true, version: true, scopeType: true, scopeId: true })

metadataDefinitionsRouter.get('/', async (req, res, next) => {
  try {
    const { kind, key, status, scopeType, scopeId } = req.query as Record<string, string | undefined>
    const where: Prisma.MetadataDefinitionWhereInput = {}
    if (kind && (kinds as readonly string[]).includes(kind)) where.kind = kind as any
    if (key) where.key = normalizeMetadataKey(key)
    if (status && (statuses as readonly string[]).includes(status)) where.status = status as any
    if (scopeType && (scopeTypes as readonly string[]).includes(scopeType)) where.scopeType = scopeType as any
    if (scopeId) where.scopeId = scopeId
    const items = await prisma.metadataDefinition.findMany({
      where,
      orderBy: [{ kind: 'asc' }, { key: 'asc' }, { scopeType: 'asc' }, { version: 'desc' }],
    })
    res.json({ items })
  } catch (err) {
    next(err)
  }
})

metadataDefinitionsRouter.post('/', validate(createSchema), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof createSchema>
    const item = await prisma.metadataDefinition.create({
      data: {
        ...body,
        key: normalizeMetadataKey(body.key),
        scopeId: body.scopeType === 'GLOBAL' ? '*' : body.scopeId,
        schema: body.schema as Prisma.InputJsonValue,
        defaults: body.defaults as Prisma.InputJsonValue,
        policy: body.policy as Prisma.InputJsonValue,
        ui: body.ui as Prisma.InputJsonValue,
        compatibility: body.compatibility as Prisma.InputJsonValue,
      },
    })
    res.status(201).json(item)
  } catch (err) {
    next(err)
  }
})

metadataDefinitionsRouter.patch('/:id', validate(updateSchema), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof updateSchema>
    const item = await prisma.metadataDefinition.update({
      where: { id: req.params.id },
      data: {
        ...(body.status !== undefined ? { status: body.status } : {}),
        ...(body.label !== undefined ? { label: body.label } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.icon !== undefined ? { icon: body.icon } : {}),
        ...(body.color !== undefined ? { color: body.color } : {}),
        ...(body.category !== undefined ? { category: body.category } : {}),
        ...(body.schema !== undefined ? { schema: body.schema as Prisma.InputJsonValue } : {}),
        ...(body.defaults !== undefined ? { defaults: body.defaults as Prisma.InputJsonValue } : {}),
        ...(body.policy !== undefined ? { policy: body.policy as Prisma.InputJsonValue } : {}),
        ...(body.ui !== undefined ? { ui: body.ui as Prisma.InputJsonValue } : {}),
        ...(body.compatibility !== undefined ? { compatibility: body.compatibility as Prisma.InputJsonValue } : {}),
      },
    })
    res.json(item)
  } catch (err) {
    next(err)
  }
})
