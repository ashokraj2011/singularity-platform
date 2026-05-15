import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../lib/prisma'
import { validate } from '../../middleware/validate'
import { parsePagination, toPageResponse } from '../../lib/pagination'
import { NotFoundError } from '../../lib/errors'
import { logEvent, createReceipt, publishOutbox } from '../../lib/audit'
import { advance, pauseInstance, resumeInstance, cancelInstance, failNode, startInstance } from './runtime/WorkflowRuntime'
import { evaluateEdge } from './runtime/EdgeEvaluator'
import { assertTemplatePermission, assertInstancePermission } from '../../lib/permissions/workflowTemplate'
import { cloneDesignToRun } from './lib/cloneDesignToRun'
import { getWorkflowBudgetOverview } from './runtime/budget'

export const workflowInstancesRouter: Router = Router()

const createInstanceSchema = z.object({
  templateId: z.string().uuid().optional(),
  initiativeId: z.string().uuid().optional(),
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
  nodeType: z.enum(['HUMAN_TASK', 'AGENT_TASK', 'WORKBENCH_TASK', 'APPROVAL', 'DECISION_GATE', 'CONSUMABLE_CREATION', 'TOOL_REQUEST', 'POLICY_CHECK', 'TIMER', 'SIGNAL_WAIT', 'CALL_WORKFLOW', 'WORK_ITEM', 'FOREACH', 'INCLUSIVE_GATEWAY', 'EVENT_GATEWAY', 'CUSTOM']),
  label: z.string().min(1),
  config: z.record(z.unknown()).default({}),
  positionX: z.number().default(0),
  positionY: z.number().default(0),
})

const updateNodeSchema = z.object({
  label: z.string().min(1).optional(),
  config: z.record(z.unknown()).optional(),
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

const createPhaseSchema = z.object({
  name: z.string().min(1),
  displayOrder: z.number().int().default(0),
  color: z.string().optional(),
})

const advanceSchema = z.object({
  completedNodeId: z.string().uuid(),
  output: z.record(z.unknown()).default({}),
})

const cancelSchema = z.object({
  reason: z.string().max(500).optional(),
})

workflowInstancesRouter.delete('/:id', async (req, res, next) => {
  try {
    const id = req.params.id as string
    await assertInstancePermission(req.user!.userId, id, 'edit')
    await prisma.workflowInstance.delete({ where: { id } })
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
      const result = await cloneDesignToRun({
        templateId:   body.templateId,
        name:         body.name,
        vars:         body.vars,
        globals:      body.globals,
        budgetOverride: body.budgetOverride,
        createdById:  req.user!.userId,
        initiativeId: body.initiativeId,
      })
      await logEvent('WorkflowRunCreated', 'WorkflowInstance', result.instance.id, req.user!.userId, {
        templateId: body.templateId, cloned: result.cloned, via: 'instances.post',
      })
      await publishOutbox('WorkflowInstance', result.instance.id, 'WorkflowRunCreated', {
        instanceId: result.instance.id, templateId: body.templateId,
      })
      await startInstance(result.instance.id, req.user!.userId)

      const full = await prisma.workflowInstance.findUnique({
        where: { id: result.instance.id },
        include: { phases: true, nodes: true, edges: true },
      })
      res.status(201).json(full)
      return
    }

    // No templateId — create a blank instance (rare; mostly used for tests).
    const { vars: _ignoreVars, globals: _ignoreGlobals, ...persistable } = body
    const instance = await prisma.workflowInstance.create({
      data: {
        ...persistable,
        createdById: req.user!.userId,
      },
      include: { phases: true, nodes: true, edges: true },
    })
    await logEvent('WorkflowStarted', 'WorkflowInstance', instance.id, req.user!.userId)
    await publishOutbox('WorkflowInstance', instance.id, 'WorkflowStarted', { instanceId: instance.id })
    res.status(201).json(instance)
  } catch (err) {
    next(err)
  }
})

workflowInstancesRouter.get('/', async (req, res, next) => {
  try {
    const pg = parsePagination(req.query as Record<string, unknown>)
    const { initiativeId } = req.query
    const where = initiativeId ? { initiativeId: String(initiativeId) } : {}
    const [instances, total] = await Promise.all([
      prisma.workflowInstance.findMany({ where, skip: pg.skip, take: pg.take, orderBy: { createdAt: 'desc' } }),
      prisma.workflowInstance.count({ where }),
    ])
    res.json(toPageResponse(instances, total, pg))
  } catch (err) {
    next(err)
  }
})

workflowInstancesRouter.get('/:id', async (req, res, next) => {
  try {
    const instance = await prisma.workflowInstance.findUnique({
      where: { id: req.params.id },
      include: { phases: { orderBy: { displayOrder: 'asc' } }, nodes: true, edges: true },
    })
    if (!instance) throw new NotFoundError('WorkflowInstance', req.params.id)
    res.json(instance)
  } catch (err) {
    next(err)
  }
})

workflowInstancesRouter.get('/:id/budget', async (req, res, next) => {
  try {
    await assertInstancePermission(req.user!.userId, req.params.id, 'view')
    const budget = await getWorkflowBudgetOverview(req.params.id)
    res.json(budget)
  } catch (err) {
    next(err)
  }
})

workflowInstancesRouter.post('/:id/phases', validate(createPhaseSchema), async (req, res, next) => {
  try {
    const id = req.params.id as string
    const phase = await prisma.workflowPhase.create({
      data: { instanceId: id, ...req.body },
    })
    await logEvent('PhaseAdded', 'WorkflowPhase', phase.id, req.user!.userId, { instanceId: id })
    await prisma.workflowMutation.create({
      data: {
        instanceId: id,
        mutationType: 'PHASE_ADDED',
        afterState: { phaseId: phase.id, name: phase.name },
        performedById: req.user!.userId,
      },
    })
    await publishOutbox('WorkflowInstance', id, 'PhaseAdded', { phaseId: phase.id })
    res.status(201).json(phase)
  } catch (err) {
    next(err)
  }
})

workflowInstancesRouter.get('/:id/nodes', async (req, res, next) => {
  try {
    const nodes = await prisma.workflowNode.findMany({
      where: { instanceId: req.params.id },
      orderBy: { createdAt: 'asc' },
    })
    res.json(nodes)
  } catch (err) {
    next(err)
  }
})

// Single-node fetch used by the runtime detail page to pull formSections
// without re-downloading the whole graph.
workflowInstancesRouter.get('/:id/nodes/:nodeId', async (req, res, next) => {
  try {
    const node = await prisma.workflowNode.findFirst({
      where: { id: req.params.nodeId as string, instanceId: req.params.id as string },
    })
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
    const node = await prisma.workflowNode.create({
      data: { instanceId: id, ...req.body },
    })
    await logEvent('NodeAdded', 'WorkflowNode', node.id, req.user!.userId, { instanceId: id })
    await prisma.workflowMutation.create({
      data: {
        instanceId: id,
        nodeId: node.id,
        mutationType: 'NODE_ADDED',
        afterState: { nodeType: node.nodeType, label: node.label },
        performedById: req.user!.userId,
      },
    })
    res.status(201).json(node)
  } catch (err) {
    next(err)
  }
})

workflowInstancesRouter.patch('/:id/nodes/:nodeId', validate(updateNodeSchema), async (req, res, next) => {
  try {
    const id = req.params.id as string
    const nodeId = req.params.nodeId as string
    const before = await prisma.workflowNode.findUnique({ where: { id: nodeId } })
    const node = await prisma.workflowNode.update({
      where: { id: nodeId },
      data: req.body,
    })
    await prisma.workflowMutation.create({
      data: {
        instanceId: id,
        nodeId: node.id,
        mutationType: 'NODE_UPDATED',
        beforeState: before ? { config: before.config, positionX: before.positionX, positionY: before.positionY } : undefined,
        afterState: { config: node.config, positionX: node.positionX, positionY: node.positionY },
        performedById: req.user!.userId,
      },
    })
    res.json(node)
  } catch (err) {
    next(err)
  }
})

workflowInstancesRouter.delete('/:id/nodes/:nodeId', async (req, res, next) => {
  try {
    await prisma.workflowNode.delete({ where: { id: req.params.nodeId } })
    await prisma.workflowMutation.create({
      data: {
        instanceId: req.params.id,
        nodeId: req.params.nodeId,
        mutationType: 'NODE_REMOVED',
        performedById: req.user!.userId,
      },
    })
    res.status(204).end()
  } catch (err) {
    next(err)
  }
})

workflowInstancesRouter.get('/:id/edges', async (req, res, next) => {
  try {
    const edges = await prisma.workflowEdge.findMany({ where: { instanceId: req.params.id } })
    res.json(edges)
  } catch (err) {
    next(err)
  }
})

workflowInstancesRouter.post('/:id/edges', validate(createEdgeSchema), async (req, res, next) => {
  try {
    const edge = await prisma.workflowEdge.create({
      data: { instanceId: req.params.id, ...req.body },
    })
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
    const edge = await prisma.workflowEdge.update({
      where: { id: req.params.edgeId as string },
      data: req.body,
    })
    res.json(edge)
  } catch (err) {
    next(err)
  }
})

workflowInstancesRouter.delete('/:id/edges/:edgeId', async (req, res, next) => {
  try {
    await prisma.workflowEdge.delete({ where: { id: req.params.edgeId } })
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

    const candidates = await prisma.workflowNode.findMany({
      where: { instanceId: id, nodeType: 'SIGNAL_WAIT', status: 'ACTIVE' },
    })
    const matched = candidates.filter(n => {
      const cfg = (n.config ?? {}) as Record<string, unknown>
      if (cfg.signalName !== signalName) return false
      if (correlationKey && cfg.correlationKey && cfg.correlationKey !== correlationKey) return false
      return true
    })

    for (const node of matched) {
      await advance(id, node.id, { _signal: { name: signalName, payload, correlationKey } }, req.user!.userId)
    }
    res.json({ advancedNodeIds: matched.map(n => n.id), signalName })
  } catch (err) {
    next(err)
  }
})

workflowInstancesRouter.post('/:id/nodes/:nodeId/fail', validate(failNodeSchema), async (req, res, next) => {
  try {
    const id = req.params.id as string
    const nodeId = req.params.nodeId as string
    const failure = req.body as z.infer<typeof failNodeSchema>
    const result = await failNode(id, nodeId, failure, req.user!.userId)
    const node = await prisma.workflowNode.findUnique({ where: { id: nodeId } })
    res.json({ ...result, node })
  } catch (err) {
    next(err)
  }
})

workflowInstancesRouter.post('/:id/advance', validate(advanceSchema), async (req, res, next) => {
  try {
    const id = req.params.id as string
    const { completedNodeId, output } = req.body as z.infer<typeof advanceSchema>
    await advance(id, completedNodeId, output, req.user!.userId)
    const instance = await prisma.workflowInstance.findUnique({
      where: { id },
      include: { nodes: true, edges: true },
    })
    res.json(instance)
  } catch (err) {
    next(err)
  }
})

// Start instance (activate initial nodes)
workflowInstancesRouter.post('/:id/start', async (req, res, next) => {
  try {
    await assertInstancePermission(req.user!.userId, req.params.id, 'start')
    const started = await startInstance(req.params.id, req.user!.userId)
    const instance = await prisma.workflowInstance.findUniqueOrThrow({ where: { id: req.params.id } })
    res.json({ ...instance, startNodes: started.startNodes })
  } catch (err) {
    next(err)
  }
})

workflowInstancesRouter.post('/:id/pause', async (req, res, next) => {
  try {
    await assertInstancePermission(req.user!.userId, req.params.id, 'edit')
    await pauseInstance(req.params.id, req.user!.userId)
    const instance = await prisma.workflowInstance.findUnique({ where: { id: req.params.id } })
    res.json(instance)
  } catch (err) {
    next(err)
  }
})

workflowInstancesRouter.post('/:id/resume', async (req, res, next) => {
  try {
    await assertInstancePermission(req.user!.userId, req.params.id, 'edit')
    await resumeInstance(req.params.id, req.user!.userId)
    const instance = await prisma.workflowInstance.findUnique({ where: { id: req.params.id } })
    res.json(instance)
  } catch (err) {
    next(err)
  }
})

workflowInstancesRouter.post('/:id/cancel', validate(cancelSchema), async (req, res, next) => {
  try {
    const id = req.params.id as string
    await assertInstancePermission(req.user!.userId, id, 'edit')
    const { reason } = req.body as z.infer<typeof cancelSchema>
    await cancelInstance(id, reason, req.user!.userId)
    const instance = await prisma.workflowInstance.findUnique({ where: { id } })
    res.json(instance)
  } catch (err) {
    next(err)
  }
})

workflowInstancesRouter.get('/:id/mutations', async (req, res, next) => {
  try {
    const pg = parsePagination(req.query as Record<string, unknown>)
    const [mutations, total] = await Promise.all([
      prisma.workflowMutation.findMany({
        where: { instanceId: req.params.id },
        skip: pg.skip, take: pg.take,
        orderBy: { performedAt: 'desc' },
      }),
      prisma.workflowMutation.count({ where: { instanceId: req.params.id } }),
    ])
    res.json(toPageResponse(mutations, total, pg))
  } catch (err) {
    next(err)
  }
})

workflowInstancesRouter.get('/:id/history', async (req, res, next) => {
  try {
    const events = await prisma.workflowEvent.findMany({
      where: { instanceId: req.params.id },
      orderBy: { occurredAt: 'desc' },
    })
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
    const instance = await prisma.workflowInstance.findUnique({ where: { id: req.params.id } })
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
    const instance = await prisma.workflowInstance.findUnique({ where: { id } })
    if (!instance) throw new NotFoundError('WorkflowInstance', id)
    const ctx = (instance.context ?? {}) as Record<string, unknown>
    const { paramDefs, paramValues } = req.body as z.infer<typeof updateParamsSchema>
    if (paramDefs !== undefined) ctx._paramDefs = paramDefs
    if (paramValues !== undefined) ctx._params = { ...(ctx._params as object ?? {}), ...paramValues }
    await prisma.workflowInstance.update({
      where: { id },
      data: { context: ctx as never },
    })
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
    const instance = await prisma.workflowInstance.findUnique({
      where: { id },
      select: { id: true, context: true, templateId: true },
    })
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

    const instance = await prisma.workflowInstance.findUnique({ where: { id } })
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
    await prisma.workflowInstance.update({
      where: { id },
      data: { context: ctx as never },
    })

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
    const instance = await prisma.workflowInstance.update({
      where: { id: req.params.id },
      data: { archivedAt: new Date() },
    })
    await logEvent('InstanceArchived', 'WorkflowInstance', instance.id, req.user!.userId)
    res.json(instance)
  } catch (err) { next(err) }
})

workflowInstancesRouter.post('/:id/restore', async (req, res, next) => {
  try {
    await assertInstancePermission(req.user!.userId, req.params.id, 'edit')
    const instance = await prisma.workflowInstance.update({
      where: { id: req.params.id },
      data: { archivedAt: null },
    })
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

    const sourceNode = await prisma.workflowNode.findUnique({
      where: { id: sourceNodeId },
      select: { id: true, nodeType: true, instanceId: true },
    })
    if (!sourceNode || sourceNode.instanceId !== instanceId) {
      throw new NotFoundError('WorkflowNode', sourceNodeId)
    }

    const edges = await prisma.workflowEdge.findMany({
      where: { sourceNodeId, NOT: { edgeType: 'ERROR_BOUNDARY' } },
    })

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
    const pending = await prisma.pendingExecution.findMany({
      where: {
        instanceId: req.params.id,
        completedAt: null,
        expiresAt: { gt: new Date() },
        ...(location ? { location: location as any } : {}),
      },
      include: { node: { select: { nodeType: true, label: true, config: true } } },
      orderBy: { createdAt: 'asc' },
    })
    res.json(pending)
  } catch (err) { next(err) }
})

// GET /api/workflow-instances/pending-executions?location=CLIENT — poll across all instances
workflowInstancesRouter.get('/pending-executions/poll', async (req, res, next) => {
  try {
    const location = ((req.query.location as string) ?? 'CLIENT').toUpperCase()
    const pending = await prisma.pendingExecution.findMany({
      where: { location: location as any, completedAt: null, expiresAt: { gt: new Date() } },
      include: {
        node: { select: { nodeType: true, label: true, config: true } },
        instance: { select: { name: true, status: true } },
      },
      orderBy: { createdAt: 'asc' },
      take: 50,
    })
    res.json(pending)
  } catch (err) { next(err) }
})

// POST /api/workflow-instances/pending-executions/:execId/claim
workflowInstancesRouter.post('/pending-executions/:execId/claim', async (req, res, next) => {
  try {
    const exec = await prisma.pendingExecution.update({
      where: { id: req.params.execId, completedAt: null },
      data: { claimedAt: new Date(), claimedBy: req.user?.userId },
    })
    res.json(exec)
  } catch (err) { next(err) }
})

// POST /api/workflow-instances/pending-executions/:execId/complete
workflowInstancesRouter.post('/pending-executions/:execId/complete', async (req, res, next) => {
  try {
    const { result, error } = req.body as { result?: Record<string, unknown>; error?: string }
    const exec = await prisma.pendingExecution.update({
      where: { id: req.params.execId },
      data: { completedAt: new Date(), result: result as any, error },
    })
    if (!error) {
      // Advance the workflow from this node
      await advance(exec.instanceId, exec.nodeId, result ?? {}, req.user?.userId)
    } else {
      await failNode(exec.instanceId, exec.nodeId, { message: error }, req.user?.userId)
    }
    res.json(exec)
  } catch (err) { next(err) }
})

// ─────────────────────────────────────────────────────────────────────
// Live event tap (M9.y) — proxies to context-fabric's events store.
// Same surface for poll (`?since_id=`) and live (SSE) consumers.
// ─────────────────────────────────────────────────────────────────────
import { config } from '../../config'

// GET /api/workflow-instances/:id/events?since_id=&limit=
workflowInstancesRouter.get('/:id/events', async (req, res, next) => {
  try {
    await assertInstancePermission(req.user!.userId, req.params.id, 'view')
    const url = new URL(`${config.CONTEXT_FABRIC_URL.replace(/\/$/, '')}/execute/events`)
    url.searchParams.set('run_id', req.params.id)
    if (typeof req.query.since_id === 'string') url.searchParams.set('since_id', req.query.since_id)
    if (typeof req.query.since_timestamp === 'string') url.searchParams.set('since_timestamp', req.query.since_timestamp)
    if (typeof req.query.limit === 'string') url.searchParams.set('limit', req.query.limit)
    const r = await fetch(url, { signal: AbortSignal.timeout(15_000) })
    const body = await r.text()
    res.status(r.status).type(r.headers.get('content-type') || 'application/json').send(body)
  } catch (err) { next(err) }
})

// GET /api/workflow-instances/:id/events/stream?since_id=&max_idle_seconds=
//
// Server-Sent Events pass-through. We hold the upstream connection open and
// pipe each chunk to the browser. Browsers can't add `Authorization` to an
// EventSource handshake, so this endpoint authenticates via the workgraph
// JWT (existing authMiddleware) and then upstream calls context-fabric on
// the user's behalf — context-fabric's stream endpoint is open today
// (it's behind context-fabric's network boundary). When IAM federation
// for context-fabric lands, we'll forward a service token instead.
workflowInstancesRouter.get('/:id/events/stream', async (req, res, next) => {
  try {
    await assertInstancePermission(req.user!.userId, req.params.id, 'view')

    // We need a trace_id; context-fabric's stream is keyed by trace_id today
    // (whereas /events accepts run_id). Look up the most recent CallLog row
    // for this workflow instance, take its trace_id.
    const callsUrl = new URL(`${config.CONTEXT_FABRIC_URL.replace(/\/$/, '')}/execute/calls`)
    callsUrl.searchParams.set('workflow_run_id', req.params.id)
    callsUrl.searchParams.set('limit', '1')
    const callsResp = await fetch(callsUrl, { signal: AbortSignal.timeout(10_000) })
    if (!callsResp.ok) {
      res.status(502).json({ error: 'context-fabric unreachable for call lookup' })
      return
    }
    const callsBody = (await callsResp.json()) as { items?: Array<{ trace_id?: string }> }
    const traceId = callsBody.items?.[0]?.trace_id
    if (!traceId) {
      res.status(404).json({ error: 'no trace recorded for this workflow instance yet' })
      return
    }

    const sseUrl = new URL(`${config.CONTEXT_FABRIC_URL.replace(/\/$/, '')}/execute/events/stream`)
    sseUrl.searchParams.set('trace_id', traceId)
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

    const upstream = await fetch(sseUrl, { signal: AbortSignal.timeout(600_000) })
    if (!upstream.ok || !upstream.body) {
      res.write(`event: error\ndata: ${JSON.stringify({ status: upstream.status })}\n\n`)
      res.end()
      return
    }
    const reader = upstream.body.getReader()
    const decoder = new TextDecoder()
    req.on('close', () => { reader.cancel().catch(() => {}) })
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      res.write(decoder.decode(value, { stream: true }))
    }
    res.end()
  } catch (err) { next(err) }
})
