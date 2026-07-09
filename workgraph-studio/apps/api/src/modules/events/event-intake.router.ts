import { Router } from 'express'
import { z } from 'zod'
import { validate } from '../../middleware/validate'
import { fanOutToWorkItemTriggers } from '../work-items/work-item-event-fanout'

/**
 * P1-9A — canonical, authenticated event intake.
 *
 * An authenticated caller (IAM bearer, via authMiddleware at the mount) posts a
 * business event; it fans out to matching WorkItem EVENT triggers (create/attach
 * a WorkItem + route/AUTO_START) via the shared fanOutToWorkItemTriggers helper,
 * idempotent on the optional deliveryId.
 *
 * This is the non-demo home for the intake previously reachable only via
 * /api/demo/event-verifier/ingest (which stays for existing demo callers). The
 * HMAC / cross-service PUSH path lives separately at /api/events/incoming.
 */
export const eventIntakeRouter: Router = Router()

const ingestSchema = z.object({
  // The business event type; matched (normalized) against active EVENT WorkItemTriggers.
  eventType: z.string().min(1).max(200),
  // Optional narrowing to one capability's triggers; omit to fan out to all
  // capabilities subscribed to this event type.
  capabilityId: z.string().optional(),
  // Optional caller-supplied per-delivery id for exact-once dedup on retries.
  // Falls back to the trigger's resolved correlation key when omitted.
  deliveryId: z.string().max(200).optional(),
  payload: z.record(z.unknown()).default({}),
})

eventIntakeRouter.post('/', validate(ingestSchema), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof ingestSchema>
    const workItemIds = await fanOutToWorkItemTriggers({
      eventTypeKey: body.eventType,
      payload: body.payload,
      deliveryId: body.deliveryId,
      capabilityId: body.capabilityId,
      sourceEventTypeKey: body.eventType,
    })
    res.status(202).json({ eventType: body.eventType, workItemIds, count: workItemIds.length })
  } catch (err) { next(err) }
})
