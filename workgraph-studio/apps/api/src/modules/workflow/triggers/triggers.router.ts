import { Router } from 'express'
import { z } from 'zod'
import crypto from 'node:crypto'
import { prisma } from '../../../lib/prisma'
import { config } from '../../../config'
import { withTenantDbTransaction } from '../../../lib/tenant-db-context'
import { validate } from '../../../middleware/validate'
import { logEvent, publishOutbox } from '../../../lib/audit'
import { createWorkItem } from '../../work-items/work-items.service'
import { routeWorkItem } from '../../work-items/work-item-routing.service'
import { systemRouteActor } from '../../work-items/work-item-actors'
import { findAttachableWorkItemForTrigger, resolveTriggerCorrelationKey, triggerDocumentsFromPayload, claimTriggerEvent, recordTriggerEventWorkItem } from '../../work-items/work-item-trigger-attach'
import { recordOf } from '../../metadata/metadata.service'
import { tenantIdForCreate, resolveTenantFromRequest, tenantIsolationStrict, requireTenantFromRequest } from '../../../lib/tenant-isolation'
import { assertTemplatePermission, canViewTemplate } from '../../../lib/permissions/workflowTemplate'
import { startInstance } from '../runtime/WorkflowRuntime'
import { assertEventPayloadSize, redactEventPayload } from '../../events/event-payload'
import { ValidationError } from '../../../lib/errors'

// Constant-time secret comparison. Hash both sides to a fixed 32-byte digest
// first so timingSafeEqual never sees unequal lengths (which throws and would
// also leak the secret length). Returns false for non-strings.
function secretEquals(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0 || b.length === 0) return false
  const ha = crypto.createHash('sha256').update(a).digest()
  const hb = crypto.createHash('sha256').update(b).digest()
  return crypto.timingSafeEqual(ha, hb)
}

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
    const template = await assertTemplatePermission(req.user!.userId, body.templateId, 'edit')
    let config = body.config
    // For WEBHOOK, auto-generate a secret if missing
    if (body.type === 'WEBHOOK' && typeof (config as Record<string, unknown>).secret !== 'string') {
      config = { ...config, secret: crypto.randomBytes(24).toString('hex') }
    }
    const tenantId = template.tenantId ?? (tenantIsolationStrict() ? requireTenantFromRequest(req, 'workflow trigger creation') : resolveTenantFromRequest(req) ?? 'default')
    const trigger = await withTenantDbTransaction(prisma, tx => tx.workflowTrigger.create({
      data: { ...body, config: config as object, tenantId },
    }), tenantId)
    res.status(201).json(trigger)
  } catch (err) { next(err) }
})

triggersRouter.get('/', async (req, res, next) => {
  try {
    const tenantId = tenantIsolationStrict() ? requireTenantFromRequest(req, 'workflow trigger listing') : resolveTenantFromRequest(req)
    const { templateId } = req.query
    if (templateId) await assertTemplatePermission(req.user!.userId, String(templateId), 'view')
    const where = { ...(templateId ? { templateId: String(templateId) } : {}), ...(tenantId ? { tenantId } : {}) }
    const triggers = await withTenantDbTransaction(prisma, tx => tx.workflowTrigger.findMany({ where, orderBy: { createdAt: 'desc' } }), tenantId)
    if (templateId) {
      res.json(triggers)
      return
    }
    const visibility = await Promise.all([...new Set(triggers.map(trigger => trigger.templateId))].map(async id => ({
      id,
      allowed: await canViewTemplate(req.user!.userId, id),
    })))
    const visibleTemplateIds = new Set(visibility.filter(item => item.allowed).map(item => item.id))
    res.json(triggers.filter(trigger => visibleTemplateIds.has(trigger.templateId)))
  } catch (err) { next(err) }
})

triggersRouter.delete('/:id', async (req, res, next) => {
  try {
    const trigger = await withTenantDbTransaction(prisma, tx => tx.workflowTrigger.findUnique({ where: { id: req.params.id }, select: { templateId: true, tenantId: true } }), resolveTenantFromRequest(req))
    if (!trigger) return res.status(204).end()
    await assertTemplatePermission(req.user!.userId, trigger.templateId, 'edit')
    await withTenantDbTransaction(prisma, tx => tx.workflowTrigger.delete({ where: { id: req.params.id } }), trigger.tenantId ?? resolveTenantFromRequest(req))
    res.status(204).end()
  } catch (err) { next(err) }
})

// Webhook receiver — public (no auth) but secret-gated
export const webhookRouter: Router = Router()
webhookRouter.post('/:secret', async (req, res, next) => {
  try {
    // Find by secret in config (linear scan since secrets live in a JSON config
    // blob, not an indexed column). Constant-time compare to avoid a timing oracle
    // that could recover a secret byte-by-byte.
    const all = await prisma.workflowTrigger.findMany({
      where: { type: 'WEBHOOK', isActive: true },
      include: { template: true },
    })
    const match = all.find(t => secretEquals((t.config as Record<string, unknown> | null)?.secret, req.params.secret))
    if (!match) {
      const workItemTriggers = await prisma.workItemTrigger.findMany({
        where: { triggerType: 'WEBHOOK', isActive: true },
      })
      const workItemMatch = workItemTriggers.find(t => secretEquals(recordOf(t.scheduleConfig).secret, req.params.secret) || secretEquals(recordOf(t.payloadMapping).secret, req.params.secret))
      if (!workItemMatch || !workItemMatch.capabilityId) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'No matching webhook trigger' })
        return
      }
      const mapping = recordOf(workItemMatch.payloadMapping)
      const title = typeof mapping.title === 'string' ? mapping.title : `${workItemMatch.workItemTypeKey} webhook work`
      const payload = recordOf(req.body)
      assertEventPayloadSize(payload)
      const safePayload = redactEventPayload(payload)
      const documents = triggerDocumentsFromPayload({ payload: safePayload, payloadMapping: mapping })
      const attachable = await findAttachableWorkItemForTrigger({
        payload,
        payloadMapping: mapping,
        dedupeKey: workItemMatch.dedupeKey,
        capabilityId: workItemMatch.capabilityId,
      })
      const correlationKey = resolveTriggerCorrelationKey({
        payload,
        payloadMapping: mapping,
        dedupeKey: workItemMatch.dedupeKey,
      })
      // P1-7 — nothing attachable means we're about to CREATE. Claim the event
      // first so a concurrent/retried delivery can't create a second WorkItem
      // (which, under AUTO_START, would double-start a run).
      if (!attachable) {
        const claim = await claimTriggerEvent({ triggerId: workItemMatch.id, dedupeValue: correlationKey })
        if (claim.status === 'duplicate') {
          await prisma.workItemTrigger.update({ where: { id: workItemMatch.id }, data: { lastFiredAt: new Date() } })
          res.status(202).json({ workItemId: claim.workItemId, deduped: true })
          return
        }
      }
      const workItem = attachable?.workItem ?? await createWorkItem({
        title,
        description: typeof mapping.description === 'string' ? mapping.description : undefined,
        workItemTypeKey: workItemMatch.workItemTypeKey,
        routingMode: workItemMatch.routingMode,
        sourceEventTypeKey: workItemMatch.eventTypeKey ?? 'WEBHOOK',
        parentCapabilityId: workItemMatch.capabilityId,
        input: { webhookPayload: safePayload, triggerCorrelationKey: correlationKey, documents },
        details: {
          title,
          description: typeof mapping.description === 'string' ? mapping.description : null,
          source: 'work-item-webhook',
          triggerId: workItemMatch.id,
          triggerCorrelationKey: correlationKey ?? null,
          documents,
          input: { webhookPayload: safePayload, documents },
        },
        originType: 'CAPABILITY_LOCAL',
        tenantId: workItemMatch.tenantId,
        targets: [{ targetCapabilityId: workItemMatch.capabilityId }],
      }, null)
      if (!attachable) {
        await recordTriggerEventWorkItem({ triggerId: workItemMatch.id, dedupeValue: correlationKey, workItemId: workItem.id })
      }
      if (attachable) {
        await prisma.workItemEvent.create({
          data: {
            workItemId: workItem.id,
            eventType: 'TRIGGERED',
            payload: {
              triggerId: workItemMatch.id,
              firedAt: new Date().toISOString(),
              attachedExisting: true,
              matchedBy: attachable.matchedBy,
              sourceEventTypeKey: workItemMatch.eventTypeKey ?? 'WEBHOOK',
              triggerCorrelationKey: correlationKey,
              documents,
              webhookPayload: safePayload,
            } as object,
          },
        })
      }
      await prisma.workItemTrigger.update({ where: { id: workItemMatch.id }, data: { lastFiredAt: new Date() } })
      const routed = await routeWorkItem(workItem.id, systemRouteActor('webhook-trigger'), { routingMode: workItemMatch.routingMode })
      res.status(202).json({ workItemId: routed.id })
      return
    }

    // The webhook secret identifies a trigger, so the trigger/template tenant
    // is the authority. Never let an unauthenticated payload choose the DB
    // tenant, and never create a tenantless legacy-trigger run in strict mode.
    const triggerTenantId = match.tenantId ?? match.template.tenantId ?? (tenantIsolationStrict() ? undefined : config.WORKGRAPH_DEFAULT_TENANT_ID)
    if (!triggerTenantId) {
      throw new ValidationError(`WorkflowTrigger ${match.id} has no tenant; backfill trigger/template tenant before webhook execution`)
    }
    assertEventPayloadSize(req.body)
    const safeWebhookPayload = redactEventPayload(req.body)
    const context = {
      tenantId: triggerTenantId,
      _webhookPayload: safeWebhookPayload,
      _triggeredAt: new Date().toISOString(),
    }
    // Public webhook — no request tenant. Scope to the trigger/template tenant
    // only; payload tenant selection would be an unauthenticated cross-tenant
    // write primitive.
    const instance = await withTenantDbTransaction(prisma, (tx) => tx.workflowInstance.create({
      data: {
        templateId: match.templateId,
        name: `${match.template.name} (webhook)`,
        status: 'DRAFT',
        tenantId: tenantIdForCreate(context),
        context: context as object,
      },
    }), triggerTenantId)
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
    // Actually start the run (previously left DRAFT and never started, so
    // webhook-triggered runs did nothing). Fire-and-forget so the webhook acks
    // fast; a start failure is logged and the instance remains for inspection.
    void startInstance(instance.id, undefined, instance.tenantId ?? undefined).catch((err) =>
      logEvent('WorkflowTriggerStartFailed', 'WorkflowInstance', instance.id, undefined, {
        triggerId: match.id, via: 'WEBHOOK', error: (err as Error).message,
      }),
    )
    res.status(202).json({ instanceId: instance.id })
  } catch (err) { next(err) }
})
