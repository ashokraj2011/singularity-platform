import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { withTenantDbTransaction, currentTenantIdForDb } from '../../lib/tenant-db-context'
import { NotFoundError, ValidationError } from '../../lib/errors'
import { publishOutbox } from '../../lib/audit'

type JsonRecord = Record<string, unknown>

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue
}

export async function cloneWorkflowRun(args: {
  instanceId: string
  actorId: string
  checkpointId?: string
  reason?: string
  contextOverrides?: JsonRecord
}) {
  const tenantId = currentTenantIdForDb() ?? 'default'
  const source = await withTenantDbTransaction(prisma, tx => tx.workflowInstance.findUnique({
    where: { id: args.instanceId },
    include: { phases: true, nodes: true, edges: true },
  }), tenantId)
  if (!source) throw new NotFoundError('WorkflowInstance', args.instanceId)

  const checkpoint = args.checkpointId
    ? await withTenantDbTransaction(prisma, tx => tx.workflowCheckpoint.findFirst({ where: { id: args.checkpointId, instanceId: args.instanceId } }), tenantId)
    : null
  if (args.checkpointId && !checkpoint) throw new ValidationError('Checkpoint does not belong to this workflow instance')

  const isolatedContext: JsonRecord = {
    ...record(checkpoint?.context ?? source.context),
    ...record(args.contextOverrides),
    _debugCloneOf: source.id,
    _debugCloneSourceStatus: source.status,
  }
  const cloneRecord = await withTenantDbTransaction(prisma, tx => tx.workflowRunClone.create({
    data: {
      sourceInstanceId: source.id,
      sourceCheckpointId: checkpoint?.id,
      requestedById: args.actorId,
      tenantId,
      reason: args.reason,
      isolatedContext: json(isolatedContext),
    },
  }), tenantId)

  try {
    const created = await withTenantDbTransaction(prisma, async tx => {
      const clone = await tx.workflowInstance.create({
        data: {
          templateId: source.templateId,
          templateVersion: source.templateVersion,
          tenantId,
          name: `${source.name} · diagnostic clone`,
          status: 'DRAFT',
          context: json(isolatedContext),
          profile: source.profile,
          createdById: args.actorId,
        },
      })
      const phaseMap = new Map<string, string>()
      for (const phase of source.phases) {
        const newPhase = await tx.workflowPhase.create({
          data: { instanceId: clone.id, name: phase.name, displayOrder: phase.displayOrder, color: phase.color },
        })
        phaseMap.set(phase.id, newPhase.id)
      }
      const nodeMap = new Map<string, string>()
      for (const node of source.nodes) {
        const newNode = await tx.workflowNode.create({
          data: {
            instanceId: clone.id,
            phaseId: node.phaseId ? phaseMap.get(node.phaseId) : undefined,
            nodeType: node.nodeType,
            nodeTypeKey: node.nodeTypeKey,
            nodeTypeVersion: node.nodeTypeVersion,
            nodeTypeSnapshot: node.nodeTypeSnapshot ?? undefined,
            label: node.label,
            status: 'PENDING',
            config: json(node.config),
            compensationConfig: node.compensationConfig ?? undefined,
            executionLocation: node.executionLocation,
            positionX: node.positionX,
            positionY: node.positionY,
          },
        })
        nodeMap.set(node.id, newNode.id)
      }
      for (const edge of source.edges) {
        const sourceNodeId = nodeMap.get(edge.sourceNodeId)
        const targetNodeId = nodeMap.get(edge.targetNodeId)
        if (!sourceNodeId || !targetNodeId) continue
        await tx.workflowEdge.create({
          data: {
            instanceId: clone.id,
            sourceNodeId,
            targetNodeId,
            edgeType: edge.edgeType,
            condition: edge.condition ?? undefined,
            label: edge.label,
          },
        })
      }
      await tx.workflowRunClone.update({
        where: { id: cloneRecord.id },
        data: { cloneInstanceId: clone.id, status: 'COMPLETED', completedAt: new Date() },
      })
      return clone
    }, tenantId)
    return { clone: created, cloneRecord }
  } catch (error) {
    await withTenantDbTransaction(prisma, tx => tx.workflowRunClone.update({
      where: { id: cloneRecord.id },
      data: { status: 'FAILED', error: error instanceof Error ? error.message : String(error) },
    }), tenantId).catch(() => undefined)
    throw error
  }
}

function graphNodes(snapshot: unknown): Array<JsonRecord & { id?: string }> {
  const raw = record(snapshot)
  const nodes = Array.isArray(raw.nodes) ? raw.nodes : []
  return nodes.filter((node): node is JsonRecord => Boolean(node && typeof node === 'object' && !Array.isArray(node))) as Array<JsonRecord & { id?: string }>
}

export function validateNodeMapping(oldIds: Iterable<string>, newIds: Iterable<string>, nodeMap: Record<string, string>) {
  const oldSet = new Set(oldIds)
  const newSet = new Set(newIds)
  const warnings: string[] = []
  for (const oldId of oldSet) if (!nodeMap[oldId]) warnings.push(`No mapping supplied for old node ${oldId}`)
  for (const [oldId, newId] of Object.entries(nodeMap)) {
    if (!oldSet.has(oldId)) warnings.push(`Mapping references unknown old node ${oldId}`)
    if (!newSet.has(newId)) warnings.push(`Mapping references unknown new node ${newId}`)
  }
  return { warnings, safe: warnings.length === 0 }
}

export async function previewTemplateMigration(args: {
  templateId: string
  fromVersion: number
  toVersion: number
  nodeMap: Record<string, string>
  actorId: string
}) {
  const tenantId = currentTenantIdForDb() ?? 'default'
  const versions = await withTenantDbTransaction(prisma, tx => tx.workflowVersion.findMany({
    where: { templateId: args.templateId, version: { in: [args.fromVersion, args.toVersion] } },
  }), tenantId)
  const from = versions.find(version => version.version === args.fromVersion)
  const to = versions.find(version => version.version === args.toVersion)
  if (!from || !to) throw new ValidationError('Both template versions must exist before migration')
  const oldIds = new Set(graphNodes(from.graphSnapshot).map(node => String(node.id ?? '')).filter(Boolean))
  const newIds = new Set(graphNodes(to.graphSnapshot).map(node => String(node.id ?? '')).filter(Boolean))
  const { warnings, safe } = validateNodeMapping(oldIds, newIds, args.nodeMap)
  return {
    templateId: args.templateId,
    fromVersion: args.fromVersion,
    toVersion: args.toVersion,
    nodeMap: args.nodeMap,
    warnings,
    safe,
  }
}

export async function createTemplateMigration(args: {
  templateId: string
  fromVersion: number
  toVersion: number
  nodeMap: Record<string, string>
  actorId: string
  applyToInFlight?: boolean
}) {
  const preview = await previewTemplateMigration(args)
  if (!preview.safe) throw new ValidationError(`Migration mapping is incomplete: ${preview.warnings.join('; ')}`)
  const tenantId = currentTenantIdForDb() ?? 'default'
  const migration = await withTenantDbTransaction(prisma, tx => tx.workflowTemplateMigration.upsert({
    where: { templateId_fromVersion_toVersion: { templateId: args.templateId, fromVersion: args.fromVersion, toVersion: args.toVersion } },
    create: {
      templateId: args.templateId,
      fromVersion: args.fromVersion,
      toVersion: args.toVersion,
      nodeMap: json(args.nodeMap),
      warnings: json(preview.warnings),
      status: args.applyToInFlight ? 'APPLIED' : 'READY',
      createdById: args.actorId,
      tenantId,
      appliedAt: args.applyToInFlight ? new Date() : undefined,
    },
    update: {
      nodeMap: json(args.nodeMap),
      warnings: json(preview.warnings),
      status: args.applyToInFlight ? 'APPLIED' : 'READY',
      appliedAt: args.applyToInFlight ? new Date() : undefined,
    },
  }), tenantId)

  let migratedRuns = 0
  if (args.applyToInFlight) {
    const active = await withTenantDbTransaction(prisma, tx => tx.workflowInstance.findMany({
      where: { templateId: args.templateId, templateVersion: args.fromVersion, status: { in: ['DRAFT', 'ACTIVE', 'PAUSED'] } },
      select: { id: true, context: true },
    }), tenantId)
    for (const instance of active) {
      const context = record(instance.context)
      await withTenantDbTransaction(prisma, tx => tx.workflowInstance.update({
        where: { id: instance.id },
        data: {
          templateVersion: args.toVersion,
          context: json({ ...context, _templateMigration: { migrationId: migration.id, fromVersion: args.fromVersion, toVersion: args.toVersion, nodeMap: args.nodeMap } }),
        },
      }), tenantId)
      migratedRuns += 1
    }
  }
  return { migration, preview, migratedRuns }
}

export async function createTimeTravelSnapshot(instanceId: string, actorId: string, checkpointId?: string, nodeId?: string) {
  const tenantId = currentTenantIdForDb() ?? 'default'
  const instance = await withTenantDbTransaction(prisma, tx => tx.workflowInstance.findUnique({ where: { id: instanceId } }), tenantId)
  if (!instance) throw new NotFoundError('WorkflowInstance', instanceId)
  const checkpoint = checkpointId
    ? await withTenantDbTransaction(prisma, tx => tx.workflowCheckpoint.findFirst({ where: { id: checkpointId, instanceId } }), tenantId)
    : await withTenantDbTransaction(prisma, tx => tx.workflowCheckpoint.findFirst({ where: { instanceId }, orderBy: { sequence: 'desc' } }), tenantId)
  if (!checkpoint) throw new ValidationError('No checkpoint exists for this workflow instance')
  const [mutations, events, agentRuns] = await Promise.all([
    withTenantDbTransaction(prisma, tx => tx.workflowMutation.findMany({ where: { instanceId }, orderBy: { performedAt: 'asc' } }), tenantId),
    withTenantDbTransaction(prisma, tx => tx.workflowEvent.findMany({ where: { instanceId }, orderBy: { occurredAt: 'asc' } }), tenantId),
    withTenantDbTransaction(prisma, tx => tx.agentRun.findMany({ where: { instanceId }, select: { id: true, nodeId: true, promptAssemblyId: true, traceId: true, createdAt: true }, orderBy: { createdAt: 'asc' } }), tenantId),
  ])
  const cutoff = checkpoint.createdAt.getTime()
  const routingDecisions = mutations.filter(m => /ROUTE|EDGE|DECISION|GATE/i.test(m.mutationType) && m.performedAt.getTime() <= cutoff).map(m => ({ id: m.id, nodeId: m.nodeId, mutationType: m.mutationType, before: m.beforeState, after: m.afterState, at: m.performedAt }))
  const promptReferences = agentRuns.filter(run => run.createdAt.getTime() <= cutoff).map(run => ({ agentRunId: run.id, nodeId: run.nodeId, promptAssemblyId: run.promptAssemblyId, traceId: run.traceId }))
  const artifactReferences = events.filter(event => event.occurredAt.getTime() <= cutoff && /ARTIFACT|DOCUMENT|RECEIPT/i.test(event.eventType)).map(event => ({ eventId: event.id, eventType: event.eventType, payload: event.payload }))
  const snapshot = await withTenantDbTransaction(prisma, tx => tx.workflowTimeTravelSnapshot.create({
    data: {
      instanceId,
      checkpointId: checkpoint.id,
      nodeId,
      tenantId,
      context: checkpoint.context as Prisma.InputJsonValue,
      nodeStates: checkpoint.nodeStates as Prisma.InputJsonValue,
      routingDecisions: json(routingDecisions),
      promptReferences: json(promptReferences),
      policySnapshot: json(record(record(checkpoint.context)._governancePolicySnapshot)),
      artifactReferences: json(artifactReferences),
      createdById: actorId,
    },
  }), tenantId)
  return { snapshot, checkpoint, routingDecisions, promptReferences, artifactReferences }
}

export async function executeCompensation(args: { instanceId: string; nodeId: string; actorId: string; actionKey?: string }) {
  const tenantId = currentTenantIdForDb() ?? 'default'
  const [instance, node] = await Promise.all([
    withTenantDbTransaction(prisma, tx => tx.workflowInstance.findUnique({ where: { id: args.instanceId } }), tenantId),
    withTenantDbTransaction(prisma, tx => tx.workflowNode.findFirst({ where: { id: args.nodeId, instanceId: args.instanceId } }), tenantId),
  ])
  if (!instance) throw new NotFoundError('WorkflowInstance', args.instanceId)
  if (!node) throw new NotFoundError('WorkflowNode', args.nodeId)
  const cfg = record(node.compensationConfig)
  if (Object.keys(cfg).length === 0) throw new ValidationError('This node has no explicit compensation configuration')
  const actionKey = args.actionKey ?? String(cfg.actionKey ?? cfg.type ?? 'default')
  const execution = await withTenantDbTransaction(prisma, tx => tx.workflowCompensationExecution.create({
    data: { instanceId: instance.id, nodeId: node.id, actionKey, tenantId, config: json(cfg), requestedById: args.actorId },
  }), tenantId)
  try {
    const actionType = String(cfg.type ?? cfg.actionType ?? 'LOG').toUpperCase()
    let result: JsonRecord = { actionType, actionKey, dryRun: true }
    if (actionType === 'EMIT_EVENT') {
      const eventType = String(cfg.eventType ?? 'WorkflowCompensationRequested')
      await publishOutbox('WorkflowInstance', instance.id, eventType, { instanceId: instance.id, nodeId: node.id, compensationId: execution.id, payload: record(cfg.payload) })
      result = { actionType, actionKey, emitted: true, eventType }
    } else if (actionType === 'RESTORE_CONTEXT') {
      const context = record(instance.context)
      const restore = record(cfg.context)
      await withTenantDbTransaction(prisma, tx => tx.workflowInstance.update({ where: { id: instance.id }, data: { context: json({ ...context, ...restore }) } }), tenantId)
      result = { actionType, actionKey, restoredKeys: Object.keys(restore) }
    } else if (actionType !== 'LOG') {
      throw new ValidationError(`Unsupported compensation action type ${actionType}; use LOG, EMIT_EVENT, or RESTORE_CONTEXT`)
    }
    const completed = await withTenantDbTransaction(prisma, tx => tx.workflowCompensationExecution.update({ where: { id: execution.id }, data: { status: 'COMPLETED', result: json(result), completedAt: new Date() } }), tenantId)
    return completed
  } catch (error) {
    await withTenantDbTransaction(prisma, tx => tx.workflowCompensationExecution.update({ where: { id: execution.id }, data: { status: 'FAILED', error: error instanceof Error ? error.message : String(error), completedAt: new Date() } }), tenantId).catch(() => undefined)
    throw error
  }
}
