import { prisma } from '../../lib/prisma'
import { createWorkItem } from './work-items.service'
import { routeWorkItem } from './work-item-routing.service'
import {
  findAttachableWorkItemForTrigger,
  resolveTriggerCorrelationKey,
  triggerDocumentsFromPayload,
  claimTriggerEvent,
  recordTriggerEventWorkItem,
} from './work-item-trigger-attach'
import { normalizeMetadataKey, recordOf } from '../metadata/metadata.service'

// P1-9 — fan an inbound event out to matching WorkItem EVENT triggers: create (or
// attach to) a WorkItem and, under AUTO_START, start a run. This is the same model
// TriggerScheduler applies to internal outbox events, but push-driven — used by the
// cross-service /api/events/incoming receiver so verified events actually start work
// instead of being logged and dropped.
//
// Idempotent: dedup keyed on the upstream per-delivery id when available (else the
// resolved correlation key), so a re-delivered event doesn't double-create/route.
export async function fanOutToWorkItemTriggers(args: {
  eventTypeKey: string
  payload: Record<string, unknown>
  deliveryId?: string | null
  sourceEventTypeKey?: string
  // Optional narrowing: when set, only triggers on this capability fire (else the
  // event fans out to every capability's trigger for the event type — pub/sub).
  capabilityId?: string | null
  traceId?: string | null
}): Promise<string[]> {
  const results = await fanOutToWorkItemTriggersDetailed(args)
  return results.flatMap(result => result.workItemId ? [result.workItemId] : [])
}

export type WorkItemTriggerFanoutResult = {
  triggerId: string
  triggerType: 'EVENT'
  eventTypeKey: string
  capabilityId: string | null
  workItemTypeKey: string
  routingMode: string
  status: 'matched' | 'duplicate' | 'routed' | 'running' | 'failed'
  workItemId?: string
  targetId?: string | null
  routingPolicyId?: string | null
  routingState?: string | null
  workflowTemplateId?: string | null
  workflowInstanceId?: string | null
  attachedExisting?: boolean
  correlationKey?: string
  dedupeValue?: string
  error?: string
  traceId?: string
}

export async function fanOutToWorkItemTriggersDetailed(args: {
  eventTypeKey: string
  payload: Record<string, unknown>
  deliveryId?: string | null
  sourceEventTypeKey?: string
  capabilityId?: string | null
  traceId?: string | null
}): Promise<WorkItemTriggerFanoutResult[]> {
  const eventTypeKey = normalizeMetadataKey(args.eventTypeKey)
  if (!eventTypeKey) return []
  const capabilityId = typeof args.capabilityId === 'string' && args.capabilityId.trim() ? args.capabilityId.trim() : undefined

  const triggers = await prisma.workItemTrigger.findMany({
    where: { triggerType: 'EVENT', isActive: true, eventTypeKey, ...(capabilityId ? { capabilityId } : {}) },
  })

  const results: WorkItemTriggerFanoutResult[] = []
  for (const trigger of triggers) {
    if (!trigger.capabilityId) continue
    const base: Omit<WorkItemTriggerFanoutResult, 'status'> = {
      triggerId: trigger.id,
      triggerType: 'EVENT',
      eventTypeKey,
      capabilityId: trigger.capabilityId,
      workItemTypeKey: trigger.workItemTypeKey,
      routingMode: trigger.routingMode,
      ...(args.traceId ? { traceId: args.traceId } : {}),
    }
    try {
      const mapping = recordOf(trigger.payloadMapping)
      const correlationKey = resolveTriggerCorrelationKey({ payload: args.payload, payloadMapping: mapping, dedupeKey: trigger.dedupeKey })
      const documents = triggerDocumentsFromPayload({ payload: args.payload, payloadMapping: mapping })
      const attachable = await findAttachableWorkItemForTrigger({
        payload: args.payload, payloadMapping: mapping, dedupeKey: trigger.dedupeKey, capabilityId: trigger.capabilityId,
      })

      // Prefer the upstream delivery id (a true per-delivery id) as the dedup key so a
      // re-delivery is exactly-once; else fall back to the resolved correlation key.
      const deliveryId = typeof args.deliveryId === 'string' && args.deliveryId.trim() ? args.deliveryId.trim() : undefined
      const dedupeValue = deliveryId ? `${eventTypeKey}:${deliveryId}` : correlationKey

      if (!attachable) {
        const claim = await claimTriggerEvent({ triggerId: trigger.id, dedupeValue })
        if (claim.status === 'duplicate') {
          await prisma.workItemTrigger.update({ where: { id: trigger.id }, data: { lastFiredAt: new Date() } }).catch(() => {})
          results.push({
            ...base,
            status: 'duplicate',
            ...(claim.workItemId ? { workItemId: claim.workItemId } : {}),
            correlationKey,
            dedupeValue,
          })
          continue
        }
      }

      const title = typeof mapping.title === 'string' ? mapping.title : `${trigger.workItemTypeKey} event work`
      const workflowTypeKey = typeof mapping.workflowTypeKey === 'string' ? normalizeMetadataKey(mapping.workflowTypeKey) : undefined
      const workItem = attachable?.workItem ?? await createWorkItem({
        title,
        workItemTypeKey: trigger.workItemTypeKey,
        routingMode: trigger.routingMode,
        workflowTypeKey,
        sourceEventTypeKey: args.sourceEventTypeKey ?? trigger.eventTypeKey ?? undefined,
        parentCapabilityId: trigger.capabilityId,
        input: { triggerType: 'EVENT', eventType: trigger.eventTypeKey, payload: args.payload, triggerCorrelationKey: correlationKey, traceId: args.traceId ?? null, trace_id: args.traceId ?? null, documents },
        details: {
          title,
          source: 'incoming-event',
          triggerId: trigger.id,
          triggerCorrelationKey: correlationKey ?? null,
          traceId: args.traceId ?? null,
          trace_id: args.traceId ?? null,
          documents,
          input: args.payload,
        },
        originType: 'CAPABILITY_LOCAL',
        targets: [{ targetCapabilityId: trigger.capabilityId }],
      }, null)

      if (!attachable) {
        await recordTriggerEventWorkItem({ triggerId: trigger.id, dedupeValue, workItemId: workItem.id })
        await prisma.workItemEvent.create({
          data: {
            workItemId: workItem.id,
            eventType: 'TRIGGERED',
            payload: { triggerId: trigger.id, firedAt: new Date().toISOString(), source: 'incoming-event', triggerCorrelationKey: correlationKey, traceId: args.traceId ?? null, trace_id: args.traceId ?? null, documents } as object,
          },
        }).catch(() => {})
      }

      await prisma.workItemTrigger.update({ where: { id: trigger.id }, data: { lastFiredAt: new Date() } }).catch(() => {})
      const routed = await routeWorkItem(workItem.id, null, { routingMode: trigger.routingMode, workflowTypeKey })
      const target = routed.targets[0]
      results.push({
        ...base,
        status: target?.childWorkflowInstanceId ? 'running' : routed.routingState === 'ROUTE_FAILED' ? 'failed' : 'routed',
        workItemId: routed.id,
        targetId: target?.id ?? null,
        routingPolicyId: routed.routingPolicyId ?? null,
        routingState: routed.routingState,
        workflowTemplateId: target?.childWorkflowTemplateId ?? null,
        workflowInstanceId: target?.childWorkflowInstanceId ?? null,
        attachedExisting: Boolean(attachable),
        correlationKey,
        dedupeValue,
        error: routed.routingState === 'ROUTE_FAILED' ? 'WorkItem routing failed to resolve a workflow template.' : undefined,
      })
    } catch (err) {
      results.push({
        ...base,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return results
}
