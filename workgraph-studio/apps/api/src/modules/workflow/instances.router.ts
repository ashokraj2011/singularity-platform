import { Router, type Request } from 'express'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { config } from '../../config'
import { prisma } from '../../lib/prisma'
import { resolveRuntimeTenantId } from '../../lib/runtime-tenant'
import { contextFabricServiceHeaders } from '../../lib/context-fabric/client'
import { validate } from '../../middleware/validate'
import { parsePagination, toPageResponse } from '../../lib/pagination'
import { NotFoundError, ValidationError } from '../../lib/errors'
import { mapLimit } from '../../lib/map-limit'
import { readUpstreamJsonBody, upstreamSnippet } from '../../lib/upstream-json'
import { logEvent, createReceipt, publishOutbox } from '../../lib/audit'
import { advance, pauseInstance, resumeInstance, cancelInstance, failNode, restartNode, forceCompleteNode, startInstance, startAwaitingNode, triggerEventStartNodes, provideCreateBranchInput } from './runtime/WorkflowRuntime'
import { promoteWorkbenchToTables } from './lib/promote-workbench'
import { evaluateEdge } from './runtime/EdgeEvaluator'
import { assertTemplatePermission, assertInstancePermission } from '../../lib/permissions/workflowTemplate'
import { getWorkflowBudgetOverview } from './runtime/budget'
import { buildCopilotResultsVerdict } from './runtime/copilot-results-verify'
import { analyzeWorkflowInstance } from './formal-verification'
import { copilotComposeTimeoutMs } from './copilot-compose-config'
import {
  assertPendingExecutionTenant,
  assertWorkflowInstanceTenant,
  resolveTenantFromRequest,
  resolveTenantFromContext,
  tenantIdForCreate,
  tenantIsolationStrict,
} from '../../lib/tenant-isolation'
import { withTenantDbTransaction } from '../../lib/tenant-db-context'

export const workflowInstancesRouter: Router = Router()

workflowInstancesRouter.post('/:id/formal-analysis', async (req, res, next) => {
  try {
    await assertWorkflowInstanceTenant(req, req.params.id)
    await assertInstancePermission(req.user!.userId, req.params.id, 'view')
    const analysis = await analyzeWorkflowInstance(req.params.id, req.user!.userId, undefined, resolveTenantFromRequest(req))
    res.json({ data: analysis })
  } catch (err) {
    next(err)
  }
})

const createInstanceSchema = z.object({
  templateId: z.string().uuid().optional(),
  initiativeId: z.string().uuid().optional(),
  tenantId: z.string().min(1).optional(),
  tenant_id: z.string().min(1).optional(),
  name: z.string().min(1),
  // Optional: per-instance overrides for INPUT-scoped template variables.
  vars: z.record(z.unknown()).optional(),
  // Optional: per-instance overrides for INSTANCE-scoped team variables.
  // GLOBAL-scoped team variables ignore this; the team default is always used.
  globals: z.record(z.unknown()).optional(),
  // Optional: run-level budget override. Overrides may lower template limits;
  // raising limits is blocked unless a budget approval flow grants more later.
  budgetOverride: z.record(z.unknown()).optional(),
})

const createNodeSchema = z.object({
  phaseId: z.string().uuid().optional(),
  nodeType: z.enum([
    'START', 'END',
    'HUMAN_TASK', 'AGENT_TASK', 'DIRECT_LLM_TASK', 'WORKBENCH_TASK',
    'APPROVAL', 'DECISION_GATE', 'CONSUMABLE_CREATION', 'TOOL_REQUEST',
    'CREATE_BRANCH', 'GIT_PUSH', 'RAISE_PR', 'POLICY_CHECK', 'EVAL_GATE',
    'VERIFIER', 'GOVERNANCE_GATE', 'TIMER', 'SIGNAL_WAIT', 'SIGNAL_EMIT',
    'CALL_WORKFLOW', 'WORK_ITEM', 'FOREACH', 'PARALLEL_FORK', 'PARALLEL_JOIN',
    'INCLUSIVE_GATEWAY', 'EVENT_GATEWAY', 'CUSTOM', 'DATA_SINK', 'SET_CONTEXT',
    'ERROR_CATCH', 'RUN_PYTHON', 'EVENT_EMIT',
  ]),
  label: z.string().min(1),
  config: z.record(z.unknown()).default({}),
  positionX: z.number().default(0),
  positionY: z.number().default(0),
})

const updateNodeSchema = z.object({
  label: z.string().min(1).optional(),
  config: z.record(z.unknown()).optional(),
  executionLocation: z.enum(['SERVER', 'CLIENT', 'EDGE', 'EXTERNAL']).optional(),
  positionX: z.number().optional(),
  positionY: z.number().optional(),
  phaseId: z.string().uuid().nullable().optional(),
})

const createEdgeSchema = z.object({
  sourceNodeId: z.string().uuid(),
  targetNodeId: z.string().uuid(),
  edgeType: z.enum(['SEQUENTIAL', 'CONDITIONAL', 'PARALLEL_SPLIT', 'PARALLEL_JOIN', 'ERROR_BOUNDARY']).default('SEQUENTIAL'),
  condition: z.record(z.unknown()).optional(),
  label: z.string().optional(),
})

const failNodeSchema = z.object({
  message: z.string().min(1),
  code: z.string().optional(),
  details: z.record(z.unknown()).optional(),
})

type WorkflowJsonRead<T> = {
  data?: T
  error?: string
  raw?: string
}

async function readWorkflowJsonResponse<T>(response: globalThis.Response, source: string): Promise<WorkflowJsonRead<T>> {
  const body = await readUpstreamJsonBody(response)
  if (!body.raw.trim()) return {}
  if (body.parseError) {
    return { error: `${source} returned invalid JSON: ${body.parseError}`, raw: upstreamSnippet(body.raw, 500) }
  }
  if (body.data && typeof body.data === 'object' && !Array.isArray(body.data)) {
    return { data: body.data as T }
  }
  return { error: `${source} returned a non-object JSON body`, raw: upstreamSnippet(body.raw, 500) }
}

// M98 — Operator manual completion. A comment is mandatory so the audit trail
// always records WHY the node was forced complete (e.g. "pushed by hand after
// the GitHub token expired").
const forceCompleteSchema = z.object({
  comment: z.string().min(1).max(1000),
  output: z.record(z.unknown()).optional(),
})

const createPhaseSchema = z.object({
  name: z.string().min(1),
  displayOrder: z.number().int().default(0),
  color: z.string().optional(),
})

const advanceSchema = z.object({
  completedNodeId: z.string().uuid(),
  output: z.record(z.unknown()).default({}),
})

const copilotResultArtifactSchema = z.object({
  path: z.string().min(1).max(1000),
  sha256: z.string().max(128).optional(),
  bytes: z.number().int().nonnegative().optional(),
  mimeType: z.string().max(160).optional(),
  contentBase64: z.string().max(1_500_000).optional(),
  stageKey: z.string().max(160).optional(),
  nodeId: z.string().uuid().optional(),
  truncated: z.boolean().optional(),
})

const copilotStageResultSchema = z.object({
  key: z.string().max(160).optional(),
  nodeId: z.string().uuid().optional(),
  label: z.string().max(300).optional(),
  status: z.string().max(80).optional(),
  startedAt: z.string().max(80).optional(),
  completedAt: z.string().max(80).optional(),
  durationMs: z.number().int().nonnegative().optional(),
  exitCode: z.number().int().optional(),
  logPath: z.string().max(1000).optional(),
  changedFiles: z.array(z.string().max(1000)).max(200).optional(),
  metrics: z.record(z.unknown()).optional(),
})

const copilotResultsSchema = z.object({
  source: z.string().max(120).default('copilot-cli-export'),
  status: z.string().max(80).default('completed'),
  startedAt: z.string().max(80).optional(),
  completedAt: z.string().max(80).optional(),
  workflow: z.record(z.unknown()).optional(),
  git: z.record(z.unknown()).optional(),
  metrics: z.record(z.unknown()).default({}),
  stages: z.array(copilotStageResultSchema).max(80).default([]),
  artifacts: z.array(copilotResultArtifactSchema).max(80).default([]),
})

const cancelSchema = z.object({
  reason: z.string().max(500).optional(),
})

function instanceRouteAction(req: Request): 'view' | 'edit' | 'start' {
  const path = req.originalUrl.split('?')[0] ?? ''
  if (req.method === 'GET' || req.method === 'HEAD') return 'view'
  if (req.method === 'POST' && path.endsWith('/start')) return 'start'
  if (req.method === 'POST' && path.endsWith('/test-branches')) return 'view'
  return 'edit'
}

workflowInstancesRouter.use('/:id', async (req, _res, next) => {
  try {
    if (req.params.id === 'pending-executions') {
      next()
      return
    }
    await assertWorkflowInstanceTenant(req, req.params.id)
    await assertInstancePermission(req.user!.userId, req.params.id, instanceRouteAction(req))
    next()
  } catch (err) {
    next(err)
  }
})

workflowInstancesRouter.delete('/:id', async (req, res, next) => {
  try {
    const id = req.params.id as string
    await withTenantDbTransaction(prisma, async () => {
      await assertInstancePermission(req.user!.userId, id, 'edit')
      // Runtime instances carry audit/mutation rows, budgets, WorkItem links,
      // documents, and execution traces. Treat DELETE as a soft delete so old UI
      // delete actions hide the run without corrupting the audit trail.
      const instance = await prisma.workflowInstance.update({
        where: { id },
        data: { archivedAt: new Date() },
      })
      await logEvent('InstanceArchived', 'WorkflowInstance', instance.id, req.user!.userId, { via: 'delete' })
    })
    res.status(204).end()
  } catch (err) {
    next(err)
  }
})

workflowInstancesRouter.post('/', validate(createInstanceSchema), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof createInstanceSchema>

    // When linked to a template, this is starting a run — clone the design.
    if (body.templateId) {
      await assertTemplatePermission(req.user!.userId, body.templateId, 'start')
      throw new ValidationError('Workflow runs must start from a WorkItem. Claim or create a WorkItem, then attach the workflow from the WorkItem queue.')
    }

    // No templateId — create a blank instance (rare; mostly used for tests).
    const tenantId = body.tenantId ?? body.tenant_id ?? resolveTenantFromRequest(req)
    if (tenantIsolationStrict() && !tenantId) {
      throw new ValidationError('TENANT_ISOLATION_MODE=strict requires tenantId/tenant_id or X-Tenant-Id when creating a workflow instance')
    }
    const { vars: _ignoreVars, globals: _ignoreGlobals, tenantId: _tenantId, tenant_id: _tenant_id, ...persistable } = body
    const context: Record<string, unknown> = tenantId ? { tenantId } : {}
    const instance = await withTenantDbTransaction(prisma, async () => {
      const created = await prisma.workflowInstance.create({
        data: {
          ...persistable,
          tenantId,
          context: context as Prisma.InputJsonValue,
          createdById: req.user!.userId,
        },
        include: { phases: true, nodes: true, edges: true },
      })
      await logEvent('WorkflowStarted', 'WorkflowInstance', created.id, req.user!.userId)
      await publishOutbox('WorkflowInstance', created.id, 'WorkflowStarted', { instanceId: created.id })
      return created
    }, tenantId)
    res.status(201).json(instance)
  } catch (err) {
    next(err)
  }
})

workflowInstancesRouter.get('/', async (req, res, next) => {
  try {
    const pg = parsePagination(req.query as Record<string, unknown>)
    const { initiativeId, capabilityId } = req.query
    const tenantId = resolveTenantFromRequest(req)
    if (tenantIsolationStrict() && !tenantId) {
      throw new ValidationError('TENANT_ISOLATION_MODE=strict requires X-Tenant-Id or tenant_id when listing workflow instances')
    }
    const where: Prisma.WorkflowInstanceWhereInput = {
      ...(tenantIsolationStrict() ? { tenantId } : {}),
      ...(initiativeId ? { initiativeId: String(initiativeId) } : {}),
      ...(typeof capabilityId === 'string' && capabilityId.trim()
        ? { template: { capabilityId: capabilityId.trim() } }
        : {}),
    }
    const [instances, total] = await withTenantDbTransaction(prisma, () => Promise.all([
        prisma.workflowInstance.findMany({ where, skip: pg.skip, take: pg.take, orderBy: { createdAt: 'desc' } }),
        prisma.workflowInstance.count({ where }),
      ]),
      tenantId,
    )
    res.json(toPageResponse(instances, total, pg))
  } catch (err) {
    next(err)
  }
})

workflowInstancesRouter.get('/:id', async (req, res, next) => {
  try {
    const instance = await withTenantDbTransaction(prisma, () => prisma.workflowInstance.findUnique({
        where: { id: req.params.id },
        include: { phases: { orderBy: { displayOrder: 'asc' } }, nodes: true, edges: true },
      }),
      resolveTenantFromRequest(req),
    )
    if (!instance) throw new NotFoundError('WorkflowInstance', req.params.id)
    // Surface the whole-workflow Copilot opt-in (workflow.metadata.usesCopilot) so the
    // run viewer can show the COPILOT indicator without a second round-trip.
    let usesCopilot = false
    if (instance.templateId) {
      const wf = await prisma.workflow.findUnique({ where: { id: instance.templateId }, select: { metadata: true } })
      const md = wf?.metadata
      usesCopilot = !!(md && typeof md === 'object' && !Array.isArray(md) && (md as Record<string, unknown>).usesCopilot === true)
    }
    res.json({ ...instance, usesCopilot })
  } catch (err) {
    next(err)
  }
})

workflowInstancesRouter.get('/:id/budget', async (req, res, next) => {
  try {
    await assertInstancePermission(req.user!.userId, req.params.id, 'view')
    const budget = await getWorkflowBudgetOverview(req.params.id, resolveTenantFromRequest(req))
    res.json(budget)
  } catch (err) {
    next(err)
  }
})

// M101 (Epic→child) — B7: artifact roll-up. Returns the consumables this
// instance produced and, with ?include=children, the consumables produced by
// the child capability runs it delegated to (WorkItems spawned by its
// WORK_ITEM nodes → their targets' childWorkflowInstanceId). Lets an Epic
// surface every impacted child's work + impact verdict in one place, with
// provenance (workItemCode / sourceWorkflowNodeId / targetCapabilityId).
workflowInstancesRouter.get('/:id/artifacts', async (req, res, next) => {
  try {
    const instanceId = req.params.id
    await assertInstancePermission(req.user!.userId, instanceId, 'view')
    const instance = await withTenantDbTransaction(prisma, (tx) => tx.workflowInstance.findUnique({ where: { id: instanceId }, select: { id: true } }), resolveTenantFromRequest(req))
    if (!instance) throw new NotFoundError('WorkflowInstance', instanceId)

    const consumableSelect = { id: true, name: true, status: true, currentVersion: true, nodeId: true, instanceId: true } as const
    const own = await withTenantDbTransaction(prisma, (tx) => tx.consumable.findMany({ where: { instanceId }, select: consumableSelect, orderBy: { updatedAt: 'desc' } }), resolveTenantFromRequest(req))

    const includeChildren = req.query.include === 'children' || req.query.children === 'true' || req.query.children === '1'
    const children: Array<Record<string, unknown>> = []
    if (includeChildren) {
      const workItems = await prisma.workItem.findMany({
        where: { sourceWorkflowInstanceId: instanceId },
        select: {
          workCode: true, workItemTypeKey: true, sourceWorkflowNodeId: true,
          targets: { select: { targetCapabilityId: true, status: true, childWorkflowInstanceId: true, output: true } },
        },
      })
      const childInstanceIds = workItems.flatMap(w => w.targets.map(t => t.childWorkflowInstanceId).filter((x): x is string => Boolean(x)))
      const childConsumables = childInstanceIds.length
        ? await withTenantDbTransaction(prisma, (tx) => tx.consumable.findMany({ where: { instanceId: { in: childInstanceIds } }, select: consumableSelect, orderBy: { updatedAt: 'desc' } }), resolveTenantFromRequest(req))
        : []
      for (const w of workItems) {
        for (const t of w.targets) {
          const output = (t.output && typeof t.output === 'object' && !Array.isArray(t.output)) ? t.output as Record<string, unknown> : {}
          children.push({
            workItemCode: w.workCode,
            workItemTypeKey: w.workItemTypeKey,
            sourceWorkflowNodeId: w.sourceWorkflowNodeId,
            targetCapabilityId: t.targetCapabilityId,
            childWorkflowInstanceId: t.childWorkflowInstanceId,
            targetStatus: t.status,
            impactVerdict: output.impactVerdict ?? null,
            consumables: t.childWorkflowInstanceId ? childConsumables.filter(c => c.instanceId === t.childWorkflowInstanceId) : [],
          })
        }
      }
    }
    res.json({ instanceId, own, includeChildren, childCount: children.length, children })
  } catch (err) {
    next(err)
  }
})

workflowInstancesRouter.post('/:id/phases', validate(createPhaseSchema), async (req, res, next) => {
  try {
    const id = req.params.id as string
    const phase = await withTenantDbTransaction(prisma, (tx) => tx.workflowPhase.create({
      data: { instanceId: id, ...req.body },
    }), resolveTenantFromRequest(req))
    await logEvent('PhaseAdded', 'WorkflowPhase', phase.id, req.user!.userId, { instanceId: id })
    await withTenantDbTransaction(prisma, (tx) => tx.workflowMutation.create({
      data: {
        instanceId: id,
        mutationType: 'PHASE_ADDED',
        afterState: { phaseId: phase.id, name: phase.name },
        performedById: req.user!.userId,
      },
    }), resolveTenantFromRequest(req))
    await publishOutbox('WorkflowInstance', id, 'PhaseAdded', { phaseId: phase.id })
    res.status(201).json(phase)
  } catch (err) {
    next(err)
  }
})

workflowInstancesRouter.get('/:id/nodes', async (req, res, next) => {
  try {
    const nodes = await withTenantDbTransaction(prisma, (tx) => tx.workflowNode.findMany({
      where: { instanceId: req.params.id },
      orderBy: { createdAt: 'asc' },
    }), resolveTenantFromRequest(req))
    res.json(nodes)
  } catch (err) {
    next(err)
  }
})

// Single-node fetch used by the runtime detail page to pull formSections
// without re-downloading the whole graph.
workflowInstancesRouter.get('/:id/nodes/:nodeId', async (req, res, next) => {
  try {
    const node = await withTenantDbTransaction(prisma, (tx) => tx.workflowNode.findFirst({
      where: { id: req.params.nodeId as string, instanceId: req.params.id as string },
    }), resolveTenantFromRequest(req))
    if (!node) {
      res.status(404).json({ error: 'Node not found' })
      return
    }
    res.json(node)
  } catch (err) { next(err) }
})

workflowInstancesRouter.post('/:id/nodes', validate(createNodeSchema), async (req, res, next) => {
  try {
    const id = req.params.id as string
    const node = await withTenantDbTransaction(prisma, (tx) => tx.workflowNode.create({
      data: { instanceId: id, ...req.body },
    }), resolveTenantFromRequest(req))
    await logEvent('NodeAdded', 'WorkflowNode', node.id, req.user!.userId, { instanceId: id })
    await withTenantDbTransaction(prisma, (tx) => tx.workflowMutation.create({
      data: {
        instanceId: id,
        nodeId: node.id,
        mutationType: 'NODE_ADDED',
        afterState: { nodeType: node.nodeType, label: node.label },
        performedById: req.user!.userId,
      },
    }), resolveTenantFromRequest(req))
    res.status(201).json(node)
  } catch (err) {
    next(err)
  }
})

workflowInstancesRouter.patch('/:id/nodes/:nodeId', validate(updateNodeSchema), async (req, res, next) => {
  try {
    const id = req.params.id as string
    const nodeId = req.params.nodeId as string
    const node = await withTenantDbTransaction(prisma, async (tx) => {
      const before = await tx.workflowNode.findUnique({ where: { id: nodeId } })
      const updated = await tx.workflowNode.update({
        where: { id: nodeId },
        data: req.body,
      })
      await tx.workflowMutation.create({
        data: {
          instanceId: id,
          nodeId: updated.id,
          mutationType: 'NODE_UPDATED',
          beforeState: before ? { config: before.config, positionX: before.positionX, positionY: before.positionY } : undefined,
          afterState: { config: updated.config, positionX: updated.positionX, positionY: updated.positionY },
          performedById: req.user!.userId,
        },
      })
      return updated
    }, resolveTenantFromRequest(req))
    // M84.s4 follow-up — when a WORKBENCH_TASK node's config changes,
    // re-promote the legacy loopDefinition JSON into the first-class
    // tables so the canvas + new API readers see the edits immediately
    // (instead of waiting for activateWorkbenchTask to fire on the
    // next workflow run). Best-effort: a promotion error here doesn't
    // fail the save, just leaves the canvas showing stale data until
    // the next refresh. The s2 service write-through already covers
    // the API-driven edit path; this covers the legacy-form-save path.
    //
    // M84.s6 — WORKBENCH_TABLES_AUTHORITATIVE=true skips the promote
    // because the operator opted into table-authoritative mode and
    // the form should no longer be writing JSON in the first place.
    if (node.nodeType === 'WORKBENCH_TASK'
        && process.env.WORKBENCH_TABLES_AUTHORITATIVE !== 'true') {
      try {
        await promoteWorkbenchToTables(prisma, node.id, node.config)
      } catch {
        // Silent — see comment above. The next workflow activation
        // will re-promote, and the canvas's lazy-promote on GET is
        // a third safety net.
      }
    }
    res.json(node)
  } catch (err) {
    next(err)
  }
})

workflowInstancesRouter.delete('/:id/nodes/:nodeId', async (req, res, next) => {
  try {
    await withTenantDbTransaction(prisma, async (tx) => {
      await tx.workflowNode.delete({ where: { id: req.params.nodeId } })
      await tx.workflowMutation.create({
        data: {
          instanceId: req.params.id,
          nodeId: req.params.nodeId,
          mutationType: 'NODE_REMOVED',
          performedById: req.user!.userId,
        },
      })
    }, resolveTenantFromRequest(req))
    res.status(204).end()
  } catch (err) {
    next(err)
  }
})

workflowInstancesRouter.get('/:id/edges', async (req, res, next) => {
  try {
    const edges = await withTenantDbTransaction(prisma, (tx) => tx.workflowEdge.findMany({ where: { instanceId: req.params.id } }), resolveTenantFromRequest(req))
    res.json(edges)
  } catch (err) {
    next(err)
  }
})

workflowInstancesRouter.post('/:id/edges', validate(createEdgeSchema), async (req, res, next) => {
  try {
    const edge = await withTenantDbTransaction(prisma, (tx) => tx.workflowEdge.create({
      data: { instanceId: req.params.id, ...req.body },
    }), resolveTenantFromRequest(req))
    res.status(201).json(edge)
  } catch (err) {
    next(err)
  }
})

const updateEdgeSchema = z.object({
  label: z.string().optional(),
  edgeType: z.enum(['SEQUENTIAL', 'CONDITIONAL', 'PARALLEL_SPLIT', 'PARALLEL_JOIN', 'ERROR_BOUNDARY']).optional(),
  condition: z.record(z.unknown()).nullable().optional(),
})

workflowInstancesRouter.patch('/:id/edges/:edgeId', validate(updateEdgeSchema), async (req, res, next) => {
  try {
    const edge = await withTenantDbTransaction(prisma, (tx) => tx.workflowEdge.update({
      where: { id: req.params.edgeId as string },
      data: req.body,
    }), resolveTenantFromRequest(req))
    res.json(edge)
  } catch (err) {
    next(err)
  }
})

workflowInstancesRouter.delete('/:id/edges/:edgeId', async (req, res, next) => {
  try {
    await withTenantDbTransaction(prisma, (tx) => tx.workflowEdge.delete({ where: { id: req.params.edgeId } }), resolveTenantFromRequest(req))
    res.status(204).end()
  } catch (err) {
    next(err)
  }
})

// Send a signal to advance any matching SIGNAL_WAIT nodes in this instance.
const signalSchema = z.object({
  payload: z.record(z.unknown()).default({}),
  correlationKey: z.string().optional(),
})
workflowInstancesRouter.post('/:id/signals/:name', validate(signalSchema), async (req, res, next) => {
  try {
    const id = req.params.id as string
    const signalName = req.params.name as string
    const { payload, correlationKey } = req.body as z.infer<typeof signalSchema>

    const candidates = await withTenantDbTransaction(prisma, (tx) => tx.workflowNode.findMany({
      where: { instanceId: id, nodeType: 'SIGNAL_WAIT', status: 'ACTIVE' },
    }), resolveTenantFromRequest(req))
    const matched = candidates.filter(n => {
      const cfg = (n.config ?? {}) as Record<string, unknown>
      const std = cfg.standard && typeof cfg.standard === 'object' && !Array.isArray(cfg.standard)
        ? cfg.standard as Record<string, unknown>
        : {}
      const nodeSignalName = cfg.signalName ?? std.signalName
      const nodeCorrelationKey = cfg.correlationKey ?? std.correlationKey
      if (nodeSignalName !== signalName) return false
      if (correlationKey && nodeCorrelationKey && nodeCorrelationKey !== correlationKey) return false
      return true
    })

    for (const node of matched) {
      await advance(id, node.id, { _signal: { name: signalName, payload, correlationKey } }, req.user!.userId)
    }
    // Event-based node start: the same signal also STARTS any ACTIVE node that was
    // gated with startMode=event + startSignal===name (see WorkflowRuntime gate). This
    // is how "attach a signal to a node" fires without a separate SIGNAL_WAIT node.
    const startedNodeIds = await triggerEventStartNodes(id, signalName, payload, req.user!.userId, resolveTenantFromRequest(req))
    res.json({ advancedNodeIds: matched.map(n => n.id), startedNodeIds, signalName })
  } catch (err) {
    next(err)
  }
})

// Manually start a node that is ACTIVE and awaiting a manual start (startMode=manual).
// The gate left it ACTIVE without executing; this triggers its executor. Idempotent —
// a second call after it already started returns { started:false } (409), never a
// duplicate run.
workflowInstancesRouter.post('/:id/nodes/:nodeId/start', async (req, res, next) => {
  try {
    const id = req.params.id as string
    const nodeId = req.params.nodeId as string
    const result = await startAwaitingNode(id, nodeId, req.user!.userId, resolveTenantFromRequest(req))
    if (!result.started) return res.status(409).json(result)
    res.json(result)
  } catch (err) {
    next(err)
  }
})

// Interactive CREATE_BRANCH: supply the operator's chosen base branch (+ local/clone
// dir) for a CREATE_BRANCH node that paused awaiting input (config.interactive). The
// choices are written to globals and the work branch is created from the chosen base,
// then the run advances. 409 if the node isn't awaiting input.
const createBranchInputSchema = z.object({
  baseBranch: z.string().max(200).optional(),
  cloneDir: z.string().max(200).optional(),
  sourceType: z.string().max(40).optional(),
  sourceUri: z.string().max(500).optional(),
}).default({})
workflowInstancesRouter.post('/:id/nodes/:nodeId/create-branch', validate(createBranchInputSchema), async (req, res, next) => {
  try {
    const id = req.params.id as string
    const nodeId = req.params.nodeId as string
    const body = req.body as z.infer<typeof createBranchInputSchema>
    const result = await provideCreateBranchInput(id, nodeId, body, req.user!.userId, resolveTenantFromRequest(req))
    if (!result.ok) return res.status(409).json(result)
    res.json(result)
  } catch (err) {
    next(err)
  }
})

workflowInstancesRouter.post('/:id/nodes/:nodeId/fail', validate(failNodeSchema), async (req, res, next) => {
  try {
    const id = req.params.id as string
    const nodeId = req.params.nodeId as string
    const failure = req.body as z.infer<typeof failNodeSchema>
    const result = await failNode(id, nodeId, failure, req.user!.userId, resolveTenantFromRequest(req))
    const node = await withTenantDbTransaction(prisma, (tx) => tx.workflowNode.findUnique({ where: { id: nodeId } }), resolveTenantFromRequest(req))
    res.json({ ...result, node })
  } catch (err) {
    next(err)
  }
})

workflowInstancesRouter.post('/:id/nodes/:nodeId/restart', async (req, res, next) => {
  try {
    const id = req.params.id as string
    const nodeId = req.params.nodeId as string
    await assertInstancePermission(req.user!.userId, id, 'edit')
    const result = await restartNode(id, nodeId, req.user!.userId, resolveTenantFromRequest(req))
    const [instance, node] = await withTenantDbTransaction(prisma, (tx) => Promise.all([
      tx.workflowInstance.findUnique({ where: { id } }),
      tx.workflowNode.findUnique({ where: { id: nodeId } }),
    ]), resolveTenantFromRequest(req))
    res.json({ ...result, instance, node })
  } catch (err) {
    next(err)
  }
})

// Refine: record reviewer feedback on the node, then restart it so the re-run
// addresses the note (AgentTaskExecutor appends _refineFeedback to the prompt).
// Used by the run-graph Chat "Send feedback".
workflowInstancesRouter.post('/:id/nodes/:nodeId/refine', async (req, res, next) => {
  try {
    const id = req.params.id as string
    const nodeId = req.params.nodeId as string
    const feedback = typeof req.body?.feedback === 'string' ? req.body.feedback.trim() : ''
    if (!feedback) return res.status(400).json({ error: 'feedback is required' })
    await assertInstancePermission(req.user!.userId, id, 'edit')
    const node = await withTenantDbTransaction(prisma, (tx) => tx.workflowNode.findFirst({ where: { id: nodeId, instanceId: id } }), resolveTenantFromRequest(req))
    if (!node) return res.status(404).json({ error: 'node not found in this run' })
    const config = { ...((node.config ?? {}) as Record<string, unknown>), _refineFeedback: feedback }
    await withTenantDbTransaction(prisma, (tx) => tx.workflowNode.update({ where: { id: nodeId }, data: { config: config as Prisma.InputJsonValue } }), resolveTenantFromRequest(req))
    const result = await restartNode(id, nodeId, req.user!.userId, resolveTenantFromRequest(req))
    res.json({ ...result, refined: true })
  } catch (err) {
    next(err)
  }
})

// Edit an agent phase's PROMPT at runtime, then re-run it. Sets config._promptOverride,
// which AgentTaskExecutor forwards to CF as run_context.prompt_override; CF's
// compose_copilot_prompt then returns it VERBATIM (skips composition — the operator
// edited the fully-composed prompt they saw). Used by the run-graph Prompt tab.
workflowInstancesRouter.post('/:id/nodes/:nodeId/prompt', async (req, res, next) => {
  try {
    const id = req.params.id as string
    const nodeId = req.params.nodeId as string
    const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : ''
    if (!prompt) return res.status(400).json({ error: 'prompt is required' })
    await assertInstancePermission(req.user!.userId, id, 'edit')
    const node = await withTenantDbTransaction(prisma, (tx) => tx.workflowNode.findFirst({ where: { id: nodeId, instanceId: id } }), resolveTenantFromRequest(req))
    if (!node) return res.status(404).json({ error: 'node not found in this run' })
    const config = { ...((node.config ?? {}) as Record<string, unknown>), _promptOverride: prompt }
    await withTenantDbTransaction(prisma, (tx) => tx.workflowNode.update({ where: { id: nodeId }, data: { config: config as Prisma.InputJsonValue } }), resolveTenantFromRequest(req))
    const result = await restartNode(id, nodeId, req.user!.userId, resolveTenantFromRequest(req))
    res.json({ ...result, promptOverridden: true })
  } catch (err) {
    next(err)
  }
})

// Answer Copilot's clarifying questions, then re-run the node with the answers
// injected. AgentTaskExecutor appends config._copilotAnswers to the prompt as
// confirmed decisions. Used by the run-graph "Questions" tab.
workflowInstancesRouter.post('/:id/nodes/:nodeId/answer-questions', async (req, res, next) => {
  try {
    const id = req.params.id as string
    const nodeId = req.params.nodeId as string
    const rawAnswers = Array.isArray(req.body?.answers) ? req.body.answers : []
    const formatted = rawAnswers
      .map((a: { question?: unknown; answer?: unknown }) => {
        const answer = typeof a?.answer === 'string' ? a.answer.trim() : ''
        if (!answer) return ''
        const q = typeof a?.question === 'string' && a.question.trim() ? a.question.trim() : 'Question'
        return `- ${q}: ${answer}`
      })
      .filter(Boolean)
      .join('\n')
    if (!formatted) return res.status(400).json({ error: 'at least one answer is required' })
    await assertInstancePermission(req.user!.userId, id, 'edit')
    const node = await withTenantDbTransaction(prisma, (tx) => tx.workflowNode.findFirst({ where: { id: nodeId, instanceId: id } }), resolveTenantFromRequest(req))
    if (!node) return res.status(404).json({ error: 'node not found in this run' })
    const config = { ...((node.config ?? {}) as Record<string, unknown>), _copilotAnswers: formatted }
    await withTenantDbTransaction(prisma, (tx) => tx.workflowNode.update({ where: { id: nodeId }, data: { config: config as Prisma.InputJsonValue } }), resolveTenantFromRequest(req))
    const result = await restartNode(id, nodeId, req.user!.userId, resolveTenantFromRequest(req))
    res.json({ ...result, answered: true })
  } catch (err) {
    next(err)
  }
})

type CopilotExportNode = {
  id: string
  label: string
  nodeType: string
  config: unknown
  createdAt: Date
  status?: string
  completedAt?: Date | null
}

type CopilotArtifactRef = { name: string; format?: string; path?: string; description?: string; template?: string }
type CopilotExportStage = {
  key: string
  nodeId: string
  label: string
  nodeType: string
  role: string
  prompt: string
  status?: string
  // The stage's IN/OUT document contract (declared artifact defs, paths interpolated)
  // so an external tool knows WHERE to read inputs from and WHAT/where/format to produce.
  reads: CopilotArtifactRef[]
  produces: CopilotArtifactRef[]
}

function yamlString(value: unknown): string {
  return JSON.stringify(value ?? '')
}

function yamlBlock(text: string, spaces: number): string {
  const indent = ' '.repeat(spaces)
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  // Literal block scalar: indent every line (blank lines included, so they stay
  // inside the block) and strip trailing whitespace per line — trailing spaces
  // on a literal-scalar line are a known YAML round-trip corruptor.
  return lines.length ? lines.map(line => `${indent}${line}`.replace(/[ \t]+$/, '')).join('\n') : `${indent}`
}

function slugForFile(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return slug.slice(0, 80) || 'workflow'
}

function topologicalCopilotNodes(nodes: CopilotExportNode[], edges: Array<{ sourceNodeId: string; targetNodeId: string }>): CopilotExportNode[] {
  const byId = new Map(nodes.map(node => [node.id, node]))
  const indegree = new Map(nodes.map(node => [node.id, 0]))
  const outgoing = new Map<string, string[]>()
  for (const edge of edges) {
    if (!byId.has(edge.sourceNodeId) || !byId.has(edge.targetNodeId)) continue
    indegree.set(edge.targetNodeId, (indegree.get(edge.targetNodeId) ?? 0) + 1)
    outgoing.set(edge.sourceNodeId, [...(outgoing.get(edge.sourceNodeId) ?? []), edge.targetNodeId])
  }
  const createdOrder = new Map(nodes.map((node, index) => [node.id, index]))
  const queue = nodes
    .filter(node => (indegree.get(node.id) ?? 0) === 0)
    .sort((a, b) => (createdOrder.get(a.id) ?? 0) - (createdOrder.get(b.id) ?? 0))
  const ordered: CopilotExportNode[] = []
  while (queue.length) {
    const node = queue.shift()!
    ordered.push(node)
    for (const nextId of outgoing.get(node.id) ?? []) {
      const next = byId.get(nextId)
      if (!next) continue
      indegree.set(nextId, Math.max(0, (indegree.get(nextId) ?? 0) - 1))
      if ((indegree.get(nextId) ?? 0) === 0) {
        queue.push(next)
        queue.sort((a, b) => (createdOrder.get(a.id) ?? 0) - (createdOrder.get(b.id) ?? 0))
      }
    }
  }
  const seen = new Set(ordered.map(node => node.id))
  return [...ordered, ...nodes.filter(node => !seen.has(node.id))]
}

function buildCopilotRunnerScript(workflow: Record<string, unknown>): string {
  // Finding #9 — embed the workflow as base64 and decode with json.loads at runtime.
  // A raw `WORKFLOW = ${JSON.stringify(...)}` is invalid Python whenever the JSON
  // contains null/true/false (workItem/startPhase/repository.url are commonly null),
  // raising NameError before any stage runs. base64 carries the JSON verbatim with no
  // Python-literal hazards.
  const workflowB64 = Buffer.from(JSON.stringify(workflow), 'utf-8').toString('base64')
  return `#!/usr/bin/env bash
set -euo pipefail

# Executes this exported Singularity workflow with GitHub Copilot CLI and posts
# artifacts/metrics back to Platform Web.
#
# Required:
#   export SINGULARITY_TOKEN="<your platform bearer token>"
# Optional:
#   export SINGULARITY_PLATFORM_URL="http://localhost:5180"
#   export COPILOT_BIN="copilot"
#   export WORK_DIR="/path/to/cloned/repo"
#   export COPILOT_ALLOW_ALL="1"
#   export COPILOT_CONTINUE_ON_ERROR="0"
#   export COPILOT_ARTIFACT_MAX_BYTES="262144"
#   export COPILOT_ARTIFACT_MAX_FILES="40"
#   export SINGULARITY_PUSH_RESULTS="1"   # opt-in: upload results+artifacts to the platform (default OFF)
#   export COPILOT_INCLUDE_UNTRACKED="1"  # opt-in: also upload NEW untracked files a stage created
# Privacy (finding #5): only files a stage actually changes (git status delta) are
# uploaded — never pre-existing dirty files. Paths matching secret patterns (.env,
# *.pem/*.key, *credential*, *secret*, .npmrc, id_rsa, …) are always excluded, and
# uploading is OFF unless SINGULARITY_PUSH_RESULTS is explicitly set.
python3 - "$@" <<'PY'
import base64
import hashlib
import json
import mimetypes
import os
import pathlib
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

WORKFLOW = json.loads(base64.b64decode("${workflowB64}").decode("utf-8"))

def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

def run_git(args, cwd):
    return subprocess.run(["git", *args], cwd=str(cwd), text=True, capture_output=True)

def git_text(args, cwd):
    proc = run_git(args, cwd)
    return proc.stdout.strip() if proc.returncode == 0 else ""

def status_entries(cwd):
    proc = run_git(["status", "--porcelain", "--untracked-files=all"], cwd)
    entries = []
    for line in proc.stdout.splitlines():
        if not line.strip():
            continue
        code = line[:2]
        raw = line[3:] if len(line) > 3 else line
        if " -> " in raw:
            raw = raw.split(" -> ", 1)[1]
        raw = raw.strip().strip('"')
        if raw:
            entries.append((code, raw))
    return entries

def status_paths(cwd):
    return sorted({path for _, path in status_entries(cwd)})

SECRET_SUBSTRINGS = ("secret", "credential", "password", "private_key", "privatekey")
SECRET_SUFFIXES = (".pem", ".key", ".p12", ".pfx", ".pgp", ".asc")
SECRET_BASENAMES = (".npmrc", ".netrc", ".pgpass", "id_rsa", "id_ed25519", ".git-credentials")

def is_probably_secret(path):
    p = path.replace("\\\\", "/").lower()
    base = p.rsplit("/", 1)[-1]
    if base in SECRET_BASENAMES or base.startswith(".env"):
        return True
    if any(base.endswith(suffix) for suffix in SECRET_SUFFIXES):
        return True
    return any(token in p for token in SECRET_SUBSTRINGS)

def safe_name(value):
    value = re.sub(r"[^A-Za-z0-9._-]+", "-", value).strip("-").lower()
    return value[:80] or "stage"

def env_int(name, default, min_value=1, max_value=None):
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    if value < min_value:
        return default
    if max_value is not None:
        return min(value, max_value)
    return value

def file_artifact(cwd, rel_path, stage_key=None, node_id=None, max_bytes=262144):
    rel_path = rel_path.replace("\\\\", "/")
    target = (cwd / rel_path).resolve()
    try:
        target.relative_to(cwd)
    except ValueError:
        return None
    if not target.is_file():
        return None
    data = target.read_bytes()
    artifact = {
        "path": rel_path,
        "stageKey": stage_key,
        "nodeId": node_id,
        "bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
        "mimeType": mimetypes.guess_type(str(target))[0] or "application/octet-stream",
    }
    if len(data) <= max_bytes:
        artifact["contentBase64"] = base64.b64encode(data).decode("ascii")
    else:
        artifact["truncated"] = True
    return artifact

def add_artifact(artifacts, artifact):
    if not artifact:
        return
    artifacts[artifact["path"]] = artifact

def declared_output_paths(stage):
    out = []
    for item in stage.get("produces") or []:
        if isinstance(item, dict):
            path = str(item.get("path") or "").strip()
            if path and not is_probably_secret(path):
                out.append(path.replace("\\\\", "/"))
    return out

def post_results(platform_url, token, run_id, payload):
    endpoint = platform_url.rstrip("/") + "/api/workgraph/workflow-instances/" + urllib.parse.quote(run_id) + "/export/copilot-results"
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    req = urllib.request.Request(
        endpoint,
        data=body,
        method="POST",
        headers={
            "content-type": "application/json",
            "authorization": "Bearer " + token,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            return res.status, res.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as err:
        return err.code, err.read().decode("utf-8", errors="replace")

def main():
    metadata = WORKFLOW["metadata"]
    stages = WORKFLOW.get("stages", [])
    run_id = metadata["runId"]
    platform_url = os.environ.get("SINGULARITY_PLATFORM_URL", "http://localhost:5180").rstrip("/")
    token = os.environ.get("SINGULARITY_TOKEN") or os.environ.get("WORKGRAPH_TOKEN") or os.environ.get("PLATFORM_TOKEN")
    if not token:
        print("Set SINGULARITY_TOKEN to a Platform Web bearer token before running this export.", file=sys.stderr)
        return 2
    copilot_bin = os.environ.get("COPILOT_BIN", "copilot")
    allow_all = os.environ.get("COPILOT_ALLOW_ALL", "1").lower() not in ("0", "false", "no")
    continue_on_error = os.environ.get("COPILOT_CONTINUE_ON_ERROR", "0").lower() in ("1", "true", "yes")
    max_artifact_bytes = env_int("COPILOT_ARTIFACT_MAX_BYTES", 262144, 1, 5 * 1024 * 1024)
    max_artifacts = env_int("COPILOT_ARTIFACT_MAX_FILES", 40, 1, 200)
    include_untracked = os.environ.get("COPILOT_INCLUDE_UNTRACKED", "0").lower() in ("1", "true", "yes")
    cwd = pathlib.Path(os.environ.get("WORK_DIR", os.getcwd())).resolve()
    out_dir = pathlib.Path(os.environ.get("COPILOT_OUTPUT_DIR", str(cwd / ".singularity" / "copilot-runs" / run_id))).resolve()
    prompt_dir = out_dir / "prompts"
    log_dir = out_dir / "logs"
    prompt_dir.mkdir(parents=True, exist_ok=True)
    log_dir.mkdir(parents=True, exist_ok=True)
    started = now_iso()
    stage_results = []
    artifacts = {}
    overall_status = "completed"

    for index, stage in enumerate(stages, start=1):
        stage_key = stage.get("key") or f"stage-{index}"
        node_id = stage.get("nodeId")
        prompt = stage.get("prompt") or ""
        prompt_path = prompt_dir / f"{index:02d}-{safe_name(stage_key)}.md"
        log_path = log_dir / f"{index:02d}-{safe_name(stage_key)}.log"
        prompt_path.write_text(prompt, encoding="utf-8")
        before = set(status_paths(cwd))
        started_ms = int(time.time() * 1000)
        started_at = now_iso()
        args = [copilot_bin, "-p", prompt]
        if allow_all:
            args.append("--allow-all")
        print(f"[singularity] running {stage_key} with {' '.join(args[:2])} ...")
        proc = subprocess.run(args, cwd=str(cwd), text=True, capture_output=True)
        completed_at = now_iso()
        duration_ms = int(time.time() * 1000) - started_ms
        log_path.write_text(
            "COMMAND: " + " ".join(args[:2]) + " <prompt>" + (" --allow-all" if allow_all else "") + "\\n"
            + "EXIT_CODE: " + str(proc.returncode) + "\\n\\n"
            + "STDOUT\\n" + proc.stdout + "\\n\\nSTDERR\\n" + proc.stderr,
            encoding="utf-8",
        )
        after_entries = status_entries(cwd)
        after = {path for _, path in after_entries}
        untracked = {path for code, path in after_entries if code.strip() == "??"}
        # Finding #5 — upload ONLY files this stage newly changed (after - before);
        # never pre-existing dirty files. Always drop secrets; drop untracked unless
        # explicitly opted in via COPILOT_INCLUDE_UNTRACKED.
        candidate = sorted(after - before)
        changed = [
            p for p in candidate
            if not is_probably_secret(p) and (include_untracked or p not in untracked)
        ]
        skipped = [p for p in candidate if p not in changed]
        declared_outputs = declared_output_paths(stage)
        uploaded_paths = []
        for path in sorted(set(changed + declared_outputs))[:max_artifacts]:
            artifact = file_artifact(cwd, path, stage_key, node_id, max_artifact_bytes)
            add_artifact(artifacts, artifact)
            if artifact:
                uploaded_paths.append(artifact["path"])
        try:
            rel_log_path = str(log_path.relative_to(cwd)).replace("\\\\", "/")
        except ValueError:
            rel_log_path = str(log_path)
        add_artifact(artifacts, file_artifact(cwd, rel_log_path, stage_key, node_id, max_artifact_bytes))
        reported_changed = sorted(set(changed + uploaded_paths))
        status = "completed" if proc.returncode == 0 else "failed"
        if status == "failed":
            overall_status = "failed"
        stage_results.append({
            "key": stage_key,
            "nodeId": node_id,
            "label": stage.get("label"),
            "status": status,
            "startedAt": started_at,
            "completedAt": completed_at,
            "durationMs": duration_ms,
            "exitCode": proc.returncode,
            "logPath": rel_log_path,
            "changedFiles": reported_changed,
            "skippedFiles": skipped,
            "metrics": {
                "promptChars": len(prompt),
                "stdoutChars": len(proc.stdout),
                "stderrChars": len(proc.stderr),
                "changedFileCount": len(reported_changed),
            },
        })
        if proc.returncode != 0 and not continue_on_error:
            break

    payload = {
        "source": "copilot-cli-export",
        "status": overall_status,
        "startedAt": started,
        "completedAt": now_iso(),
        "workflow": metadata,
        "git": {
            "workDir": str(cwd),
            "branch": git_text(["rev-parse", "--abbrev-ref", "HEAD"], cwd) or None,
            "commitSha": git_text(["rev-parse", "HEAD"], cwd) or None,
            "changedFiles": [p for p in status_paths(cwd) if not is_probably_secret(p)],
            "status": [p for p in status_paths(cwd) if not is_probably_secret(p)],
        },
        "metrics": {
            "stageCount": len(stage_results),
            "completedStageCount": sum(1 for s in stage_results if s["status"] == "completed"),
            "failedStageCount": sum(1 for s in stage_results if s["status"] == "failed"),
            "artifactCount": len(artifacts),
        },
        "stages": stage_results,
        "artifacts": list(artifacts.values())[:max_artifacts],
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "copilot-results.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")
    if os.environ.get("SINGULARITY_PUSH_RESULTS", "0").lower() in ("1", "true", "yes"):
        code, body = post_results(platform_url, token, run_id, payload)
        (out_dir / "platform-response.json").write_text(body, encoding="utf-8")
        if code >= 300:
            print(f"[singularity] platform push failed: HTTP {code} {body[:500]}", file=sys.stderr)
            return 3
        print(f"[singularity] platform push accepted: HTTP {code}")
    print(f"[singularity] results written to {out_dir}")
    return 1 if overall_status == "failed" else 0

raise SystemExit(main())
PY
`
}

type CompletedPhaseData = {
  status?: string
  artifacts: Array<{ name: string; type: string; status: string; content: string }>
  outputs: Array<{ type: string; summary?: string; changedPaths?: string[]; commitSha?: string; diff?: string }>
}

// Compose the FULL Copilot prompt (agent role + repo world model + work-item
// description + task) for one stage via context-fabric — the same prompt the
// governed run feeds `copilot -p`. Best-effort: the export must never fail on a
// compose error, so we fall back to the raw task.
type ComposedStagePrompt = { prompt: string; degraded: boolean; warning?: string }

async function composeCopilotStagePrompt(input: {
  task: string; stageKey?: string; agentRole?: string; capabilityId?: string | null
  vars: Record<string, unknown>; runContext: Record<string, unknown>
}): Promise<ComposedStagePrompt> {
  // Finding #10 — bound the call so one stalled CF compose can't hang the whole export.
  const timeoutMs = copilotComposeTimeoutMs()
  try {
    const url = `${config.CONTEXT_FABRIC_URL.replace(/\/$/, '')}/api/v1/compose-copilot-prompt`
    const resp = await fetch(url, {
      method: 'POST',
      headers: contextFabricServiceHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        task: input.task,
        stage_key: input.stageKey,
        agent_role: input.agentRole,
        capability_id: input.capabilityId ?? undefined,
        vars: input.vars,
        run_context: input.runContext,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!resp.ok) {
      return { prompt: input.task, degraded: true, warning: `prompt composition failed (HTTP ${resp.status}); using raw task` }
    }
    const parsed = await readWorkflowJsonResponse<{ prompt?: string; degraded?: boolean; warning?: string }>(
      resp,
      'context-fabric prompt composition',
    )
    if (parsed.error) {
      return { prompt: input.task, degraded: true, warning: `${parsed.error}; using raw task` }
    }
    const body = parsed.data ?? {}
    // Finding #11 — distinguish a real composed prompt from a silent raw-task fallback,
    // and propagate CF's own degraded signal (e.g. world-model lookup failed).
    if (typeof body?.prompt !== 'string' || !body.prompt.trim()) {
      return { prompt: input.task, degraded: true, warning: 'composer returned an empty prompt; using raw task' }
    }
    return { prompt: body.prompt, degraded: Boolean(body.degraded), warning: body.warning }
  } catch (err) {
    const warning = err instanceof Error && err.name === 'TimeoutError'
      ? `prompt composition timed out after ${timeoutMs}ms; using raw task`
      : `prompt composition error: ${(err as Error).message}; using raw task`
    return { prompt: input.task, degraded: true, warning }
  }
}

// Finding #11 — surface degraded prompt composition on the file-download endpoints so the
// Workbench can warn the user that the handoff fell back to raw tasks (missing agent-role
// instructions / repo world model / governance) before they rely on it.
function setComposeWarningHeaders(
  res: { setHeader: (name: string, value: string) => void },
  warnings: Array<{ stageKey: string; warning: string }>,
): void {
  if (!warnings.length) return
  res.setHeader('X-Singularity-Compose-Degraded', 'true')
  res.setHeader('X-Singularity-Compose-Warnings', encodeURIComponent(JSON.stringify(warnings)).slice(0, 3000))
}

function consumableContent(formData: unknown): string {
  const fd = (formData ?? {}) as Record<string, unknown>
  if (typeof fd.content === 'string') return fd.content
  return JSON.stringify(fd, null, 2)
}

// Ordered Copilot stages + the run-level header fields. Shared by the loader (to
// know which stages to compose / mark done) and the YAML builder, so stage
// selection happens exactly once.
function copilotStagesFromNodes(
  instance: { context: unknown },
  nodes: CopilotExportNode[],
  edges: Array<{ sourceNodeId: string; targetNodeId: string }>,
): { stages: CopilotExportStage[]; repo: string; story: string; workCode: string; vars: Record<string, unknown> } {
  const context = ((instance.context ?? {}) as Record<string, unknown>)
  const vars = (context._vars ?? {}) as Record<string, unknown>
  const globals = (context._globals ?? {}) as Record<string, unknown>
  const cfgOf = (n: { config: unknown }) => (n.config ?? {}) as Record<string, unknown>
  const interpolate = (s: string) => s.replace(/\{\{\s*instance\.vars\.(\w+)\s*\}\}/g, (_m, k) => String(vars[k] ?? ''))
  const firstString = (...values: unknown[]): string => {
    for (const value of values) {
      if (typeof value === 'string' && value.trim()) return value.trim()
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const nested = (value as Record<string, unknown>).url
        if (typeof nested === 'string' && nested.trim()) return nested.trim()
      }
    }
    return ''
  }
  const repo = firstString(
    vars.repoUrl,
    vars.repositoryUrl,
    vars.sourceUri,
    globals.repoUrl,
    globals.repositoryUrl,
    globals.sourceUri,
    context.repoUrl,
    context.repositoryUrl,
    context.sourceUri,
    context.repository,
    nodes.map(cfgOf).find(c => c.sourceUri)?.sourceUri,
  )
  const story = String(vars.story ?? vars.workItemDescription ?? '')
  const workCode = String(vars.workCode ?? '')
  // Map a node's artifact defs → the export's IN/OUT contract, interpolating the real
  // save path so a reader knows exactly where each doc lives / must be written.
  const artifactRefs = (defs: unknown, opts: { withTemplate: boolean }): CopilotArtifactRef[] => {
    if (!Array.isArray(defs)) return []
    return defs
      .filter((a): a is Record<string, unknown> => Boolean(a) && typeof a === 'object' && !Array.isArray(a))
      .map((a) => {
        const rawPath = String(a.path ?? a.bindingPath ?? '').trim()
        const ref: CopilotArtifactRef = { name: String(a.name ?? a.id ?? 'document') }
        if (a.format) ref.format = String(a.format)
        if (rawPath) ref.path = interpolate(rawPath)
        if (typeof a.description === 'string' && a.description.trim()) ref.description = a.description
        if (opts.withTemplate && typeof a.template === 'string' && a.template.trim()) ref.template = a.template
        return ref
      })
  }
  const stages: CopilotExportStage[] = topologicalCopilotNodes(nodes, edges)
    .map((n): CopilotExportStage | null => {
      const c = cfgOf(n)
      const task = typeof c.task === 'string' ? interpolate(c.task) : ''
      if (!task.trim()) return null
      const executor = String(c.executor ?? '').toLowerCase()
      const isCopilot = executor === 'copilot' || n.nodeType === 'AGENT_TASK'
      if (!isCopilot) return null
      return {
        key: String(c.governedStageKey ?? n.label ?? n.id),
        nodeId: n.id,
        label: n.label,
        nodeType: n.nodeType,
        role: String(c.governedAgentRole ?? ''),
        prompt: task,
        status: n.status,
        reads: artifactRefs(c.inputArtifacts, { withTemplate: false }),
        produces: artifactRefs(c.outputArtifacts, { withTemplate: true }),
      }
    })
    .filter((stage): stage is CopilotExportStage => Boolean(stage))
  return { stages, repo, story, workCode, vars }
}

// Render an artifact contract (reads / produces / documents) as YAML lines. `pad` is
// the indent of each list item's leading "- ".
function artifactRefYaml(refs: CopilotArtifactRef[], pad: string): string[] {
  const out: string[] = []
  for (const r of refs) {
    out.push(`${pad}- name: ${yamlString(r.name)}`)
    if (r.format) out.push(`${pad}  format: ${yamlString(r.format)}`)
    if (r.path) out.push(`${pad}  path: ${yamlString(r.path)}`)
    if (r.description) out.push(`${pad}  description: ${yamlString(r.description)}`)
    if (r.template) { out.push(`${pad}  template: |`); out.push(yamlBlock(r.template, pad.length + 4)) }
  }
  return out
}

function buildCopilotWorkflowExport(
  instance: { id: string; name: string; context: unknown },
  computed: { stages: CopilotExportStage[]; repo: string; story: string; workCode: string },
  extras: { fromPhase?: string; composedByNodeId?: Map<string, string>; completedByNodeId?: Map<string, CompletedPhaseData> } = {},
) {
  const { repo, story, workCode } = computed
  // The run's work branch (wi/<code>) + the base it's cut from — so the export tells
  // an external tool exactly which branch to clone/checkout and push back to.
  const exportGlobals = (((instance.context ?? {}) as Record<string, unknown>)._globals ?? {}) as Record<string, unknown>
  const exportContext = ((instance.context ?? {}) as Record<string, unknown>)
  const exportVars = (exportContext._vars ?? {}) as Record<string, unknown>
  const baseBranch = String(exportGlobals.sourceRef ?? exportContext.fromBranch ?? exportVars.baseBranch ?? 'main')
  const workBranch = String(exportContext.workBranch ?? exportVars.workBranch ?? (workCode ? `wi/${workCode}` : ''))
  const preflightWarnings = [
    ...(repo ? [] : ['Repository URL is missing. Clone/open the target repository manually, or link an ACTIVE repository to the capability before exporting.']),
    ...(workBranch ? [] : ['Work branch is missing. Create or choose a branch before running the handoff.']),
  ]
  const composed = extras.composedByNodeId ?? new Map<string, string>()
  const completedData = extras.completedByNodeId ?? new Map<string, CompletedPhaseData>()
  // Split: stages before `fromPhase` are DONE context; `fromPhase` onward is the
  // runnable playbook. Absent/unknown fromPhase → the whole run is runnable.
  const foundIdx = extras.fromPhase
    ? computed.stages.findIndex(s => s.key === extras.fromPhase || s.nodeId === extras.fromPhase)
    : 0
  if (extras.fromPhase && foundIdx < 0) throw new ValidationError(`Unknown phase '${extras.fromPhase}'`)
  const startIdx = foundIdx < 0 ? 0 : foundIdx
  const completedStages = computed.stages.slice(0, startIdx)
  const stages = computed.stages
    .slice(startIdx)
    .map(s => ({ ...s, prompt: composed.get(s.nodeId) ?? s.prompt }))
  const exportedAt = new Date().toISOString()
  const filenameBase = `copilot-sdlc-${slugForFile(workCode || instance.name || instance.id.slice(0, 8))}`
  const workflow = {
    apiVersion: 'singularity.dev/v1alpha1',
    kind: 'CopilotWorkflowRun',
    metadata: {
      runId: instance.id,
      name: instance.name,
      workItem: workCode || null,
      startPhase: extras.fromPhase ?? (stages[0]?.key ?? null),
      exportedAt,
    },
    platform: {
      resultEndpoint: `/api/workgraph/workflow-instances/${instance.id}/export/copilot-results`,
      tokenEnv: 'SINGULARITY_TOKEN',
    },
    repository: {
      url: repo || null,
      branch: workBranch || null,
      baseBranch,
    },
    preflight: {
      status: preflightWarnings.length ? 'needs-attention' : 'ready',
      warnings: preflightWarnings,
    },
    story,
    stages,
  }
  const script = buildCopilotRunnerScript(workflow)
  const yaml: string[] = [
    '# Singularity -> Copilot handoff. Continue this SDLC on your own Copilot CLI:',
    '#   `completed` = phases already done — full artifact content + diffs, and',
    '#                 `documents[]` = where each produced doc lives on the branch.',
    '#   `stages`    = phases to run, starting at the phase you exported from;',
    '#                 run each:  copilot -p "<prompt>" --allow-all   (in order).',
    '#                 each stage lists `reads[]` (input docs + paths to open) and',
    '#                 `produces[]` (docs to write: name, format, save-path, template).',
    '#   Documents live at each stage\'s produces[].path on repository.branch',
    '#   (deliverables/<workItem>/<role>/…) — read/write the real files there.',
    '#',
    '# Or drive it end-to-end from a cloned repo:',
    '#   export SINGULARITY_TOKEN="<platform bearer token>"',
    '#   export SINGULARITY_PLATFORM_URL="http://localhost:5180"',
    `#   curl -L "$SINGULARITY_PLATFORM_URL/api/workgraph/workflow-instances/${instance.id}/export/copilot-runner.sh" -H "Authorization: Bearer $SINGULARITY_TOKEN" | bash`,
    '#',
    "# Work on THIS run's branch — clone the repo and check out the work branch",
    '# (create it from the base if it does not exist yet), then push it back:',
    `#   git clone ${repo || '<repo-url>'} && cd "$(basename ${repo || '<repo-url>'} .git)"`,
    `#   git fetch origin ${workBranch || '<work-branch>'} && git checkout ${workBranch || '<work-branch>'} \\`,
    `#     || git checkout -b ${workBranch || '<work-branch>'} ${baseBranch}`,
    `#   # …run the stages…  then:  git push -u origin ${workBranch || '<work-branch>'}`,
    '#',
    "# ANY TOOL: the `stages[].prompt` values are tool-agnostic. Run them in whatever",
    "# tool you like, then POST your results to `platform.resultEndpoint` in the",
    "# `resultContract` shape below. PUSH your work to a branch so the platform can",
    "# verify it in git (see resultContract.verification).",
    '#',
    'apiVersion: "singularity.dev/v1alpha1"',
    'kind: "CopilotWorkflowRun"',
    'metadata:',
    `  runId: ${yamlString(instance.id)}`,
    `  name: ${yamlString(instance.name)}`,
    `  exportedAt: ${yamlString(exportedAt)}`,
  ]
  if (extras.fromPhase) yaml.push(`  startPhase: ${yamlString(extras.fromPhase)}`)
  if (workCode) yaml.push(`  workItem: ${yamlString(workCode)}`)
  yaml.push(
    'platform:',
    `  resultEndpoint: ${yamlString(`/api/workgraph/workflow-instances/${instance.id}/export/copilot-results`)}`,
    '  tokenEnv: "SINGULARITY_TOKEN"',
    'repository:',
    `  url: ${repo ? yamlString(repo) : 'null'}`,
    `  branch: ${workBranch ? yamlString(workBranch) : 'null'}          # the run's work branch — clone + checkout this, push back to it`,
    `  baseBranch: ${yamlString(baseBranch)}   # branch the work branch is cut from`,
    'preflight:',
    `  status: ${yamlString(preflightWarnings.length ? 'needs-attention' : 'ready')}`,
    '  warnings:',
    ...(preflightWarnings.length ? preflightWarnings.map(w => `    - ${yamlString(w)}`) : ['    []']),
    // Self-documenting, tool-agnostic post-back contract (reference, not run input).
    'resultContract:',
    '  # POST this JSON to platform.resultEndpoint with header: Authorization: Bearer $SINGULARITY_TOKEN',
    '  source: "<your-tool-name>"          # any identifier, e.g. cursor / manual / claude',
    '  status: "completed | failed"',
    '  git:',
    `    branch: ${workBranch ? yamlString(workBranch) : '"<branch you pushed to origin>"'}   # push this branch — required for git verification`,
    '    commitSha: "<head commit sha>"',
    '    changedFiles: ["<changed file path>", "..."]',
    '    status: ["<changed file path>", "..."]  # legacy alias accepted by the platform',
    '  artifacts:',
    '    - path: "<repo-relative path>"',
    '      sha256: "<sha256 of the raw file bytes>"',
    '      contentBase64: "<base64 of file content>"',
    '      stageKey: "<one of stages[].key>"',
    '  verification: "The platform fetches your pushed branch and checks the commit exists + changed-path coverage, then records an advisory verdict on the run. Results with no pushed branch are recorded as UNVERIFIED."',
  )
  if (story) {
    yaml.push('story: |', yamlBlock(story, 2))
  }
  // ── completed phases — context only (full artifacts + diffs) ─────────────
  yaml.push('completed:')
  if (!completedStages.length) {
    yaml.push('  []')
  } else {
    for (const stage of completedStages) {
      const data = completedData.get(stage.nodeId)
      yaml.push(`  - key: ${yamlString(stage.key)}`)
      yaml.push(`    label: ${yamlString(stage.label)}`)
      if (stage.role) yaml.push(`    role: ${yamlString(stage.role)}`)
      yaml.push(`    status: ${yamlString(data?.status ?? stage.status ?? 'COMPLETED')}`)
      const artifacts = data?.artifacts ?? []
      yaml.push('    artifacts:')
      if (!artifacts.length) {
        yaml.push('      []')
      } else {
        for (const a of artifacts) {
          yaml.push(`      - name: ${yamlString(a.name)}`)
          yaml.push(`        type: ${yamlString(a.type)}`)
          yaml.push(`        status: ${yamlString(a.status)}`)
          yaml.push('        content: |')
          yaml.push(yamlBlock(a.content, 10))
        }
      }
      const outputs = data?.outputs ?? []
      if (outputs.length) {
        yaml.push('    outputs:')
        for (const o of outputs) {
          yaml.push(`      - type: ${yamlString(o.type)}`)
          if (o.summary) { yaml.push('        summary: |'); yaml.push(yamlBlock(o.summary, 10)) }
          if (o.commitSha) yaml.push(`        commitSha: ${yamlString(o.commitSha)}`)
          if (o.changedPaths?.length) {
            yaml.push('        changedPaths:')
            for (const p of o.changedPaths) yaml.push(`          - ${yamlString(p)}`)
          }
          if (o.diff) { yaml.push('        diff: |'); yaml.push(yamlBlock(o.diff, 10)) }
        }
      }
      // Where each produced document lives on the branch (path + format), so a reader
      // can open the actual file, not just the inlined content above.
      if (stage.produces.length) {
        yaml.push('    documents:')
        yaml.push(...artifactRefYaml(stage.produces.map(p => ({ name: p.name, format: p.format, path: p.path })), '      '))
      }
    }
  }
  yaml.push('stages:')
  if (!stages.length) {
    yaml.push('  []')
  } else {
    for (const stage of stages) {
      yaml.push(`  - key: ${yamlString(stage.key)}`)
      yaml.push(`    nodeId: ${yamlString(stage.nodeId)}`)
      yaml.push(`    label: ${yamlString(stage.label)}`)
      yaml.push(`    nodeType: ${yamlString(stage.nodeType)}`)
      if (stage.role) yaml.push(`    role: ${yamlString(stage.role)}`)
      // Input documents this stage reads (produced by earlier stages) — name/format/path.
      if (stage.reads.length) {
        yaml.push('    reads:')
        yaml.push(...artifactRefYaml(stage.reads, '      '))
      }
      // Output documents this stage must produce — name/format/save-path + a template.
      if (stage.produces.length) {
        yaml.push('    produces:')
        yaml.push(...artifactRefYaml(stage.produces, '      '))
      }
      yaml.push('    copilot:')
      yaml.push('      command: "copilot"')
      yaml.push('      args: ["-p", "<prompt>", "--allow-all"]')
      yaml.push('    prompt: |')
      yaml.push(yamlBlock(stage.prompt, 6))
    }
  }
  yaml.push(
    'runner:',
    '  language: "bash"',
    `  scriptEndpoint: ${yamlString(`/api/workgraph/workflow-instances/${instance.id}/export/copilot-runner.sh`)}`,
    '  script: |',
    yamlBlock(script, 4),
  )
  return { yaml: `${yaml.join('\n')}\n`, script, filenameBase, stageCount: stages.length }
}

async function loadCopilotExportData(id: string, opts: { fromPhase?: string } = {}, tenantId?: string) {
  const [instance, nodes, edges] = await withTenantDbTransaction(prisma, (tx) => Promise.all([
    tx.workflowInstance.findUnique({ where: { id }, select: { id: true, name: true, context: true, templateId: true } }),
    tx.workflowNode.findMany({
      where: { instanceId: id },
      orderBy: { createdAt: 'asc' },
      select: { id: true, label: true, nodeType: true, config: true, createdAt: true, status: true, completedAt: true },
    }),
    tx.workflowEdge.findMany({
      where: { instanceId: id },
      select: { sourceNodeId: true, targetNodeId: true },
    }),
  ]), tenantId)
  if (!instance) return null

  const exportNodes: CopilotExportNode[] = nodes.map(n => ({ ...n, nodeType: String(n.nodeType), status: String(n.status) }))
  const computed = copilotStagesFromNodes(instance, exportNodes, edges)

  // Split at fromPhase: before = done (artifacts + diffs); from there = runnable.
  const foundIdx = opts.fromPhase
    ? computed.stages.findIndex(s => s.key === opts.fromPhase || s.nodeId === opts.fromPhase)
    : 0
  if (opts.fromPhase && foundIdx < 0) throw new ValidationError(`Unknown phase '${opts.fromPhase}'`)
  const startIdx = foundIdx < 0 ? 0 : foundIdx
  const completedStages = computed.stages.slice(0, startIdx)
  const todoStages = computed.stages.slice(startIdx)

  // Capability id grounds the composed prompt (repo world-model lookup).
  const workflow = instance.templateId
    ? await prisma.workflow.findUnique({ where: { id: instance.templateId }, select: { capabilityId: true } })
    : null
  const capabilityId = workflow?.capabilityId ?? null
  const runContext: Record<string, unknown> = {
    workflow_instance_id: instance.id,
    capability_id: capabilityId ?? undefined,
    work_item_code: computed.workCode || undefined,
    source_type: 'github',
    source_uri: computed.repo || undefined,
  }
  // Per-stage IN/OUT document contract — each phase declares its own artifacts, so
  // the composer can list this stage's inputs to read + outputs to produce.
  const nodeCfgById = new Map(nodes.map(n => [n.id, (n.config ?? {}) as Record<string, unknown>]))
  const stageRunContext = (nodeId: string): Record<string, unknown> => {
    const cfg = nodeCfgById.get(nodeId) ?? {}
    return {
      ...runContext,
      ...(Array.isArray(cfg.inputArtifacts) && cfg.inputArtifacts.length ? { input_artifacts: withInputDocContent(cfg.inputArtifacts, instance.context) } : {}),
      ...(Array.isArray(cfg.outputArtifacts) && cfg.outputArtifacts.length ? { output_artifacts: cfg.outputArtifacts } : {}),
    }
  }

  // Compose the FULL prompt for every runnable phase. Bounded fan-out: each
  // compose triggers a CF repo world-model build, so cap concurrency.
  const composedByNodeId = new Map<string, string>()
  const composedPrompts = await mapLimit(todoStages, 4, s =>
    composeCopilotStagePrompt({
      task: s.prompt, stageKey: s.key, agentRole: s.role, capabilityId, vars: computed.vars, runContext: stageRunContext(s.nodeId),
    }),
  )
  // Finding #11 — record which stages fell back to the raw task so the caller can warn the
  // user instead of shipping a valid-looking handoff that silently lacks composed context.
  const composeWarnings: Array<{ stageKey: string; warning: string }> = []
  todoStages.forEach((s, i) => {
    composedByNodeId.set(s.nodeId, composedPrompts[i].prompt)
    if (composedPrompts[i].degraded) {
      composeWarnings.push({ stageKey: s.key, warning: composedPrompts[i].warning ?? 'prompt composition degraded; using raw task' })
    }
  })

  // Completed phases: full artifacts (Consumables) + outputs (summary/diff/paths).
  const completedByNodeId = new Map<string, CompletedPhaseData>()
  if (completedStages.length) {
    const completedNodeIds = completedStages.map(s => s.nodeId)
    const [consumables, agentRuns] = await withTenantDbTransaction(prisma, (tx) => Promise.all([
      tx.consumable.findMany({
        where: { instanceId: id, nodeId: { in: completedNodeIds } },
        select: { name: true, type: true, status: true, nodeId: true, formData: true },
      }),
      tx.agentRun.findMany({
        where: { instanceId: id, nodeId: { in: completedNodeIds } },
        select: { nodeId: true, outputs: { select: { outputType: true, rawContent: true, structuredPayload: true } } },
      }),
    ]), tenantId)
    for (const stage of completedStages) {
      const artifacts = consumables
        .filter(c => c.nodeId === stage.nodeId)
        .map(c => ({ name: c.name, type: String(c.type), status: String(c.status), content: consumableContent(c.formData) }))
      const outputs: CompletedPhaseData['outputs'] = []
      for (const run of agentRuns.filter(r => r.nodeId === stage.nodeId)) {
        for (const o of run.outputs) {
          const sp = (o.structuredPayload ?? {}) as Record<string, unknown>
          outputs.push({
            type: o.outputType,
            summary: typeof sp.summary === 'string' ? sp.summary : (o.rawContent ?? undefined),
            changedPaths: Array.isArray(sp.changedPaths) ? sp.changedPaths.map(String) : undefined,
            commitSha: typeof sp.workspaceCommitSha === 'string' ? sp.workspaceCommitSha
              : (typeof sp.commitSha === 'string' ? sp.commitSha : undefined),
            diff: typeof sp.diff === 'string' ? sp.diff : undefined,
          })
        }
      }
      completedByNodeId.set(stage.nodeId, { status: stage.status, artifacts, outputs })
    }
  }

  return { ...buildCopilotWorkflowExport(instance, computed, { fromPhase: opts.fromPhase, composedByNodeId, completedByNodeId }), composeWarnings }
}

// Export the run as a portable Copilot workflow YAML. The YAML includes an
// embedded runner script; the adjacent .sh endpoint serves that script directly
// for shells that do not have a YAML extractor installed.
workflowInstancesRouter.get('/:id/export/copilot-yaml', async (req, res, next) => {
  try {
    const id = req.params.id as string
    const fromPhase = typeof req.query.fromPhase === 'string' && req.query.fromPhase.trim() ? req.query.fromPhase.trim() : undefined
    await assertInstancePermission(req.user!.userId, id, 'view')
    const exported = await loadCopilotExportData(id, { fromPhase }, resolveTenantFromRequest(req))
    if (!exported) return res.status(404).json({ error: 'run not found' })
    res.setHeader('Content-Type', 'application/x-yaml')
    res.setHeader('Content-Disposition', `attachment; filename="${exported.filenameBase}.yaml"`)
    setComposeWarningHeaders(res, exported.composeWarnings)
    res.send(exported.yaml)
  } catch (err) {
    next(err)
  }
})

workflowInstancesRouter.get('/:id/export/copilot-runner.sh', async (req, res, next) => {
  try {
    const id = req.params.id as string
    const fromPhase = typeof req.query.fromPhase === 'string' && req.query.fromPhase.trim() ? req.query.fromPhase.trim() : undefined
    await assertInstancePermission(req.user!.userId, id, 'view')
    const exported = await loadCopilotExportData(id, { fromPhase }, resolveTenantFromRequest(req))
    if (!exported) return res.status(404).json({ error: 'run not found' })
    res.setHeader('Content-Type', 'text/x-shellscript; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${exported.filenameBase}.sh"`)
    setComposeWarningHeaders(res, exported.composeWarnings)
    res.send(exported.script)
  } catch (err) {
    next(err)
  }
})

// ── Composed prompt for one phase ──────────────────────────────────────────
// "The prompt used": the FULL agent prompt (role contract + repo world model +
// work-item + task) a phase's agent runs — the SAME composition the Copilot
// handoff export builds (composeCopilotStagePrompt → CF /compose-copilot-prompt).
// Enrich a node's INPUT artifact defs with the upstream document content produced
// so far (from the deliverables binding namespace, context.deliverables.<type>), so
// the composed prompt / Prompt tab can INLINE it. Best-effort: no match ⇒ def
// unchanged (the prompt shows the file path for the agent to read).
function withInputDocContent(defs: unknown, instanceContext: unknown): unknown {
  if (!Array.isArray(defs)) return defs
  const ctx = (instanceContext && typeof instanceContext === 'object') ? instanceContext as Record<string, unknown> : {}
  const deliverables = (ctx.deliverables && typeof ctx.deliverables === 'object') ? ctx.deliverables as Record<string, unknown> : {}
  const resolve = (t: unknown): string | undefined => {
    const v = deliverables[String(t ?? '')]
    if (typeof v === 'string' && v.trim()) return v
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const k of ['content', 'markdown', 'text', 'body']) {
        const inner = (v as Record<string, unknown>)[k]
        if (typeof inner === 'string' && inner.trim()) return inner
      }
    }
    return undefined
  }
  return defs.map(d => {
    if (!d || typeof d !== 'object') return d
    const content = resolve((d as Record<string, unknown>).artifactType)
    return content ? { ...d, content } : d
  })
}

// Recomposed on demand so it works for pending AND completed phases; `degraded`
// marks a fallback to the raw task when the composer/world-model is unavailable.
async function composeNodePrompt(id: string, nodeId: string, tenantId?: string) {
  const [instance, nodes, edges] = await withTenantDbTransaction(prisma, (tx) => Promise.all([
    tx.workflowInstance.findUnique({ where: { id }, select: { id: true, context: true, templateId: true } }),
    tx.workflowNode.findMany({
      where: { instanceId: id },
      orderBy: { createdAt: 'asc' },
      select: { id: true, label: true, nodeType: true, config: true, createdAt: true, status: true, completedAt: true },
    }),
    tx.workflowEdge.findMany({ where: { instanceId: id }, select: { sourceNodeId: true, targetNodeId: true } }),
  ]), tenantId)
  if (!instance) return { notFound: true as const }

  const exportNodes: CopilotExportNode[] = nodes.map(n => ({ ...n, nodeType: String(n.nodeType), status: String(n.status) }))
  const computed = copilotStagesFromNodes(instance, exportNodes, edges)
  const stage = computed.stages.find(s => s.nodeId === nodeId)
  if (!stage) {
    return {
      nodeId,
      composable: false as const,
      reason: 'This phase has no composed prompt — only agent (Copilot) task phases run one.',
    }
  }

  // Runtime prompt override (Prompt tab "Edit prompt") — return it verbatim so the tab
  // reflects exactly what the phase will run and re-editing pre-fills the override.
  const nodeCfg = (nodes.find(n => n.id === nodeId)?.config ?? {}) as Record<string, unknown>
  const promptOverride = typeof nodeCfg._promptOverride === 'string' ? nodeCfg._promptOverride : ''
  if (promptOverride.trim()) {
    return {
      nodeId,
      composable: true as const,
      stageKey: stage.key,
      role: stage.role,
      label: stage.label,
      prompt: promptOverride,
      degraded: false,
      overridden: true as const,
    }
  }

  // Capability id grounds the composed prompt (repo world-model lookup) — same as the export.
  const workflow = instance.templateId
    ? await prisma.workflow.findUnique({ where: { id: instance.templateId }, select: { capabilityId: true } })
    : null
  const capabilityId = workflow?.capabilityId ?? null
  const runContext: Record<string, unknown> = {
    workflow_instance_id: instance.id,
    capability_id: capabilityId ?? undefined,
    work_item_code: computed.workCode || undefined,
    source_type: 'github',
    source_uri: computed.repo || undefined,
    // Stage IN/OUT document contract → the composer lists the input documents to
    // read (with paths) + the outputs to produce (with format), so the Prompt tab
    // shows them exactly as the run will.
    ...(Array.isArray(nodeCfg.inputArtifacts) && nodeCfg.inputArtifacts.length ? { input_artifacts: withInputDocContent(nodeCfg.inputArtifacts, instance.context) } : {}),
    ...(Array.isArray(nodeCfg.outputArtifacts) && nodeCfg.outputArtifacts.length ? { output_artifacts: nodeCfg.outputArtifacts } : {}),
  }
  const composed = await composeCopilotStagePrompt({
    task: stage.prompt, stageKey: stage.key, agentRole: stage.role, capabilityId, vars: computed.vars, runContext,
  })
  return {
    nodeId,
    composable: true as const,
    stageKey: stage.key,
    role: stage.role,
    label: stage.label,
    prompt: composed.prompt,
    degraded: composed.degraded,
    warning: composed.warning,
  }
}

workflowInstancesRouter.get('/:id/nodes/:nodeId/composed-prompt', async (req, res, next) => {
  try {
    const id = req.params.id as string
    const nodeId = req.params.nodeId as string
    await assertInstancePermission(req.user!.userId, id, 'view')
    const result = await composeNodePrompt(id, nodeId, resolveTenantFromRequest(req))
    if ('notFound' in result) return res.status(404).json({ error: 'run not found' })
    res.json(result)
  } catch (err) {
    next(err)
  }
})

workflowInstancesRouter.post('/:id/export/copilot-results', async (req, res, next) => {
  try {
    const id = req.params.id as string
    await assertInstancePermission(req.user!.userId, id, 'edit')
    const parsed = copilotResultsSchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: 'invalid copilot results payload', issues: parsed.error.flatten() })
    const instance = await withTenantDbTransaction(prisma, (tx) => tx.workflowInstance.findUnique({
      where: { id },
      select: { id: true, nodes: { select: { id: true } } },
    }), resolveTenantFromRequest(req))
    if (!instance) return res.status(404).json({ error: 'run not found' })
    const validNodeIds = new Set(instance.nodes.map(n => n.id))
    const payload = parsed.data
    // Advisory git-verify: a consistency/completeness verdict computed from the
    // posted payload (sha256 integrity + changed-path coverage + pushed flag).
    // Recorded on the receipt + each artifact; artifacts stay UNDER_REVIEW (no
    // auto promote/block). remoteVerified is false — independent remote-commit
    // verification via the git broker is a follow-up.
    const verification = buildCopilotResultsVerdict(payload, new Date().toISOString())
    const eventId = await withTenantDbTransaction(prisma, (tx) => tx.workflowEvent.create({
      data: {
        instanceId: id,
        eventType: 'CopilotWorkflowResultsImported',
        payload: payload as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    }), resolveTenantFromRequest(req))
    const eventLogId = await logEvent('CopilotWorkflowResultsImported', 'WorkflowInstance', id, req.user!.userId, {
      status: payload.status,
      metrics: payload.metrics,
      stageCount: payload.stages.length,
      artifactCount: payload.artifacts.length,
      source: payload.source,
      workflowEventId: eventId.id,
      verificationStatus: verification.status,
    })
    const receipt = await prisma.receipt.create({
      data: {
        receiptType: 'copilot.workflow.results',
        entityType: 'WorkflowInstance',
        entityId: id,
        eventLogId,
        content: {
          source: payload.source,
          status: payload.status,
          startedAt: payload.startedAt,
          completedAt: payload.completedAt,
          metrics: payload.metrics,
          git: payload.git,
          stages: payload.stages,
          artifactCount: payload.artifacts.length,
          verification,
        } as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    })
    const type = payload.artifacts.length
      ? await prisma.consumableType.upsert({
          where: { name: 'Copilot CLI Artifact' },
          update: {},
          create: {
            name: 'Copilot CLI Artifact',
            description: 'Artifact imported from an exported Copilot CLI workflow run.',
            schemaDef: {},
            requiresApproval: true,
            allowVersioning: true,
          },
        })
      : null
    const createdArtifacts: string[] = []
    if (type) {
      for (const artifact of payload.artifacts) {
        const nodeId = artifact.nodeId && validNodeIds.has(artifact.nodeId) ? artifact.nodeId : undefined
        const consumable = await withTenantDbTransaction(prisma, (tx) => tx.consumable.create({
          data: {
            typeId: type.id,
            instanceId: id,
            nodeId,
            name: `copilot:${artifact.stageKey ?? 'run'}:${artifact.path}`.slice(0, 240),
            status: 'UNDER_REVIEW' as never,
            formData: {
              source: payload.source,
              path: artifact.path,
              sha256: artifact.sha256,
              bytes: artifact.bytes,
              mimeType: artifact.mimeType,
              stageKey: artifact.stageKey,
              truncated: artifact.truncated === true,
              receiptId: receipt.id,
              _verification: {
                status: verification.status,
                remoteVerified: verification.remoteVerified,
                pushed: verification.pushed,
                shaMatched: artifact.truncated || !artifact.sha256 || !artifact.contentBase64
                  ? null
                  : !verification.integrity.mismatched.some(m => m.path === artifact.path),
                note: verification.note,
                checkedAt: verification.checkedAt,
              },
            } as Prisma.InputJsonValue,
            createdById: req.user!.userId,
          },
          select: { id: true },
        }), resolveTenantFromRequest(req))
        await prisma.consumableVersion.create({
          data: {
            consumableId: consumable.id,
            version: 1,
            payload: artifact as unknown as Prisma.InputJsonValue,
            createdById: req.user!.userId,
          },
        })
        createdArtifacts.push(consumable.id)
      }
    }
    await publishOutbox('WorkflowInstance', id, 'CopilotWorkflowResultsImported', {
      actorId: req.user!.userId,
      receiptId: receipt.id,
      workflowEventId: eventId.id,
      status: payload.status,
      metrics: payload.metrics,
      artifactCount: createdArtifacts.length,
    })
    res.status(201).json({
      ok: true,
      workflowEventId: eventId.id,
      eventLogId,
      receiptId: receipt.id,
      artifactsCreated: createdArtifacts.length,
      artifactIds: createdArtifacts,
      verification,
    })
  } catch (err) {
    next(err)
  }
})

// M98 — Manually complete a stuck node with an operator comment and advance the
// workflow. Unlike /restart (re-runs the node) this accepts the node as done
// and moves downstream. Works on any non-COMPLETED node (FAILED, BLOCKED,
// ACTIVE, PENDING) regardless of whether the run is FAILED/PAUSED — the runtime
// re-opens the instance before advancing.
workflowInstancesRouter.post('/:id/nodes/:nodeId/force-complete', validate(forceCompleteSchema), async (req, res, next) => {
  try {
    const id = req.params.id as string
    const nodeId = req.params.nodeId as string
    await assertInstancePermission(req.user!.userId, id, 'edit')
    const { comment, output } = req.body as z.infer<typeof forceCompleteSchema>
    await forceCompleteNode(id, nodeId, comment, output ?? {}, req.user!.userId, resolveTenantFromRequest(req))
    const [instance, node] = await withTenantDbTransaction(prisma, (tx) => Promise.all([
      tx.workflowInstance.findUnique({ where: { id }, include: { nodes: true, edges: true } }),
      tx.workflowNode.findUnique({ where: { id: nodeId } }),
    ]), resolveTenantFromRequest(req))
    res.json({ instance, node })
  } catch (err) {
    next(err)
  }
})

workflowInstancesRouter.post('/:id/advance', validate(advanceSchema), async (req, res, next) => {
  try {
    const id = req.params.id as string
    const { completedNodeId, output } = req.body as z.infer<typeof advanceSchema>
    await advance(id, completedNodeId, output, req.user!.userId, undefined, resolveTenantFromRequest(req))
    const instance = await withTenantDbTransaction(prisma, (tx) => tx.workflowInstance.findUnique({
      where: { id },
      include: { nodes: true, edges: true },
    }), resolveTenantFromRequest(req))
    res.json(instance)
  } catch (err) {
    next(err)
  }
})

// Start instance (activate initial nodes)
workflowInstancesRouter.post('/:id/start', async (req, res, next) => {
  try {
    await assertInstancePermission(req.user!.userId, req.params.id, 'start')
    const started = await startInstance(req.params.id, req.user!.userId, resolveTenantFromRequest(req))
    const instance = await withTenantDbTransaction(prisma, (tx) => tx.workflowInstance.findUniqueOrThrow({ where: { id: req.params.id } }), resolveTenantFromRequest(req))
    res.json({ ...instance, startNodes: started.startNodes })
  } catch (err) {
    next(err)
  }
})

workflowInstancesRouter.post('/:id/pause', async (req, res, next) => {
  try {
    await assertInstancePermission(req.user!.userId, req.params.id, 'edit')
    await pauseInstance(req.params.id, req.user!.userId, resolveTenantFromRequest(req))
    const instance = await withTenantDbTransaction(prisma, (tx) => tx.workflowInstance.findUnique({ where: { id: req.params.id } }), resolveTenantFromRequest(req))
    res.json(instance)
  } catch (err) {
    next(err)
  }
})

workflowInstancesRouter.post('/:id/resume', async (req, res, next) => {
  try {
    await assertInstancePermission(req.user!.userId, req.params.id, 'edit')
    await resumeInstance(req.params.id, req.user!.userId, resolveTenantFromRequest(req))
    const instance = await withTenantDbTransaction(prisma, (tx) => tx.workflowInstance.findUnique({ where: { id: req.params.id } }), resolveTenantFromRequest(req))
    res.json(instance)
  } catch (err) {
    next(err)
  }
})

// Take over a run: reassign ownership to the acting user so THEIR runtime drives it
// (dial-in routing + git creds key on the owner), then resume if paused. The new
// owner's runtime materializes wi/<workCode> from origin (M81 continuity) — cloning
// the work branch when it isn't present locally — so work resumes on any machine.
// The original creator is preserved in context._globals.originalCreatedById for audit.
workflowInstancesRouter.post('/:id/take-over', async (req, res, next) => {
  try {
    const id = req.params.id as string
    const userId = req.user!.userId
    await assertInstancePermission(userId, id, 'edit')
    const tenantId = resolveTenantFromRequest(req)
    const instance = await withTenantDbTransaction(prisma, (tx) => tx.workflowInstance.findUniqueOrThrow({ where: { id } }), tenantId)
    if (instance.createdById === userId) {
      return res.json({ id, ownerId: userId, alreadyOwner: true, status: instance.status })
    }
    const ctx = (instance.context ?? {}) as Record<string, unknown>
    const globals = (ctx._globals && typeof ctx._globals === 'object' && !Array.isArray(ctx._globals))
      ? ctx._globals as Record<string, unknown>
      : {}
    const previousOwnerId = instance.createdById ?? null
    const nextContext = {
      ...ctx,
      _globals: {
        ...globals,
        // Preserve the ORIGINAL creator once (audit + "who started it").
        ...(globals.originalCreatedById ? {} : { originalCreatedById: previousOwnerId }),
        takenOverAt: new Date().toISOString(),
      },
    }
    await withTenantDbTransaction(prisma, async (tx) => {
      await tx.workflowInstance.update({
        where: { id },
        data: { createdById: userId, context: nextContext as Prisma.InputJsonValue },
      })
      await tx.workflowMutation.create({
        data: {
          instanceId: id,
          mutationType: 'INSTANCE_OWNER_CHANGE',
          beforeState: { createdById: previousOwnerId } as Prisma.InputJsonValue,
          afterState: { createdById: userId } as Prisma.InputJsonValue,
          performedById: userId,
        },
      })
    }, tenantId)
    await logEvent('WorkflowTakenOver', 'WorkflowInstance', id, userId, { previousOwnerId })
    // Resume if paused so the new owner's runtime picks it up right away.
    if (instance.status === 'PAUSED') {
      await resumeInstance(id, userId, tenantId)
    }
    const refreshed = await withTenantDbTransaction(prisma, (tx) => tx.workflowInstance.findUniqueOrThrow({
      where: { id }, select: { id: true, status: true, createdById: true },
    }), tenantId)
    res.json({ id, ownerId: refreshed.createdById, previousOwnerId, status: refreshed.status })
  } catch (err) {
    next(err)
  }
})

workflowInstancesRouter.post('/:id/cancel', validate(cancelSchema), async (req, res, next) => {
  try {
    const id = req.params.id as string
    await assertInstancePermission(req.user!.userId, id, 'edit')
    const { reason } = req.body as z.infer<typeof cancelSchema>
    await cancelInstance(id, reason, req.user!.userId, resolveTenantFromRequest(req))
    const instance = await withTenantDbTransaction(prisma, (tx) => tx.workflowInstance.findUnique({ where: { id } }), resolveTenantFromRequest(req))
    res.json(instance)
  } catch (err) {
    next(err)
  }
})

workflowInstancesRouter.get('/:id/mutations', async (req, res, next) => {
  try {
    const pg = parsePagination(req.query as Record<string, unknown>)
    const [mutations, total] = await withTenantDbTransaction(prisma, (tx) => Promise.all([
      tx.workflowMutation.findMany({
        where: { instanceId: req.params.id },
        skip: pg.skip, take: pg.take,
        orderBy: { performedAt: 'desc' },
      }),
      tx.workflowMutation.count({ where: { instanceId: req.params.id } }),
    ]), resolveTenantFromRequest(req))
    res.json(toPageResponse(mutations, total, pg))
  } catch (err) {
    next(err)
  }
})

workflowInstancesRouter.get('/:id/history', async (req, res, next) => {
  try {
    const events = await withTenantDbTransaction(prisma, (tx) => tx.workflowEvent.findMany({
      where: { instanceId: req.params.id },
      orderBy: { occurredAt: 'desc' },
    }), resolveTenantFromRequest(req))
    res.json(events)
  } catch (err) {
    next(err)
  }
})

workflowInstancesRouter.get('/:id/receipts', async (req, res, next) => {
  try {
    const receipts = await prisma.receipt.findMany({
      where: { entityType: 'WorkflowInstance', entityId: req.params.id },
      orderBy: { generatedAt: 'desc' },
    })
    res.json(receipts)
  } catch (err) {
    next(err)
  }
})

// ─── Workflow parameters ───────────────────────────────────────────────────────

const paramDefSchema = z.object({
  id: z.string(),
  key: z.string().min(1),
  label: z.string().min(1),
  type: z.enum(['string', 'number', 'boolean', 'json']),
  required: z.boolean().default(false),
  defaultValue: z.string().optional(),
  description: z.string().optional(),
  enumValues: z.array(z.string()).optional(),
})

const updateParamsSchema = z.object({
  paramDefs: z.array(paramDefSchema).optional(),
  paramValues: z.record(z.unknown()).optional(),
})

workflowInstancesRouter.get('/:id/params', async (req, res, next) => {
  try {
    const instance = await withTenantDbTransaction(prisma, (tx) => tx.workflowInstance.findUnique({ where: { id: req.params.id } }), resolveTenantFromRequest(req))
    if (!instance) throw new NotFoundError('WorkflowInstance', req.params.id)
    const ctx = (instance.context ?? {}) as Record<string, unknown>
    res.json({
      paramDefs: Array.isArray(ctx._paramDefs) ? ctx._paramDefs : [],
      paramValues: (ctx._params && typeof ctx._params === 'object' && !Array.isArray(ctx._params))
        ? ctx._params
        : {},
    })
  } catch (err) {
    next(err)
  }
})

workflowInstancesRouter.patch('/:id/params', validate(updateParamsSchema), async (req, res, next) => {
  try {
    const id = req.params.id as string
    const instance = await withTenantDbTransaction(prisma, (tx) => tx.workflowInstance.findUnique({ where: { id } }), resolveTenantFromRequest(req))
    if (!instance) throw new NotFoundError('WorkflowInstance', id)
    const ctx = (instance.context ?? {}) as Record<string, unknown>
    const { paramDefs, paramValues } = req.body as z.infer<typeof updateParamsSchema>
    if (paramDefs !== undefined) ctx._paramDefs = paramDefs
    if (paramValues !== undefined) ctx._params = { ...(ctx._params as object ?? {}), ...paramValues }
    await withTenantDbTransaction(prisma, (tx) => tx.workflowInstance.update({
      where: { id },
      data: { context: ctx as never },
    }), resolveTenantFromRequest(req))
    res.json({ paramDefs: ctx._paramDefs ?? [], paramValues: ctx._params ?? {} })
  } catch (err) {
    next(err)
  }
})

// ─── Instance globals (INSTANCE-scoped team variable overrides at runtime) ───
//
// Reads the team's TeamVariable rows and the instance's `_globals`, returning a
// merged view that distinguishes which keys are operator-editable (scope =
// INSTANCE) and which are read-only (scope = GLOBAL).  PATCH allows updating
// only the editable ones — GLOBAL-scope keys are silently rejected.

const updateGlobalsSchema = z.object({
  globals: z.record(z.unknown()),
})

workflowInstancesRouter.get('/:id/globals', async (req, res, next) => {
  try {
    const id = req.params.id as string
    const instance = await withTenantDbTransaction(prisma, (tx) => tx.workflowInstance.findUnique({
      where: { id },
      select: { id: true, context: true, templateId: true },
    }), resolveTenantFromRequest(req))
    if (!instance) throw new NotFoundError('WorkflowInstance', id)

    let teamId: string | null = null
    let workflowId: string | null = null
    let capabilityId: string | null = null
    if (instance.templateId) {
      const t = await prisma.workflow.findUnique({
        where: { id: instance.templateId },
        select: { teamId: true, capabilityId: true, id: true },
      })
      teamId       = t?.teamId       ?? null
      workflowId   = t?.id           ?? null
      capabilityId = t?.capabilityId ?? null
    }

    const allVars = teamId
      ? await prisma.teamVariable.findMany({
          where: { teamId },
          select: {
            key: true, label: true, type: true, scope: true, value: true, description: true,
            visibility: true, visibilityScopeId: true, editableBy: true,
          },
        })
      : []
    // Filter to those visible to this run's workflow / capability.
    const teamVars = allVars.filter(v =>
      v.visibility === 'ORG_GLOBAL' ||
      (v.visibility === 'CAPABILITY' && v.visibilityScopeId === capabilityId) ||
      (v.visibility === 'WORKFLOW'   && v.visibilityScopeId === workflowId),
    )

    const ctx = (instance.context ?? {}) as Record<string, unknown>
    const live = (ctx._globals ?? {}) as Record<string, unknown>

    const entries = teamVars.map(v => ({
      key:           v.key,
      label:         v.label,
      type:          v.type,
      scope:         v.scope,
      visibility:    v.visibility,
      editableBy:    v.editableBy,
      teamDefault:   v.value,
      currentValue:  live[v.key] !== undefined ? live[v.key] : v.value,
      description:   v.description,
      // SYSTEM-tagged variables are never user-editable through this endpoint.
      editable:      v.scope === 'INSTANCE' && v.editableBy === 'USER',
    }))

    res.json({ globals: entries })
  } catch (err) { next(err) }
})

workflowInstancesRouter.patch('/:id/globals', validate(updateGlobalsSchema), async (req, res, next) => {
  try {
    const id = req.params.id as string
    await assertInstancePermission(req.user!.userId, id, 'edit')

    const instance = await withTenantDbTransaction(prisma, (tx) => tx.workflowInstance.findUnique({ where: { id } }), resolveTenantFromRequest(req))
    if (!instance) throw new NotFoundError('WorkflowInstance', id)

    // Resolve the team to know which keys are INSTANCE-scoped (overrideable).
    let teamId: string | null = null
    if (instance.templateId) {
      const t = await prisma.workflow.findUnique({
        where: { id: instance.templateId },
        select: { teamId: true },
      })
      teamId = t?.teamId ?? null
    }
    if (!teamId) {
      res.status(400).json({ error: 'Instance is not linked to a team' })
      return
    }

    const teamVars = await prisma.teamVariable.findMany({
      where: { teamId },
      select: { key: true, scope: true, editableBy: true },
    })
    // INSTANCE scope (per-run override allowed) AND editableBy = USER (admin-only
    // SYSTEM rows can't be flipped here).
    const editableKeys = new Set(
      teamVars.filter(v => v.scope === 'INSTANCE' && v.editableBy === 'USER').map(v => v.key),
    )

    const ctx = { ...((instance.context ?? {}) as Record<string, unknown>) }
    const globals = { ...((ctx._globals ?? {}) as Record<string, unknown>) }

    const { globals: incoming } = req.body as z.infer<typeof updateGlobalsSchema>
    const applied: Record<string, unknown> = {}
    const ignored: string[] = []
    for (const [k, v] of Object.entries(incoming)) {
      if (editableKeys.has(k)) {
        globals[k] = v
        applied[k] = v
      } else {
        ignored.push(k)
      }
    }

    ctx._globals = globals
    await withTenantDbTransaction(prisma, (tx) => tx.workflowInstance.update({
      where: { id },
      data: { context: ctx as never },
    }), resolveTenantFromRequest(req))

    await logEvent('InstanceGlobalsUpdated', 'WorkflowInstance', id, req.user!.userId, {
      appliedKeys: Object.keys(applied),
      ignoredKeys: ignored,
    })

    res.json({ globals, applied, ignored })
  } catch (err) { next(err) }
})

// ─── Archive / Restore ────────────────────────────────────────────────────────

workflowInstancesRouter.post('/:id/archive', async (req, res, next) => {
  try {
    await assertInstancePermission(req.user!.userId, req.params.id, 'edit')
    const instance = await withTenantDbTransaction(prisma, (tx) => tx.workflowInstance.update({
      where: { id: req.params.id },
      data: { archivedAt: new Date() },
    }), resolveTenantFromRequest(req))
    await logEvent('InstanceArchived', 'WorkflowInstance', instance.id, req.user!.userId)
    res.json(instance)
  } catch (err) { next(err) }
})

workflowInstancesRouter.post('/:id/restore', async (req, res, next) => {
  try {
    await assertInstancePermission(req.user!.userId, req.params.id, 'edit')
    const instance = await withTenantDbTransaction(prisma, (tx) => tx.workflowInstance.update({
      where: { id: req.params.id },
      data: { archivedAt: null },
    }), resolveTenantFromRequest(req))
    await logEvent('InstanceRestored', 'WorkflowInstance', instance.id, req.user!.userId)
    res.json(instance)
  } catch (err) { next(err) }
})

// ─── Branch testing (live preview against sample context) ───────────────────

const testBranchesSchema = z.object({
  sourceNodeId:  z.string().uuid(),
  sampleContext: z.record(z.unknown()).default({}),
})

// POST /api/workflow-instances/:id/test-branches
//
// Evaluate the outgoing edges of `sourceNodeId` against `sampleContext` and
// return: which edges match, which would actually fire (with XOR semantics for
// DECISION_GATE), and which is the default branch.  Used by the Branch Test
// preview panel in the Studio.
workflowInstancesRouter.post('/:id/test-branches', validate(testBranchesSchema), async (req, res, next) => {
  try {
    const instanceId = req.params.id as string
    const { sourceNodeId, sampleContext } = req.body as z.infer<typeof testBranchesSchema>

    const sourceNode = await withTenantDbTransaction(prisma, (tx) => tx.workflowNode.findUnique({
      where: { id: sourceNodeId },
      select: { id: true, nodeType: true, instanceId: true },
    }), resolveTenantFromRequest(req))
    if (!sourceNode || sourceNode.instanceId !== instanceId) {
      throw new NotFoundError('WorkflowNode', sourceNodeId)
    }

    const edges = await withTenantDbTransaction(prisma, (tx) => tx.workflowEdge.findMany({
      where: { sourceNodeId, NOT: { edgeType: 'ERROR_BOUNDARY' } },
    }), resolveTenantFromRequest(req))

    type EdgeReport = {
      edgeId:        string
      label:         string | null
      targetNodeId:  string
      priority:      number
      isDefault:     boolean
      matched:       boolean
    }

    const reports: EdgeReport[] = edges.map((edge, idx) => {
      const cond = (edge.condition ?? {}) as Record<string, unknown>
      return {
        edgeId:       edge.id,
        label:        typeof (cond.label as string | undefined) === 'string' ? (cond.label as string) : edge.label,
        targetNodeId: edge.targetNodeId,
        priority:     typeof cond.priority === 'number' ? cond.priority : idx,
        isDefault:    cond.isDefault === true,
        matched:      evaluateEdge(edge, sampleContext),
      }
    })

    const sorted = [...reports].sort((a, b) =>
      a.priority !== b.priority ? a.priority - b.priority : a.edgeId.localeCompare(b.edgeId),
    )

    let firingBranchIds: string[] = []
    if (sourceNode.nodeType === 'DECISION_GATE') {
      const winner = sorted.find(r => !r.isDefault && r.matched)
      if (winner) firingBranchIds = [winner.edgeId]
      else {
        const def = sorted.find(r => r.isDefault)
        if (def) firingBranchIds = [def.edgeId]
      }
    } else if (sourceNode.nodeType === 'INCLUSIVE_GATEWAY') {
      const matches = sorted.filter(r => !r.isDefault && r.matched)
      if (matches.length > 0) firingBranchIds = matches.map(m => m.edgeId)
      else {
        const def = sorted.find(r => r.isDefault)
        if (def) firingBranchIds = [def.edgeId]
      }
    } else {
      firingBranchIds = sorted.filter(r => !r.isDefault && r.matched).map(r => r.edgeId)
    }

    res.json({
      sourceNodeType: sourceNode.nodeType,
      branches:       reports,
      firingBranchIds,
      defaultBranchId: reports.find(r => r.isDefault)?.edgeId ?? null,
    })
  } catch (err) { next(err) }
})

// ─── Pending executions (client / edge / external location) ──────────────────

// GET /api/workflow-instances/:id/pending-executions?location=CLIENT
workflowInstancesRouter.get('/:id/pending-executions', async (req, res, next) => {
  try {
    const location = (req.query.location as string | undefined)?.toUpperCase()
    const pending = await withTenantDbTransaction(prisma, (tx) => tx.pendingExecution.findMany({
      where: {
        instanceId: req.params.id,
        completedAt: null,
        expiresAt: { gt: new Date() },
        ...(location ? { location: location as any } : {}),
      },
      include: { node: { select: { nodeType: true, label: true, config: true } } },
      orderBy: { createdAt: 'asc' },
    }), resolveTenantFromRequest(req))
    // Never leak claimToken here — it is the capability secret handed out ONLY at
    // /claim, and required at /complete. Exposing it in a list would let any poller
    // complete/overwrite another runner's work.
    res.json(pending.map(({ claimToken: _claimToken, ...rest }) => rest))
  } catch (err) { next(err) }
})

// GET /api/workflow-instances/pending-executions?location=CLIENT — poll across all instances
workflowInstancesRouter.get('/pending-executions/poll', async (req, res, next) => {
  try {
    const location = ((req.query.location as string) ?? 'CLIENT').toUpperCase()
    const requestTenant = resolveTenantFromRequest(req)
    if (tenantIsolationStrict() && !requestTenant) {
      throw new ValidationError('TENANT_ISOLATION_MODE=strict requires X-Tenant-Id or tenant_id when polling pending executions')
    }
    // Poll is per-tenant, not a cross-tenant system worker (strict mode requires a
    // request tenant above), so scoping the read to requestTenant is correct and,
    // under FORCE RLS, returns exactly the same same-tenant set the manual filter
    // below computes. Under non-strict/pre-cutover, requestTenant may be undefined →
    // no GUC set → all rows, identical to prior behavior.
    const pendingRaw = await withTenantDbTransaction(prisma, (tx) => tx.pendingExecution.findMany({
      where: { location: location as any, completedAt: null, expiresAt: { gt: new Date() } },
      include: {
        node: { select: { nodeType: true, label: true, config: true } },
        instance: { select: { name: true, status: true, tenantId: true, context: true } },
      },
      orderBy: { createdAt: 'asc' },
      take: tenantIsolationStrict() ? 200 : 50,
    }), requestTenant)
    const pending = tenantIsolationStrict()
      ? pendingRaw
          .filter(exec => (exec.instance.tenantId ?? resolveTenantFromContext(exec.instance.context)) === requestTenant)
          .slice(0, 50)
      : pendingRaw
    const shaped = pending.map(exec => {
      const { context: _context, tenantId: _tenantId, ...instance } = exec.instance
      // Strip claimToken — it is minted and revealed ONLY at /claim (see below).
      const { claimToken: _claimToken, ...rest } = exec
      return { ...rest, instance }
    })
    res.json(shaped)
  } catch (err) { next(err) }
})

// POST /api/workflow-instances/pending-executions/:execId/claim
// Atomic claim: exactly one runner can take an unclaimed, uncompleted, unexpired
// row (updateMany → count===1 wins; everyone else gets 409). A fresh claimToken is
// minted here and returned ONLY to the winner — it is the capability the runner must
// present at /complete, so a second runner that saw the same row via /poll cannot
// claim it or complete another runner's work.
workflowInstancesRouter.post('/pending-executions/:execId/claim', async (req, res, next) => {
  try {
    await assertPendingExecutionTenant(req, req.params.execId)
    const tenant = resolveTenantFromRequest(req)
    const claimToken = randomUUID()
    const claimed = await withTenantDbTransaction(prisma, (tx) => tx.pendingExecution.updateMany({
      where: { id: req.params.execId, claimedAt: null, completedAt: null, expiresAt: { gt: new Date() } },
      data: { claimedAt: new Date(), claimedBy: req.user?.userId, claimToken },
    }), tenant)
    if (claimed.count !== 1) {
      return res.status(409).json({ error: 'Pending execution is already claimed, completed, or expired.' })
    }
    const exec = await withTenantDbTransaction(prisma, (tx) => tx.pendingExecution.findUnique({
      where: { id: req.params.execId },
    }), tenant)
    res.json(exec) // includes the fresh claimToken — the runner keeps it for /complete
  } catch (err) { next(err) }
})

// POST /api/workflow-instances/pending-executions/:execId/complete
// Token-gated + single-shot: only the holder of the matching claimToken can complete,
// and only once (completedAt: null). A wrong/absent token, an unclaimed row, or an
// already-completed row matches nothing → 409 — never an overwrite or a double-advance.
workflowInstancesRouter.post('/pending-executions/:execId/complete', async (req, res, next) => {
  try {
    await assertPendingExecutionTenant(req, req.params.execId)
    const { result, error, claimToken } = req.body as { result?: Record<string, unknown>; error?: string; claimToken?: string }
    if (!claimToken || typeof claimToken !== 'string') {
      throw new ValidationError('claimToken is required to complete a pending execution (obtain it from /claim).')
    }
    const tenant = resolveTenantFromRequest(req)
    const done = await withTenantDbTransaction(prisma, (tx) => tx.pendingExecution.updateMany({
      where: { id: req.params.execId, claimToken, completedAt: null },
      data: { completedAt: new Date(), result: result as any, error },
    }), tenant)
    if (done.count !== 1) {
      return res.status(409).json({ error: 'Pending execution is not claimed with this token, or is already completed.' })
    }
    const exec = await withTenantDbTransaction(prisma, (tx) => tx.pendingExecution.findUnique({
      where: { id: req.params.execId },
    }), tenant)
    if (!exec) return res.status(409).json({ error: 'Pending execution not found after completion.' })
    if (!error) {
      // Advance the workflow from this node. Finding #7 — pass the attempt this pending
      // execution was dispatched under so a result from a superseded attempt is rejected.
      await advance(exec.instanceId, exec.nodeId, result ?? {}, req.user?.userId, exec.attempt, tenant)
    } else {
      await failNode(exec.instanceId, exec.nodeId, { message: error }, req.user?.userId, tenant)
    }
    res.json(exec)
  } catch (err) { next(err) }
})

// ─────────────────────────────────────────────────────────────────────
// Live event tap (M9.y) — proxies to context-fabric's events store.
// Same surface for poll (`?since_id=`) and live (SSE) consumers.
// ─────────────────────────────────────────────────────────────────────

// Under strict tenant isolation, scope CF reads to the instance's tenant — the
// same value AgentTaskExecutor sends to CF at run time, so the read filter
// matches stored rows (symmetric). In 'off' mode (default) tenant_id is unset
// on both the write and read side, so this returns undefined and CF reads stay
// unfiltered — no behaviour change.
async function resolveInstanceTenantForCfRead(instanceId: string, tenantId?: string): Promise<string | undefined> {
  if (config.TENANT_ISOLATION_MODE !== 'strict') return undefined
  const inst = await withTenantDbTransaction(prisma, (tx) => tx.workflowInstance.findUnique({
    where: { id: instanceId },
    select: { context: true },
  }), tenantId)
  return resolveRuntimeTenantId({ instanceContext: inst?.context })
}

// GET /api/workflow-instances/:id/events?since_id=&limit=
workflowInstancesRouter.get('/:id/events', async (req, res, next) => {
  try {
    await assertInstancePermission(req.user!.userId, req.params.id, 'view')
    const url = new URL(`${config.CONTEXT_FABRIC_URL.replace(/\/$/, '')}/execute/events`)
    url.searchParams.set('run_id', req.params.id)
    const eventsTenantId = await resolveInstanceTenantForCfRead(req.params.id, resolveTenantFromRequest(req))
    if (eventsTenantId) url.searchParams.set('tenant_id', eventsTenantId)
    if (typeof req.query.since_id === 'string') url.searchParams.set('since_id', req.query.since_id)
    if (typeof req.query.since_timestamp === 'string') url.searchParams.set('since_timestamp', req.query.since_timestamp)
    if (typeof req.query.limit === 'string') url.searchParams.set('limit', req.query.limit)
    const r = await fetch(url, {
      headers: contextFabricServiceHeaders(),
      signal: AbortSignal.timeout(15_000),
    })
    const body = await r.text()
    res.status(r.status).type(r.headers.get('content-type') || 'application/json').send(body)
  } catch (err) { next(err) }
})

// GET /api/workflow-instances/:id/events/stream?since_id=&max_idle_seconds=
//
// Server-Sent Events pass-through. We hold the upstream connection open and
// pipe each chunk to the browser. Browsers can't add `Authorization` to an
// EventSource handshake, so this endpoint authenticates via the workgraph
// JWT (existing authMiddleware) and then uses Workgraph's Context Fabric
// service token for the backend hop.
workflowInstancesRouter.get('/:id/events/stream', async (req, res, next) => {
  try {
    await assertInstancePermission(req.user!.userId, req.params.id, 'view')

    // We need a trace_id; context-fabric's stream is keyed by trace_id today
    // (whereas /events accepts run_id). Look up the most recent CallLog row
    // for this workflow instance, take its trace_id.
    const streamTenantId = await resolveInstanceTenantForCfRead(req.params.id, resolveTenantFromRequest(req))
    const callsUrl = new URL(`${config.CONTEXT_FABRIC_URL.replace(/\/$/, '')}/execute/calls`)
    callsUrl.searchParams.set('workflow_run_id', req.params.id)
    callsUrl.searchParams.set('limit', '1')
    if (streamTenantId) callsUrl.searchParams.set('tenant_id', streamTenantId)
    const callsResp = await fetch(callsUrl, {
      headers: contextFabricServiceHeaders(),
      signal: AbortSignal.timeout(10_000),
    })
    if (!callsResp.ok) {
      res.status(502).json({ error: 'context-fabric unreachable for call lookup' })
      return
    }
    const parsedCalls = await readWorkflowJsonResponse<{ items?: Array<{ trace_id?: string }> }>(
      callsResp,
      'context-fabric call lookup',
    )
    if (parsedCalls.error) {
      res.status(502).json({ error: 'context-fabric invalid call lookup response', detail: parsedCalls.error, raw: parsedCalls.raw })
      return
    }
    const callsBody = parsedCalls.data ?? {}
    const traceId = callsBody.items?.[0]?.trace_id
    if (!traceId) {
      res.status(404).json({ error: 'no trace recorded for this workflow instance yet' })
      return
    }

    const sseUrl = new URL(`${config.CONTEXT_FABRIC_URL.replace(/\/$/, '')}/execute/events/stream`)
    sseUrl.searchParams.set('trace_id', traceId)
    if (streamTenantId) sseUrl.searchParams.set('tenant_id', streamTenantId)
    if (typeof req.query.since_id === 'string') sseUrl.searchParams.set('since_id', req.query.since_id)
    if (typeof req.query.max_idle_seconds === 'string') sseUrl.searchParams.set('max_idle_seconds', req.query.max_idle_seconds)
    if (typeof req.query.poll_interval_ms === 'string') sseUrl.searchParams.set('poll_interval_ms', req.query.poll_interval_ms)

    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',  // disable nginx buffering if proxied
    })
    res.flushHeaders?.()

    const upstream = await fetch(sseUrl, {
      headers: contextFabricServiceHeaders(),
      signal: AbortSignal.timeout(600_000),
    })
    if (!upstream.ok || !upstream.body) {
      res.write(`event: error\ndata: ${JSON.stringify({ status: upstream.status })}\n\n`)
      res.end()
      return
    }
    const reader = upstream.body.getReader()
    const decoder = new TextDecoder()
    // M35.4 — log SSE reader cancellation failures so stuck connections are visible
    req.on('close', () => {
      reader.cancel().catch((err) => {
        req.log?.warn?.({ err: (err as Error).message },
          '[instances] SSE reader.cancel() failed after client close')
      })
    })
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      res.write(decoder.decode(value, { stream: true }))
    }
    res.end()
  } catch (err) { next(err) }
})
