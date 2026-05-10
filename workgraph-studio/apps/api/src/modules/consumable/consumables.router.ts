import { Router } from 'express'
import { z } from 'zod'
import Ajv from 'ajv'
import { Prisma, ConsumableType, ConsumableVersion } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { validate } from '../../middleware/validate'
import { parsePagination, toPageResponse } from '../../lib/pagination'
import { NotFoundError, ValidationError } from '../../lib/errors'
import { logEvent, createReceipt, publishOutbox } from '../../lib/audit'

export const consumablesRouter: Router = Router()

const ajv = new Ajv()

const createConsumableSchema = z.object({
  typeId: z.string().uuid(),
  instanceId: z.string().uuid().optional(),
  name: z.string().min(1),
})

const createVersionSchema = z.object({
  payload: z.record(z.unknown()).default({}),
})

consumablesRouter.post('/', validate(createConsumableSchema), async (req, res, next) => {
  try {
    const consumable = await prisma.consumable.create({
      data: { ...req.body, createdById: req.user!.userId },
      include: { type: true },
    })
    await logEvent('ConsumableCreated', 'Consumable', consumable.id, req.user!.userId)
    res.status(201).json(consumable)
  } catch (err) {
    next(err)
  }
})

consumablesRouter.get('/', async (req, res, next) => {
  try {
    const pg = parsePagination(req.query as Record<string, unknown>)
    const { typeId, status, instanceId, nodeId } = req.query
    const where: Record<string, unknown> = {}
    if (typeId)     where.typeId     = typeId
    if (status)     where.status     = status
    if (instanceId) where.instanceId = instanceId
    if (nodeId)     where.nodeId     = nodeId

    const [consumables, total] = await Promise.all([
      prisma.consumable.findMany({
        where, skip: pg.skip, take: pg.take,
        include: { type: true },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.consumable.count({ where }),
    ])
    res.json(toPageResponse(consumables, total, pg))
  } catch (err) {
    next(err)
  }
})

consumablesRouter.get('/:id', async (req, res, next) => {
  try {
    const consumable = await prisma.consumable.findUnique({
      where: { id: req.params.id },
      include: { type: true, versions: { orderBy: { version: 'desc' } } },
    })
    if (!consumable) throw new NotFoundError('Consumable', req.params.id)
    res.json(consumable)
  } catch (err) {
    next(err)
  }
})

consumablesRouter.post('/:id/versions', validate(createVersionSchema), async (req, res, next) => {
  try {
    const { payload } = req.body as z.infer<typeof createVersionSchema>
    const id = req.params.id as string
    const consumable = await prisma.consumable.findUnique({
      where: { id },
      include: { type: true, versions: { orderBy: { version: 'desc' }, take: 1 } },
    }) as (Awaited<ReturnType<typeof prisma.consumable.findUnique>> & { type: ConsumableType; versions: ConsumableVersion[] }) | null
    if (!consumable) throw new NotFoundError('Consumable', id)

    // Schema validation against ConsumableType.schemaDef
    const schema = consumable.type.schemaDef as Record<string, unknown>
    if (schema && Object.keys(schema).length > 0) {
      const valid = ajv.validate(schema, payload)
      if (!valid) {
        throw new ValidationError(`Payload does not match consumable type schema: ${ajv.errorsText()}`)
      }
    }

    const nextVersion = (consumable.versions[0]?.version ?? 0) + 1
    const version = await prisma.consumableVersion.create({
      data: {
        consumableId: id,
        version: nextVersion,
        payload: payload as unknown as Prisma.InputJsonValue,
        createdById: req.user!.userId,
      },
    })
    await prisma.consumable.update({
      where: { id },
      data: { currentVersion: nextVersion },
    })
    res.status(201).json(version)
  } catch (err) {
    next(err)
  }
})

async function transitionStatus(
  consumableId: string,
  newStatus: string,
  actorId: string,
  receiptType?: string,
): Promise<void> {
  const consumable = await prisma.consumable.update({
    where: { id: consumableId },
    data: { status: newStatus as never },
  })
  const eventId = await logEvent(`Consumable${newStatus}`, 'Consumable', consumableId, actorId)
  if (receiptType) {
    await createReceipt(receiptType, 'Consumable', consumableId, {
      consumableId, status: newStatus, actorId,
    }, eventId)
  }
  await publishOutbox('Consumable', consumableId, `Consumable${newStatus}`, { consumableId, status: newStatus })
  void consumable
}

consumablesRouter.post('/:id/submit-review', async (req, res, next) => {
  try {
    await transitionStatus(req.params.id, 'UNDER_REVIEW', req.user!.userId)
    const c = await prisma.consumable.findUnique({ where: { id: req.params.id } })
    res.json(c)
  } catch (err) {
    next(err)
  }
})

consumablesRouter.post('/:id/approve', async (req, res, next) => {
  try {
    await transitionStatus(req.params.id, 'APPROVED', req.user!.userId, 'CONSUMABLE_APPROVAL')
    const c = await prisma.consumable.findUnique({ where: { id: req.params.id } })
    res.json(c)
  } catch (err) {
    next(err)
  }
})

consumablesRouter.post('/:id/reject', async (req, res, next) => {
  try {
    await transitionStatus(req.params.id, 'REJECTED', req.user!.userId)
    const c = await prisma.consumable.findUnique({ where: { id: req.params.id } })
    res.json(c)
  } catch (err) {
    next(err)
  }
})

consumablesRouter.post('/:id/publish', async (req, res, next) => {
  try {
    await transitionStatus(req.params.id, 'PUBLISHED', req.user!.userId)
    const c = await prisma.consumable.findUnique({ where: { id: req.params.id } })
    res.json(c)
  } catch (err) {
    next(err)
  }
})

consumablesRouter.post('/:id/supersede', async (req, res, next) => {
  try {
    await transitionStatus(req.params.id, 'SUPERSEDED', req.user!.userId)
    const c = await prisma.consumable.findUnique({ where: { id: req.params.id } })
    res.json(c)
  } catch (err) {
    next(err)
  }
})

// ─── Consumable Form Submission ───────────────────────────────────────────────

const consumableFormSubmissionSchema = z.object({
  data: z.record(z.unknown()),
  attachmentIds: z.array(z.string().uuid()).optional(),
})

consumablesRouter.post('/:id/form-submission', validate(consumableFormSubmissionSchema), async (req, res, next) => {
  try {
    const id = req.params.id as string
    const { data, attachmentIds } = req.body as z.infer<typeof consumableFormSubmissionSchema>

    const consumable = await prisma.consumable.findUnique({ where: { id } })
    if (!consumable) throw new NotFoundError('Consumable', id)

    const updated = await prisma.consumable.update({
      where: { id },
      data: { formData: data as unknown as Prisma.InputJsonValue },
    })

    if (attachmentIds && attachmentIds.length > 0) {
      await prisma.document.updateMany({
        where: { id: { in: attachmentIds } },
        data: { instanceId: consumable.instanceId },
      })
    }

    await logEvent('ConsumableFormSubmitted', 'Consumable', id, req.user!.userId, {
      instanceId: consumable.instanceId,
      attachmentCount: attachmentIds?.length ?? 0,
    })

    res.json({ consumable: updated, formData: data, attachmentIds: attachmentIds ?? [] })
  } catch (err) {
    next(err)
  }
})
