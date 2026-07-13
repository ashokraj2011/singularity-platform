import { Router, type Request } from 'express'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { traceIdFromParts } from '@workgraph/shared-types'
import { prisma } from '../../lib/prisma'
import { logEvent } from '../../lib/audit'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../lib/errors'
import { fanOutToWorkItemTriggersDetailed } from '../work-items/work-item-event-fanout'
import { requireTenantFromRequest, resolveTenantFromRequest, tenantIsolationStrict } from '../../lib/tenant-isolation'
import { assertWorkflowOperationsPermission, canViewWorkflowOperations } from '../../lib/permissions/workflowTemplate'

export const workflowOperationsRouter: Router = Router()

function tenantForOperations(req: Request): string | undefined {
  return tenantIsolationStrict()
    ? requireTenantFromRequest(req, 'workflow operations')
    : resolveTenantFromRequest(req)
}

// Operations data contains event payloads, delivery targets, and runner
// metadata. In strict mode every request must establish a tenant before any
// aggregate query is allowed to run.
workflowOperationsRouter.use((req, _res, next) => {
  try {
    tenantForOperations(req)
    next()
  } catch (error) {
    next(error)
  }
})

workflowOperationsRouter.get('/access-summary', async (req, res, next) => {
  try {
    if (!req.user?.userId) throw new ForbiddenError('Authenticated user required for workflow operations.')
    const actions = ['view', 'replay', 'retry_delivery', 'manage_runners', 'audit_view'] as const
    const entries = await Promise.all(actions.map(async action => ({
      action,
      allowed: await canViewWorkflowOperations(req.user!.userId, action, tenantForOperations(req)),
    })))
    res.json({ tenantId: tenantForOperations(req), policyVersion: 'workflow-authz-v1', actions: entries })
  } catch (err) { next(err) }
})

async function requireOperationsOperator(req: Request): Promise<void> {
  if (!req.user?.userId) throw new ForbiddenError('Authenticated user required for workflow operations.')
  await assertWorkflowOperationsPermission(req.user.userId, 'manage_runners', tenantForOperations(req))
}

const INBOUND_EVENT_TYPES = [
  'WorkflowInboundEventReceived',
  'WorkflowInboundEventDeadLettered',
  'WorkflowInboundEventFailed',
  'WorkflowInboundEventReplayed',
] as const

const EXECUTION_LOCATIONS = ['CLIENT', 'EDGE', 'EXTERNAL'] as const

type OpsWorkItem = {
  id: string
  workCode: string
  title: string
  status: string
  routingMode: string
  routingState: string
  routingPolicyId: string | null
  targets: Array<{
    id: string
    targetCapabilityId: string
    childWorkflowTemplateId: string | null
    childWorkflowInstanceId: string | null
    childWorkflowInstance?: { id: string; name: string; status: string; updatedAt: Date } | null
  }>
  events: Array<{ id: string; eventType: string; createdAt: Date; payload: unknown }>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : []
}

function triggerResultArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

function eventStatus(payload: Record<string, unknown>, workItems: Array<{ status: string; routingState: string; targets: Array<{ childWorkflowInstanceId: string | null; childWorkflowInstance?: { status: string } | null }> }>): string {
  const explicit = stringValue(payload.status)
  if (workItems.length === 0) return explicit ?? 'dead_lettered'
  if (workItems.some(item => item.routingState === 'ROUTE_FAILED')) return 'failed'
  const workflowStatuses = workItems.flatMap(item => item.targets.flatMap(target => target.childWorkflowInstance?.status ? [target.childWorkflowInstance.status.toUpperCase()] : []))
  if (workflowStatuses.some(status => ['FAILED', 'ERROR', 'CANCELLED', 'CANCELED', 'BLOCKED'].includes(status))) return 'failed'
  if (workflowStatuses.length > 0 && workflowStatuses.every(status => status === 'COMPLETED')) return 'completed'
  if (workflowStatuses.length > 0 || workItems.some(item => item.targets.some(target => target.childWorkflowInstanceId))) return 'running'
  if (workItems.some(item => item.routingState === 'ATTACHED')) return 'routed'
  if (explicit) return explicit
  return 'matched'
}

async function workItemsById(ids: string[], tenantId?: string): Promise<Map<string, OpsWorkItem>> {
  if (ids.length === 0) return new Map<string, OpsWorkItem>()
  const rows = await prisma.workItem.findMany({
    where: { id: { in: ids }, ...(tenantId ? { tenantId } : {}) },
    include: {
      targets: {
        orderBy: { createdAt: 'asc' },
        include: { childWorkflowInstance: { select: { id: true, name: true, status: true, updatedAt: true } } },
      },
      events: { orderBy: { createdAt: 'desc' }, take: 8 },
    },
  })
  return new Map(rows.map(row => [row.id, row as unknown as OpsWorkItem]))
}

async function serializeInboundEvent(row: {
  id: string
  eventType: string
  entityId: string
  payload: unknown
  occurredAt: Date
}, tenantId?: string, includeSensitive = false) {
  const payload = asRecord(row.payload)
  const triggerResults = triggerResultArray(payload.triggerResults)
  const workItemIds = [...new Set([
    ...stringArray(payload.workItemIds),
    ...triggerResults.flatMap(result => stringValue(result.workItemId) ? [stringValue(result.workItemId)!] : []),
  ])]
  const itemMap = await workItemsById(workItemIds, tenantId)
  const safeTriggerResults = includeSensitive
    ? triggerResults
    : triggerResults.map(result => ({
        triggerId: result.triggerId ?? null,
        status: result.status ?? null,
        workItemId: result.workItemId ?? null,
        workflowInstanceId: result.workflowInstanceId ?? null,
      }))
  const workItems = workItemIds.flatMap(id => {
    const item = itemMap.get(id)
    if (!item) return []
    return [{
      id: item.id,
      workCode: item.workCode,
      title: item.title,
      status: item.status,
      routingMode: item.routingMode,
      routingState: item.routingState,
      routingPolicyId: item.routingPolicyId,
      targets: item.targets.map(target => ({
        id: target.id,
        targetCapabilityId: target.targetCapabilityId,
        childWorkflowTemplateId: target.childWorkflowTemplateId,
        childWorkflowInstanceId: target.childWorkflowInstanceId,
        workflowInstanceStatus: target.childWorkflowInstance?.status ?? null,
        workflowInstanceName: target.childWorkflowInstance?.name ?? null,
      })),
      events: item.events.map(event => ({
        id: event.id,
        eventType: event.eventType,
        createdAt: event.createdAt,
        payload: includeSensitive ? event.payload : null,
      })),
    }]
  })
  const workflowInstanceIds = [...new Set([
    ...stringArray(payload.workflowInstanceIds),
    ...triggerResults.flatMap(result => stringValue(result.workflowInstanceId) ? [stringValue(result.workflowInstanceId)!] : []),
    ...workItems.flatMap(item => item.targets.flatMap(target => target.childWorkflowInstanceId ? [target.childWorkflowInstanceId] : [])),
  ])]

  return {
    id: row.id,
    eventType: stringValue(payload.eventType) ?? stringValue(payload.eventTypeKey) ?? row.entityId,
    deliveryId: payload.deliveryId ?? null,
    capabilityId: payload.capabilityId ?? null,
    receivedAt: row.occurredAt,
    status: eventStatus(payload, Array.from(itemMap.values())),
    matchedTriggerIds: [...new Set([
      ...stringArray(payload.matchedTriggerIds),
      ...triggerResults.map(result => stringValue(result.triggerId)).filter((value): value is string => Boolean(value)),
    ])],
    triggerResults: safeTriggerResults,
    workItems,
    workItemIds,
    workflowInstanceIds,
    lastError: includeSensitive
      ? payload.lastError ?? triggerResults.find(result => result.error)?.error ?? null
      : (payload.lastError || triggerResults.some(result => result.error) ? 'An inbound trigger or routing error occurred; audit access is required for details.' : null),
    replaySourceEventId: payload.replaySourceEventId ?? null,
    replayedFromEventId: payload.replayedFromEventId ?? null,
    traceId: stringValue(payload.traceId) ?? stringValue(payload.trace_id) ?? triggerResults.map(result => stringValue(result.traceId)).find(Boolean) ?? null,
    rawPayload: includeSensitive ? payload.payload ?? null : null,
  }
}

workflowOperationsRouter.get('/summary', async (_req, res, next) => {
  try {
    if (!_req.user?.userId) throw new ForbiddenError('Authenticated user required for workflow operations.')
    const tenantId = tenantForOperations(_req)
    await assertWorkflowOperationsPermission(_req.user.userId, 'view', tenantId)
    const tenantWhere = tenantId ? { tenantId } : {}
    const instanceTenantWhere = tenantId ? { instance: { tenantId } } : {}
    const outboxTenantWhere = tenantId ? { outbox: { tenantId } } : {}
    const [
      inboundTotal,
      deadLetters,
      failedInbound,
      activeTriggers,
      activePolicies,
      llmConnections,
      llmRules,
      activeSubscriptions,
      failedDeliveries,
      queuedDeliveries,
      runnerPending,
    ] = await Promise.all([
      prisma.eventLog.count({ where: { eventType: { in: [...INBOUND_EVENT_TYPES] }, ...tenantWhere } }),
      prisma.eventLog.count({ where: { eventType: 'WorkflowInboundEventDeadLettered', ...tenantWhere } }),
      prisma.eventLog.count({ where: { eventType: 'WorkflowInboundEventFailed', ...tenantWhere } }),
      prisma.workItemTrigger.count({ where: { isActive: true, ...tenantWhere } }),
      prisma.workItemRoutingPolicy.count({ where: { isActive: true, ...tenantWhere } }),
      prisma.llmConnection.count({ where: { enabled: true, ...tenantWhere } }),
      prisma.llmRouting.count({ where: { enabled: true, ...tenantWhere } }),
      prisma.eventSubscription.count({ where: { isActive: true, ...tenantWhere } }),
      prisma.eventDelivery.count({ where: { status: 'failed', ...outboxTenantWhere } }),
      prisma.eventDelivery.count({ where: { status: 'queued', ...outboxTenantWhere } }),
      prisma.pendingExecution.count({ where: { completedAt: null, ...instanceTenantWhere } }),
    ])
    res.json({
      inbound: { total: inboundTotal, deadLetters, failed: failedInbound },
      routing: { activeTriggers, activePolicies },
      llm: { connections: llmConnections, rules: llmRules },
      eventBus: { activeSubscriptions, failedDeliveries, queuedDeliveries },
      runners: { pending: runnerPending },
      readiness: [
        {
          key: 'event-trigger',
          status: activeTriggers > 0 ? 'ready' : 'blocked',
          message: activeTriggers > 0 ? `${activeTriggers} active triggers` : 'Create an EVENT or WEBHOOK trigger.',
          fixRoute: '/workflows/control-plane?tab=event-intake',
        },
        {
          key: 'routing-policy',
          status: activePolicies > 0 ? 'ready' : 'blocked',
          message: activePolicies > 0 ? `${activePolicies} active routing policies` : 'Create an active routing policy for auto-start.',
          fixRoute: '/workflows/triggers',
        },
        {
          key: 'llm-alias',
          status: llmConnections > 0 || llmRules > 0 ? 'ready' : 'warning',
          message: llmConnections > 0 ? `${llmConnections} LLM aliases configured` : 'Add a WorkGraph LLM alias or use catalog defaults.',
          fixRoute: '/workflows/control-plane?tab=llm-routing',
        },
        {
          key: 'event-subscriber',
          status: activeSubscriptions > 0 ? 'ready' : 'warning',
          message: activeSubscriptions > 0 ? `${activeSubscriptions} event subscribers` : 'Add an event-bus subscriber for external callbacks.',
          fixRoute: '/workflows/control-plane?tab=event-bus',
        },
        {
          key: 'deliveries',
          status: failedDeliveries === 0 ? 'ready' : 'blocked',
          message: failedDeliveries === 0 ? 'No failed deliveries' : `${failedDeliveries} delivery failures need retry.`,
          fixRoute: '/workflows/control-plane?tab=event-bus',
        },
        {
          key: 'runner-queues',
          status: runnerPending === 0 ? 'ready' : 'warning',
          message: runnerPending === 0 ? 'No pending runner backlog' : `${runnerPending} client/edge/external executions are waiting.`,
          fixCommand: 'Deploy a CLIENT, EDGE, or EXTERNAL runner, or change the node execution location to Server.',
        },
      ],
    })
  } catch (err) { next(err) }
})

workflowOperationsRouter.get('/events', async (req, res, next) => {
  try {
    if (!req.user?.userId) throw new ForbiddenError('Authenticated user required for workflow operations.')
    const tenantId = tenantForOperations(req)
    await assertWorkflowOperationsPermission(req.user.userId, 'view', tenantId)
    const includeSensitive = await canViewWorkflowOperations(req.user.userId, 'audit_view', tenantId)
    const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 75)))
    const status = stringValue(req.query.status)
    const rows = await prisma.eventLog.findMany({
      where: { eventType: { in: [...INBOUND_EVENT_TYPES] }, ...(tenantId ? { tenantId } : {}) },
      orderBy: { occurredAt: 'desc' },
      take: limit,
    })
    const items = await Promise.all(rows.map(row => serializeInboundEvent(row, tenantId, includeSensitive)))
    res.json({ items: status ? items.filter(item => item.status === status) : items, total: items.length })
  } catch (err) { next(err) }
})

const replaySchema = z.object({
  deliveryId: z.string().max(200).optional(),
  force: z.boolean().default(false),
})

workflowOperationsRouter.post('/events/:id/replay', async (req, res, next) => {
  try {
    if (!req.user?.userId) throw new ForbiddenError('Authenticated user required for workflow operations.')
    const tenantId = tenantForOperations(req)
    await assertWorkflowOperationsPermission(req.user.userId, 'replay', tenantId)
    const body = replaySchema.parse(req.body ?? {})
    const row = await prisma.eventLog.findFirst({ where: { id: req.params.id, ...(tenantId ? { tenantId } : {}) } })
    if (!row || !INBOUND_EVENT_TYPES.includes(row.eventType as (typeof INBOUND_EVENT_TYPES)[number])) {
      throw new NotFoundError('WorkflowInboundEvent', req.params.id)
    }
    const source = asRecord(row.payload)
    if (source.replaySourceEventId) {
      throw new ConflictError('Replay records cannot be replayed again; replay the original source event.')
    }
    const eventType = stringValue(source.eventType) ?? stringValue(source.eventTypeKey)
    const payload = asRecord(source.payload)
    if (!eventType) throw new ValidationError('Stored inbound event does not include eventType/eventTypeKey')

    if (!body.force) {
      const recentReplays = await prisma.eventLog.findMany({
        where: { eventType: 'WorkflowInboundEventReplayed' },
        orderBy: { occurredAt: 'desc' },
        take: 200,
      })
      const replayCandidate = recentReplays.find(candidate => {
        const candidatePayload = asRecord(candidate.payload)
        return candidatePayload.replaySourceEventId === row.id
      })
      if (replayCandidate) {
        const replayStatus = (await serializeInboundEvent(replayCandidate, tenantId)).status
        if (['routed', 'running', 'completed'].includes(replayStatus)) {
          throw new ConflictError(`Event already has an active replay (${replayCandidate.id}, status ${replayStatus}); pass force=true only after reviewing its WorkItem/run state.`)
        }
      }
    }

    const replayDeliveryId = body.deliveryId ?? `replay:${row.id}:${Date.now()}`
    const traceId = traceIdFromParts(['event-replay', row.id, Date.now()])
    const results = await fanOutToWorkItemTriggersDetailed({
      eventTypeKey: eventType,
      payload,
      deliveryId: replayDeliveryId,
      capabilityId: stringValue(source.capabilityId),
      sourceEventTypeKey: eventType,
      traceId,
    })
    const workItemIds = [...new Set(results.flatMap(result => result.workItemId ? [result.workItemId] : []))]
    const replayEventId = await logEvent('WorkflowInboundEventReplayed', 'WorkflowInboundEvent', replayDeliveryId, req.user?.userId, {
      status: results.length === 0 ? 'dead_lettered' : results.some(result => result.status === 'failed') ? 'failed' : results.some(result => result.workflowInstanceId) ? 'running' : 'routed',
      eventType,
      eventTypeKey: eventType,
      deliveryId: replayDeliveryId,
      capabilityId: source.capabilityId ?? null,
      payload,
      workItemIds,
      triggerResults: results,
      matchedTriggerIds: results.map(result => result.triggerId),
      workflowInstanceIds: [...new Set(results.flatMap(result => result.workflowInstanceId ? [result.workflowInstanceId] : []))],
      replaySourceEventId: row.id,
      lastError: results.find(result => result.error)?.error ?? (results.length === 0 ? 'No active WorkItem EVENT trigger matched this replay.' : null),
      traceId,
      trace_id: traceId,
    })
    res.status(202).json({ replayEventId, sourceEventId: row.id, eventType, deliveryId: replayDeliveryId, traceId, workItemIds, triggerResults: results })
  } catch (err) { next(err) }
})

workflowOperationsRouter.get('/deliveries', async (req, res, next) => {
  try {
    if (!req.user?.userId) throw new ForbiddenError('Authenticated user required for workflow operations.')
    const tenantId = tenantForOperations(req)
    await assertWorkflowOperationsPermission(req.user.userId, 'view', tenantId)
    const includeSensitive = await canViewWorkflowOperations(req.user.userId, 'audit_view', tenantId)
    const status = stringValue(req.query.status)
    const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 100)))
    const rows = await prisma.eventDelivery.findMany({
      where: { ...(status ? { status } : {}), ...(tenantId ? { outbox: { tenantId } } : {}) },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        subscription: { select: { id: true, subscriberId: true, eventPattern: true, targetUrl: true, isActive: true } },
        outbox: { select: { id: true, eventName: true, sourceService: true, traceId: true, subjectKind: true, subjectId: true, status: true, emittedAt: true, envelope: true } },
      },
    })
    res.json({
      items: rows.map(row => ({
        id: row.id,
        status: row.status,
        attempts: row.attempts,
        lastAttemptAt: row.lastAttemptAt,
        lastError: includeSensitive
          ? row.lastError
          : (row.lastError ? 'Delivery failed; audit access is required for error details.' : null),
        deliveredAt: row.deliveredAt,
        responseStatus: row.responseStatus,
        createdAt: row.createdAt,
        subscription: {
          id: row.subscription.id,
          subscriberId: row.subscription.subscriberId,
          eventPattern: row.subscription.eventPattern,
          targetUrl: includeSensitive ? row.subscription.targetUrl : null,
          isActive: row.subscription.isActive,
        },
        outbox: {
          id: row.outbox.id,
          eventName: row.outbox.eventName,
          sourceService: row.outbox.sourceService,
          traceId: row.outbox.traceId,
          subjectKind: row.outbox.subjectKind,
          subjectId: row.outbox.subjectId,
          status: row.outbox.status,
          emittedAt: row.outbox.emittedAt,
          envelope: includeSensitive ? row.outbox.envelope : null,
        },
      })),
      total: rows.length,
    })
  } catch (err) { next(err) }
})

workflowOperationsRouter.post('/deliveries/:id/retry', async (req, res, next) => {
  try {
    if (!req.user?.userId) throw new ForbiddenError('Authenticated user required for workflow operations.')
    const tenantId = tenantForOperations(req)
    await assertWorkflowOperationsPermission(req.user.userId, 'retry_delivery', tenantId)
    const row = await prisma.eventDelivery.findFirst({
      where: { id: req.params.id, ...(tenantId ? { outbox: { tenantId } } : {}) },
      include: { outbox: true },
    })
    if (!row) throw new NotFoundError('EventDelivery', req.params.id)
    if (row.status === 'sent') throw new ConflictError('Sent deliveries do not need retry.')
    const [delivery] = await prisma.$transaction([
      prisma.eventDelivery.update({
        where: { id: row.id },
        data: { status: 'queued', attempts: 0, lastError: null, lastAttemptAt: null, deliveredAt: null, responseStatus: null },
      }),
      prisma.eventOutbox.update({
        where: { id: row.outboxId },
        data: { status: 'pending', lastError: null },
      }),
    ])
    await logEvent('WorkflowEventDeliveryRetryQueued', 'EventDelivery', row.id, req.user?.userId, {
      outboxId: row.outboxId,
      eventName: row.outbox.eventName,
      subscriptionId: row.subscriptionId,
    })
    res.status(202).json(delivery)
  } catch (err) { next(err) }
})

workflowOperationsRouter.get('/runners', async (_req, res, next) => {
  try {
    if (!_req.user?.userId) throw new ForbiddenError('Authenticated user required for workflow operations.')
    const tenantId = tenantForOperations(_req)
    await assertWorkflowOperationsPermission(_req.user.userId, 'view', tenantId)
    const includeSensitive = await canViewWorkflowOperations(_req.user.userId, 'audit_view', tenantId)
    const instanceTenantWhere = tenantId ? { instance: { tenantId } } : {}
    const now = new Date()
    const queues = await Promise.all(EXECUTION_LOCATIONS.map(async location => {
      const [pending, claimed, expired, failed, completed] = await Promise.all([
        prisma.pendingExecution.count({ where: { location, ...instanceTenantWhere, completedAt: null, claimedAt: null, expiresAt: { gt: now } } }),
        prisma.pendingExecution.count({ where: { location, ...instanceTenantWhere, completedAt: null, claimedAt: { not: null }, expiresAt: { gt: now } } }),
        prisma.pendingExecution.count({ where: { location, ...instanceTenantWhere, completedAt: null, expiresAt: { lte: now } } }),
        prisma.pendingExecution.count({ where: { location, ...instanceTenantWhere, completedAt: null, error: { not: null } } }),
        prisma.pendingExecution.count({ where: { location, ...instanceTenantWhere, completedAt: { not: null } } }),
      ])
      const latest = await prisma.pendingExecution.findMany({
        where: { location, ...instanceTenantWhere },
        orderBy: { createdAt: 'desc' },
        take: 10,
        include: { instance: { select: { id: true, name: true, status: true } }, node: { select: { id: true, label: true, nodeType: true } } },
      })
      return {
        location,
        pending,
        claimed,
        expired,
        failed,
        completed,
        latest: latest.map(item => ({
          id: item.id,
          instanceId: item.instanceId,
          nodeId: item.nodeId,
          attempt: item.attempt,
          location: item.location,
          claimedAt: item.claimedAt,
          claimedBy: item.claimedBy,
          completedAt: item.completedAt,
          error: includeSensitive ? item.error : null,
          expiresAt: item.expiresAt,
          createdAt: item.createdAt,
          instance: item.instance,
          node: item.node,
        })),
      }
    }))
    res.json({ items: queues, total: queues.length })
  } catch (err) { next(err) }
})

const runnerRequeueSchema = z.object({
  expiresInSeconds: z.number().int().min(60).max(86_400).default(900),
})

workflowOperationsRouter.post('/runners/:id/requeue', async (req, res, next) => {
  try {
    if (!req.user?.userId) throw new ForbiddenError('Authenticated user required for workflow operations.')
    const tenantId = tenantForOperations(req)
    await assertWorkflowOperationsPermission(req.user.userId, 'manage_runners', tenantId)
    const includeSensitive = await canViewWorkflowOperations(req.user.userId, 'audit_view', tenantId)
    const body = runnerRequeueSchema.parse(req.body ?? {})
    const row = await prisma.pendingExecution.findFirst({
      where: { id: req.params.id, ...(tenantId ? { instance: { tenantId } } : {}) },
    })
    if (!row) throw new NotFoundError('PendingExecution', req.params.id)
    if (row.completedAt) throw new ConflictError('Completed executions cannot be requeued.')

    const updated = await prisma.pendingExecution.update({
      where: { id: row.id },
      data: {
        claimToken: randomUUID(),
        claimedAt: null,
        claimedBy: null,
        error: null,
        expiresAt: new Date(Date.now() + body.expiresInSeconds * 1000),
      },
      include: {
        instance: { select: { id: true, name: true, status: true } },
        node: { select: { id: true, label: true, nodeType: true } },
      },
    })
    await logEvent('WorkflowRunnerExecutionRequeued', 'PendingExecution', row.id, req.user?.userId, {
      instanceId: row.instanceId,
      nodeId: row.nodeId,
      location: row.location,
      previousClaimedBy: row.claimedBy,
      expiresInSeconds: body.expiresInSeconds,
    })
    res.status(202).json({
      id: updated.id,
      instanceId: updated.instanceId,
      nodeId: updated.nodeId,
      attempt: updated.attempt,
      location: updated.location,
      claimedAt: updated.claimedAt,
      claimedBy: updated.claimedBy,
      completedAt: updated.completedAt,
      error: includeSensitive ? updated.error : null,
      expiresAt: updated.expiresAt,
      createdAt: updated.createdAt,
      instance: updated.instance,
      node: updated.node,
    })
  } catch (err) { next(err) }
})
