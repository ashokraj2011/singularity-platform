import { Router } from 'express'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { normalizeTraceId, traceIdFromParts } from '@workgraph/shared-types'
import { validate } from '../../middleware/validate'
import { logEvent } from '../../lib/audit'
import { fanOutToWorkItemTriggersDetailed } from '../work-items/work-item-event-fanout'

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
  traceId: z.string().max(300).optional(),
  trace_id: z.string().max(300).optional(),
  payload: z.record(z.unknown()).default({}),
})

eventIntakeRouter.post('/', validate(ingestSchema), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof ingestSchema>
    const traceId = normalizeTraceId(req.header('x-singularity-trace-id'))
      ?? normalizeTraceId(body.traceId)
      ?? normalizeTraceId(body.trace_id)
      ?? traceIdFromParts(['event', body.deliveryId ?? randomUUID()])
    const results = await fanOutToWorkItemTriggersDetailed({
      eventTypeKey: body.eventType,
      payload: body.payload,
      deliveryId: body.deliveryId,
      capabilityId: body.capabilityId,
      sourceEventTypeKey: body.eventType,
      traceId,
    })
    const workItemIds = [...new Set(results.flatMap(result => result.workItemId ? [result.workItemId] : []))]
    const eventStatus =
      results.length === 0 ? 'dead_lettered'
      : results.some(result => result.status === 'failed') ? 'failed'
      : results.some(result => result.workflowInstanceId) ? 'running'
      : 'routed'
    const eventLogType = eventStatus === 'dead_lettered'
      ? 'WorkflowInboundEventDeadLettered'
      : eventStatus === 'failed'
        ? 'WorkflowInboundEventFailed'
        : 'WorkflowInboundEventReceived'
    const operationEventId = await logEvent(eventLogType, 'WorkflowInboundEvent', body.deliveryId ?? body.eventType, req.user?.userId, {
      status: eventStatus,
      eventType: body.eventType,
      eventTypeKey: body.eventType,
      deliveryId: body.deliveryId ?? null,
      capabilityId: body.capabilityId ?? null,
      payload: body.payload,
      workItemIds,
      triggerResults: results,
      matchedTriggerIds: results.map(result => result.triggerId),
      workflowInstanceIds: [...new Set(results.flatMap(result => result.workflowInstanceId ? [result.workflowInstanceId] : []))],
      lastError: results.find(result => result.error)?.error ?? (results.length === 0 ? 'No active WorkItem EVENT trigger matched this event.' : null),
      traceId,
      trace_id: traceId,
    })
    res.status(202).json({ eventType: body.eventType, operationEventId, traceId, status: eventStatus, workItemIds, count: workItemIds.length, triggerResults: results })
  } catch (err) { next(err) }
})
