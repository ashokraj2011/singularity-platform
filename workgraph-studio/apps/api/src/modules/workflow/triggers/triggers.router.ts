import { Router } from 'express'
import { z } from 'zod'
import crypto from 'node:crypto'
import { prisma } from '../../../lib/prisma'
import { validate } from '../../../middleware/validate'
import { logEvent, publishOutbox } from '../../../lib/audit'

export const triggersRouter: Router = Router()

const createTriggerSchema = z.object({
  templateId: z.string().uuid(),
  type: z.enum(['WEBHOOK', 'SCHEDULE', 'EVENT']),
  isActive: z.boolean().default(true),
  config: z.record(z.unknown()).default({}),
})

triggersRouter.post('/', validate(createTriggerSchema), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof createTriggerSchema>
    let config = body.config
    // For WEBHOOK, auto-generate a secret if missing
    if (body.type === 'WEBHOOK' && typeof (config as Record<string, unknown>).secret !== 'string') {
      config = { ...config, secret: crypto.randomBytes(24).toString('hex') }
    }
    const trigger = await prisma.workflowTrigger.create({
      data: { ...body, config: config as object },
    })
    res.status(201).json(trigger)
  } catch (err) { next(err) }
})

triggersRouter.get('/', async (req, res, next) => {
  try {
    const { templateId } = req.query
    const where = templateId ? { templateId: String(templateId) } : {}
    const triggers = await prisma.workflowTrigger.findMany({ where, orderBy: { createdAt: 'desc' } })
    res.json(triggers)
  } catch (err) { next(err) }
})

triggersRouter.delete('/:id', async (req, res, next) => {
  try {
    await prisma.workflowTrigger.delete({ where: { id: req.params.id } })
    res.status(204).end()
  } catch (err) { next(err) }
})

// Webhook receiver — public (no auth) but secret-gated
export const webhookRouter: Router = Router()
webhookRouter.post('/:secret', async (req, res, next) => {
  try {
    const trigger = await prisma.workflowTrigger.findFirst({
      where: { type: 'WEBHOOK', isActive: true },
      include: { template: true },
    })
    // Find by secret in config (linear scan since secrets are not indexed)
    const all = await prisma.workflowTrigger.findMany({
      where: { type: 'WEBHOOK', isActive: true },
      include: { template: true },
    })
    const match = all.find(t => {
      const c = (t.config ?? {}) as Record<string, unknown>
      return c.secret === req.params.secret
    })
    if (!match) {
      res.status(404).json({ code: 'NOT_FOUND', message: 'No matching webhook trigger' })
      return
    }

    const instance = await prisma.workflowInstance.create({
      data: {
        templateId: match.templateId,
        name: `${match.template.name} (webhook)`,
        status: 'DRAFT',
        context: { _webhookPayload: req.body, _triggeredAt: new Date().toISOString() } as object,
      },
    })
    await prisma.workflowTrigger.update({
      where: { id: match.id },
      data: { lastFiredAt: new Date() },
    })
    await logEvent('WorkflowTriggered', 'WorkflowInstance', instance.id, undefined, {
      triggerId: match.id,
      via: 'WEBHOOK',
    })
    await publishOutbox('WorkflowInstance', instance.id, 'WorkflowTriggered', {
      instanceId: instance.id,
      triggerId: match.id,
    })
    void trigger // suppress unused warning
    res.status(202).json({ instanceId: instance.id })
  } catch (err) { next(err) }
})
