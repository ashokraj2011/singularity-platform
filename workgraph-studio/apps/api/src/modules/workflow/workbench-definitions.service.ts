/**
 * M84.s2 — Workbench definitions service.
 *
 * Reads + writes the first-class WorkbenchDefinition tree (M84.s1).
 * Every mutating operation ALSO writes through to the legacy
 * `WorkflowNode.config.workbench.loopDefinition` JSON blob so the
 * runtime executor (which still reads from JSON until M84.s3) sees
 * the same data. Drop the write-through in M84.s6 once the executor
 * is fully migrated.
 *
 * Authorization: callers must pass the validated userId; the service
 * looks up the node's workflowInstanceId and delegates to
 * assertInstancePermission for view/edit gating. View ops require
 * 'view'; mutate ops require 'edit'.
 *
 * Audit: each mutation records a BlueprintAudit-style event via
 * logEvent + createReceipt so the operator action shows up in
 * audit-gov searches. Event kind: `WorkbenchDefinition.<verb>`.
 */
import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { NotFoundError, ValidationError } from '../../lib/errors'
import { assertInstancePermission, assertTemplatePermission } from '../../lib/permissions/workflowTemplate'
import { logEvent, createReceipt } from '../../lib/audit'
import { promoteWorkbenchToTables } from './lib/promote-workbench'
import { reconcileStageGovernance } from './lib/reconcile-stage-governance'

// ─── Types ─────────────────────────────────────────────────────────────────

export type WorkbenchDefinitionView = {
  id: string
  workflowNodeId: string
  name: string
  version: number
  goal: string | null
  sourceType: string | null
  sourceUri: string | null
  sourceRef: string | null
  capabilityId: string | null
  architectAgentTemplateId: string | null
  developerAgentTemplateId: string | null
  qaAgentTemplateId: string | null
  maxLoopsPerStage: number
  maxTotalSendBacks: number
  gateMode: string
  finalPackKey: string | null
  stages: WorkbenchStageView[]
  edges: WorkbenchEdgeView[]
  consumes: WorkbenchConsumesView[]
  createdAt: string
  updatedAt: string
}

export type WorkbenchStageView = {
  id: string
  stageKey: string
  label: string
  agentRole: string
  agentTemplateId: string | null
  promptProfileKey: string | null
  ordinal: number
  positionX: number | null
  positionY: number | null
  required: boolean
  terminal: boolean
  approvalRequired: boolean
  repoAccess: boolean
  toolPolicy: string
  contextPolicy: string
  // G8 — per-stage governance intent.
  governancePolicyId: string | null
  governanceEnforcement: string | null
  governancePriority: number | null
  governanceContributions: unknown
  expectedArtifacts: WorkbenchArtifactView[]
  questions: WorkbenchQuestionView[]
}

export type WorkbenchArtifactView = {
  id: string
  kind: string
  title: string
  description: string | null
  format: string
  required: boolean
  ordinal: number
  editable: boolean
  templateId: string | null
}

export type WorkbenchEdgeView = {
  id: string
  fromStageId: string
  toStageId: string
  kind: 'FORWARD' | 'SEND_BACK'
  label: string | null
}

export type WorkbenchConsumesView = {
  id: string
  consumerStageId: string
  producerArtifactId: string
  required: boolean
  inferred: boolean
}

export type WorkbenchQuestionView = {
  id: string
  questionId: string
  text: string
  required: boolean
  freeform: boolean
  ordinal: number
  options: unknown
}

// ─── Read ──────────────────────────────────────────────────────────────────

/**
 * Load the definition tree for a node. Returns null when no
 * WorkbenchDefinition row exists (legacy node not yet backfilled).
 * Caller should re-run the backfill in that case, or fall back to
 * reading the JSON blob directly.
 */
// ─── Node resolution (runtime OR design) ─────────────────────────────────────
// The first-class workbench tables were originally runtime-only (keyed to
// workflow_nodes). The designer edits workflow_design_nodes, so a workbench
// node id may be a RUNTIME instance node or a DESIGN template node. Resolve from
// either table, assert the matching permission (instance vs template), and
// write config back to whichever table the node came from. This is what lets the
// design-time stage canvas load/edit existing + new workbench loops.
type ResolvedWorkbenchNode = {
  id: string
  config: Prisma.JsonValue
  nodeType: string
  kind: 'runtime' | 'design'
  instanceId: string | null
  workflowId: string | null
}

async function resolveWorkbenchNode(nodeId: string): Promise<ResolvedWorkbenchNode | null> {
  const rt = await prisma.workflowNode.findUnique({
    where: { id: nodeId },
    select: { id: true, instanceId: true, config: true, nodeType: true },
  })
  if (rt) return { id: rt.id, config: rt.config, nodeType: String(rt.nodeType), kind: 'runtime', instanceId: rt.instanceId, workflowId: null }
  const dn = await prisma.workflowDesignNode.findUnique({
    where: { id: nodeId },
    select: { id: true, workflowId: true, config: true, nodeType: true },
  })
  if (dn) return { id: dn.id, config: dn.config, nodeType: String(dn.nodeType), kind: 'design', instanceId: null, workflowId: dn.workflowId }
  return null
}

async function assertWorkbenchNodeAccess(node: ResolvedWorkbenchNode, userId: string, action: 'view' | 'edit'): Promise<void> {
  if (node.kind === 'runtime') await assertInstancePermission(userId, node.instanceId as string, action)
  else await assertTemplatePermission(userId, node.workflowId as string, action)
}

async function persistWorkbenchNodeConfig(node: ResolvedWorkbenchNode, config: Prisma.InputJsonValue): Promise<void> {
  if (node.kind === 'runtime') await prisma.workflowNode.update({ where: { id: node.id }, data: { config } })
  else await prisma.workflowDesignNode.update({ where: { id: node.id }, data: { config } })
}

export async function getDefinition(
  nodeId: string,
  userId: string,
): Promise<WorkbenchDefinitionView | null> {
  const node = await resolveWorkbenchNode(nodeId)
  if (!node) throw new NotFoundError('WorkflowNode', nodeId)
  await assertWorkbenchNodeAccess(node, userId, 'view')

  let def = await prisma.workbenchDefinition.findUnique({
    where: { workflowNodeId: nodeId },
    include: {
      stages: {
        include: {
          expectedArtifacts: { orderBy: { ordinal: 'asc' } },
          questions: { orderBy: { ordinal: 'asc' } },
        },
        orderBy: { ordinal: 'asc' },
      },
    },
  })
  // M84.s2-followup — lazy promote on read. When the WorkbenchDefinition
  // row is missing but the node carries a legacy loopDefinition JSON
  // (the common case for nodes created after the s1 backfill ran),
  // promote on-the-fly so the inspector / canvas never gets a 404.
  // Pre-M84 nodes without any loopDefinition still return null — that's
  // a legitimate empty state for a freshly-dragged node.
  if (!def && node.nodeType === 'WORKBENCH_TASK') {
    try {
      const { promoted } = await promoteWorkbenchToTables(prisma, nodeId, node.config)
      if (promoted) {
        def = await prisma.workbenchDefinition.findUnique({
          where: { workflowNodeId: nodeId },
          include: {
            stages: {
              include: {
                expectedArtifacts: { orderBy: { ordinal: 'asc' } },
                questions: { orderBy: { ordinal: 'asc' } },
              },
              orderBy: { ordinal: 'asc' },
            },
          },
        })
      }
    } catch {
      // Promote failed (bad JSON shape, partial config) — fall through
      // to the null return so the UI shows the empty-state hint instead
      // of a 500.
    }
  }
  if (!def) return null

  // Edges + consumes are scoped to stages but stored in flat tables.
  // We load them per-definition by joining on stageId IN definition.stages.
  const stageIds = def.stages.map(s => s.id)
  const [edges, consumes] = await Promise.all([
    prisma.workbenchStageEdge.findMany({
      where: { fromStageId: { in: stageIds } },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.workbenchArtifactConsumes.findMany({
      where: { consumerStageId: { in: stageIds } },
      orderBy: { createdAt: 'asc' },
    }),
  ])

  return {
    id: def.id,
    workflowNodeId: def.workflowNodeId,
    name: def.name,
    version: def.version,
    goal: def.goal,
    sourceType: def.sourceType,
    sourceUri: def.sourceUri,
    sourceRef: def.sourceRef,
    capabilityId: def.capabilityId,
    architectAgentTemplateId: def.architectAgentTemplateId,
    developerAgentTemplateId: def.developerAgentTemplateId,
    qaAgentTemplateId: def.qaAgentTemplateId,
    maxLoopsPerStage: def.maxLoopsPerStage,
    maxTotalSendBacks: def.maxTotalSendBacks,
    gateMode: def.gateMode,
    finalPackKey: def.finalPackKey,
    createdAt: def.createdAt.toISOString(),
    updatedAt: def.updatedAt.toISOString(),
    stages: def.stages.map(s => ({
      id: s.id,
      stageKey: s.stageKey,
      label: s.label,
      agentRole: s.agentRole,
      agentTemplateId: s.agentTemplateId,
      promptProfileKey: s.promptProfileKey,
      ordinal: s.ordinal,
      positionX: s.positionX,
      positionY: s.positionY,
      required: s.required,
      terminal: s.terminal,
      approvalRequired: s.approvalRequired,
      repoAccess: s.repoAccess,
      toolPolicy: s.toolPolicy,
      contextPolicy: s.contextPolicy,
      governancePolicyId: s.governancePolicyId,
      governanceEnforcement: s.governanceEnforcement,
      governancePriority: s.governancePriority,
      governanceContributions: s.governanceContributions ?? null,
      expectedArtifacts: s.expectedArtifacts.map(a => ({
        id: a.id,
        kind: a.kind,
        title: a.title,
        description: a.description,
        format: a.format,
        required: a.required,
        ordinal: a.ordinal,
        editable: a.editable,
        templateId: a.templateId,
      })),
      questions: s.questions.map(q => ({
        id: q.id,
        questionId: q.questionId,
        text: q.text,
        required: q.required,
        freeform: q.freeform,
        ordinal: q.ordinal,
        options: q.options,
      })),
    })),
    edges: edges.map(e => ({
      id: e.id,
      fromStageId: e.fromStageId,
      toStageId: e.toStageId,
      kind: e.kind as 'FORWARD' | 'SEND_BACK',
      label: e.label,
    })),
    consumes: consumes.map(c => ({
      id: c.id,
      consumerStageId: c.consumerStageId,
      producerArtifactId: c.producerArtifactId,
      required: c.required,
      inferred: c.inferred,
    })),
  }
}

// ─── Write-through helper ──────────────────────────────────────────────────

/**
 * Re-synthesize the legacy `loopDefinition` JSON blob from the first-class
 * tables and write it to WorkflowNode.config.workbench.loopDefinition.
 *
 * The runtime executor still reads from there until M84.s3, so every
 * mutation must call this. The shape mirrors the legacy LoopDefinition
 * the inspector used to write directly — same field names, same nesting,
 * same `next` chain rebuilt from FORWARD edges.
 */
async function writeThroughToLegacy(nodeId: string): Promise<void> {
  // M84.s6 — WORKBENCH_TABLES_AUTHORITATIVE=true means the operator has
  // declared tables are the only source of truth and the legacy JSON
  // blob no longer needs to mirror them. Skipping the write-through
  // here completes the cutover for API-driven edits; the form-save
  // PATCH and the executor's promote-on-activate are gated by the
  // same env var.
  if (process.env.WORKBENCH_TABLES_AUTHORITATIVE === 'true') return
  const view = await prisma.workbenchDefinition.findUnique({
    where: { workflowNodeId: nodeId },
    include: {
      stages: {
        include: {
          expectedArtifacts: { orderBy: { ordinal: 'asc' } },
          questions: { orderBy: { ordinal: 'asc' } },
          outgoingEdges: true,
        },
        orderBy: { ordinal: 'asc' },
      },
    },
  })
  if (!view) return

  // Build per-stage forward `next` (from FORWARD edges) and
  // `allowedSendBackTo` (from SEND_BACK edges). Stage key lookup table
  // for converting edge stageIds back to legacy keys.
  const stageKeyById = new Map<string, string>()
  for (const s of view.stages) stageKeyById.set(s.id, s.stageKey)

  const legacyStages = view.stages.map(s => {
    const forward = s.outgoingEdges.find(e => e.kind === 'FORWARD')
    const sendBacks = s.outgoingEdges
      .filter(e => e.kind === 'SEND_BACK')
      .map(e => stageKeyById.get(e.toStageId))
      .filter((k): k is string => Boolean(k))
    return {
      key: s.stageKey,
      label: s.label,
      agentRole: s.agentRole,
      agentTemplateId: s.agentTemplateId ?? undefined,
      promptProfileKey: s.promptProfileKey ?? '',
      next: forward ? stageKeyById.get(forward.toStageId) ?? null : null,
      terminal: s.terminal,
      required: s.required,
      approvalRequired: s.approvalRequired,
      repoAccess: s.repoAccess,
      toolPolicy: s.toolPolicy,
      contextPolicy: s.contextPolicy,
      // G8 — carry per-stage governance through the JSON loopDefinition so it
      // survives the tables<->JSON round trip (else the reconciler would
      // deactivate the rows it just created).
      governancePolicyId: s.governancePolicyId ?? undefined,
      governanceEnforcement: s.governanceEnforcement ?? undefined,
      governancePriority: s.governancePriority ?? undefined,
      governanceContributions: s.governanceContributions ?? undefined,
      expectedArtifacts: s.expectedArtifacts.map(a => ({
        kind: a.kind,
        title: a.title,
        description: a.description ?? '',
        format: a.format,
        required: a.required,
        editable: a.editable,
        // M102 — carry the catalog link into the JSON loopDefinition so the
        // runtime (renderExpectedArtifacts) injects the template's sections.
        templateId: a.templateId ?? undefined,
      })),
      questions: s.questions.map(q => ({
        questionId: q.questionId,
        text: q.text,
        required: q.required,
        freeform: q.freeform,
        options: q.options,
      })),
      allowedSendBackTo: sendBacks,
    }
  })

  const legacyConfig = {
    profile: 'blueprint',
    gateMode: view.gateMode,
    goal: view.goal ?? '',
    sourceType: view.sourceType ?? undefined,
    sourceUri: view.sourceUri ?? undefined,
    sourceRef: view.sourceRef ?? undefined,
    capabilityId: view.capabilityId ?? undefined,
    agentBindings: {
      architectAgentTemplateId: view.architectAgentTemplateId ?? undefined,
      developerAgentTemplateId: view.developerAgentTemplateId ?? undefined,
      qaAgentTemplateId: view.qaAgentTemplateId ?? undefined,
    },
    loopDefinition: {
      name: view.name,
      version: view.version,
      maxLoopsPerStage: view.maxLoopsPerStage,
      maxTotalSendBacks: view.maxTotalSendBacks,
      stages: legacyStages,
    },
    outputs: { finalPackKey: view.finalPackKey ?? '' },
  }

  const node = await resolveWorkbenchNode(nodeId)
  if (!node) return
  const existingConfig =
    typeof node.config === 'object' && node.config !== null && !Array.isArray(node.config)
      ? (node.config as Record<string, unknown>)
      : {}
  await persistWorkbenchNodeConfig(node, { ...existingConfig, workbench: legacyConfig } as Prisma.InputJsonValue)
}

// ─── Mutations ─────────────────────────────────────────────────────────────

async function requireEditAccess(nodeId: string, userId: string): Promise<string> {
  const node = await resolveWorkbenchNode(nodeId)
  if (!node) throw new NotFoundError('WorkflowNode', nodeId)
  await assertWorkbenchNodeAccess(node, userId, 'edit')
  return node.instanceId ?? node.workflowId ?? nodeId
}

async function recordAudit(
  nodeId: string,
  kind: string,
  actorId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const eventLogId = await logEvent(
    `WorkbenchDefinition.${kind}`,
    'WorkflowNode',
    nodeId,
    actorId,
    payload,
  )
  await createReceipt(
    `WorkbenchDefinition.${kind}`,
    'WorkflowNode',
    nodeId,
    { actorId, ...payload },
    eventLogId,
  )
}

/** Update top-level definition fields (goal, source, fallbacks, budget). */
export async function patchDefinition(
  nodeId: string,
  input: Partial<{
    name: string
    goal: string | null
    sourceType: string | null
    sourceUri: string | null
    sourceRef: string | null
    capabilityId: string | null
    architectAgentTemplateId: string | null
    developerAgentTemplateId: string | null
    qaAgentTemplateId: string | null
    maxLoopsPerStage: number
    maxTotalSendBacks: number
    gateMode: string
    finalPackKey: string | null
  }>,
  userId: string,
): Promise<WorkbenchDefinitionView> {
  await requireEditAccess(nodeId, userId)
  await prisma.workbenchDefinition.update({
    where: { workflowNodeId: nodeId },
    data: input,
  })
  await writeThroughToLegacy(nodeId)
  // G8 — re-materialize per-stage governance (capabilityId may have changed).
  await reconcileStageGovernance(prisma, nodeId)
  await recordAudit(nodeId, 'Patched', userId, { fields: Object.keys(input) })
  const view = await getDefinition(nodeId, userId)
  if (!view) throw new NotFoundError('WorkbenchDefinition', nodeId)
  return view
}

/** Create a stage. Appends to the end (ordinal = max+1). */
export async function createStage(
  nodeId: string,
  input: {
    stageKey: string
    label: string
    agentRole: string
    agentTemplateId?: string | null
    promptProfileKey?: string | null
    toolPolicy?: string
    contextPolicy?: string
    required?: boolean
    terminal?: boolean
    approvalRequired?: boolean
    repoAccess?: boolean
    governancePolicyId?: string | null
    governanceEnforcement?: string | null
    governancePriority?: number | null
    positionX?: number | null
    positionY?: number | null
  },
  userId: string,
): Promise<WorkbenchDefinitionView> {
  await requireEditAccess(nodeId, userId)
  const def = await prisma.workbenchDefinition.findUnique({
    where: { workflowNodeId: nodeId },
    select: { id: true },
  })
  if (!def) throw new NotFoundError('WorkbenchDefinition', nodeId)

  // Compute next ordinal — append at end.
  const maxOrdinal = await prisma.workbenchStage.aggregate({
    where: { definitionId: def.id },
    _max: { ordinal: true },
  })
  const nextOrdinal = (maxOrdinal._max.ordinal ?? -1) + 1

  await prisma.workbenchStage.create({
    data: {
      definitionId: def.id,
      stageKey: input.stageKey,
      label: input.label,
      agentRole: input.agentRole,
      agentTemplateId: input.agentTemplateId ?? null,
      promptProfileKey: input.promptProfileKey ?? null,
      toolPolicy: input.toolPolicy ?? 'NONE',
      contextPolicy: input.contextPolicy ?? 'NONE',
      required: input.required ?? true,
      terminal: input.terminal ?? false,
      approvalRequired: input.approvalRequired ?? true,
      repoAccess: input.repoAccess ?? false,
      governancePolicyId: input.governancePolicyId ?? null,
      governanceEnforcement: input.governanceEnforcement ?? null,
      governancePriority: input.governancePriority ?? null,
      positionX: input.positionX ?? null,
      positionY: input.positionY ?? null,
      ordinal: nextOrdinal,
    },
  })
  await writeThroughToLegacy(nodeId)
  await reconcileStageGovernance(prisma, nodeId)
  await recordAudit(nodeId, 'StageCreated', userId, { stageKey: input.stageKey })
  return (await getDefinition(nodeId, userId))!
}

/** Patch fields on a single stage. */
export async function patchStage(
  nodeId: string,
  stageId: string,
  input: Partial<{
    stageKey: string
    label: string
    agentRole: string
    agentTemplateId: string | null
    promptProfileKey: string | null
    toolPolicy: string
    contextPolicy: string
    required: boolean
    terminal: boolean
    approvalRequired: boolean
    repoAccess: boolean
    governancePolicyId: string | null
    governanceEnforcement: string | null
    governancePriority: number | null
    positionX: number | null
    positionY: number | null
  }>,
  userId: string,
): Promise<WorkbenchDefinitionView> {
  await requireEditAccess(nodeId, userId)
  await assertStageBelongsToNode(stageId, nodeId)
  await prisma.workbenchStage.update({ where: { id: stageId }, data: input })
  await writeThroughToLegacy(nodeId)
  await reconcileStageGovernance(prisma, nodeId)
  await recordAudit(nodeId, 'StagePatched', userId, { stageId, fields: Object.keys(input) })
  return (await getDefinition(nodeId, userId))!
}

/** Delete a stage. Cascades to artifacts, edges, consumes, questions. */
export async function deleteStage(
  nodeId: string,
  stageId: string,
  userId: string,
): Promise<WorkbenchDefinitionView> {
  await requireEditAccess(nodeId, userId)
  await assertStageBelongsToNode(stageId, nodeId)
  await prisma.workbenchStage.delete({ where: { id: stageId } })
  await writeThroughToLegacy(nodeId)
  await recordAudit(nodeId, 'StageDeleted', userId, { stageId })
  return (await getDefinition(nodeId, userId))!
}

/** Reorder stages by passing the new ordered list of stage IDs. */
export async function reorderStages(
  nodeId: string,
  orderedStageIds: string[],
  userId: string,
): Promise<WorkbenchDefinitionView> {
  await requireEditAccess(nodeId, userId)
  const def = await prisma.workbenchDefinition.findUnique({
    where: { workflowNodeId: nodeId },
    select: { id: true, stages: { select: { id: true } } },
  })
  if (!def) throw new NotFoundError('WorkbenchDefinition', nodeId)
  const validIds = new Set(def.stages.map(s => s.id))
  for (const id of orderedStageIds) {
    if (!validIds.has(id)) {
      throw new ValidationError(`Stage ${id} does not belong to this definition`)
    }
  }
  if (orderedStageIds.length !== def.stages.length) {
    throw new ValidationError(
      `reorderStages requires every stage id; got ${orderedStageIds.length}, expected ${def.stages.length}`,
    )
  }
  await prisma.$transaction(
    orderedStageIds.map((id, idx) =>
      prisma.workbenchStage.update({ where: { id }, data: { ordinal: idx } }),
    ),
  )
  await writeThroughToLegacy(nodeId)
  await recordAudit(nodeId, 'StagesReordered', userId, { count: orderedStageIds.length })
  return (await getDefinition(nodeId, userId))!
}

/** Add an artifact to a stage. */
export async function createArtifact(
  nodeId: string,
  stageId: string,
  input: {
    kind: string
    title: string
    description?: string | null
    format?: string
    required?: boolean
    editable?: boolean
    templateId?: string | null
  },
  userId: string,
): Promise<WorkbenchDefinitionView> {
  await requireEditAccess(nodeId, userId)
  await assertStageBelongsToNode(stageId, nodeId)
  const maxOrd = await prisma.workbenchExpectedArtifact.aggregate({
    where: { stageId },
    _max: { ordinal: true },
  })
  await prisma.workbenchExpectedArtifact.create({
    data: {
      stageId,
      kind: input.kind,
      title: input.title,
      description: input.description ?? null,
      format: input.format ?? 'MARKDOWN',
      required: input.required ?? true,
      editable: input.editable ?? false,
      templateId: input.templateId ?? null,
      ordinal: (maxOrd._max.ordinal ?? -1) + 1,
    },
  })
  await writeThroughToLegacy(nodeId)
  await recordAudit(nodeId, 'ArtifactCreated', userId, { stageId, kind: input.kind })
  return (await getDefinition(nodeId, userId))!
}

/** Edit an artifact in place. */
export async function patchArtifact(
  nodeId: string,
  artifactId: string,
  input: Partial<{
    kind: string
    title: string
    description: string | null
    format: string
    required: boolean
    editable: boolean
    templateId: string | null
  }>,
  userId: string,
): Promise<WorkbenchDefinitionView> {
  await requireEditAccess(nodeId, userId)
  await assertArtifactBelongsToNode(artifactId, nodeId)
  await prisma.workbenchExpectedArtifact.update({ where: { id: artifactId }, data: input })
  await writeThroughToLegacy(nodeId)
  await recordAudit(nodeId, 'ArtifactPatched', userId, { artifactId, fields: Object.keys(input) })
  return (await getDefinition(nodeId, userId))!
}

export async function deleteArtifact(
  nodeId: string,
  artifactId: string,
  userId: string,
): Promise<WorkbenchDefinitionView> {
  await requireEditAccess(nodeId, userId)
  await assertArtifactBelongsToNode(artifactId, nodeId)
  await prisma.workbenchExpectedArtifact.delete({ where: { id: artifactId } })
  await writeThroughToLegacy(nodeId)
  await recordAudit(nodeId, 'ArtifactDeleted', userId, { artifactId })
  return (await getDefinition(nodeId, userId))!
}

/** Add a FORWARD or SEND_BACK edge between two stages. */
export async function createEdge(
  nodeId: string,
  input: { fromStageId: string; toStageId: string; kind: 'FORWARD' | 'SEND_BACK'; label?: string | null },
  userId: string,
): Promise<WorkbenchDefinitionView> {
  await requireEditAccess(nodeId, userId)
  await assertStageBelongsToNode(input.fromStageId, nodeId)
  await assertStageBelongsToNode(input.toStageId, nodeId)
  if (input.fromStageId === input.toStageId) {
    throw new ValidationError('Self-loop edges are not allowed')
  }
  // Forward edges are 1:1 per stage — replace any existing FORWARD edge
  // from `fromStageId` first. SEND_BACK edges are many-to-many.
  if (input.kind === 'FORWARD') {
    await prisma.workbenchStageEdge.deleteMany({
      where: { fromStageId: input.fromStageId, kind: 'FORWARD' },
    })
  }
  await prisma.workbenchStageEdge.upsert({
    where: {
      fromStageId_toStageId_kind: {
        fromStageId: input.fromStageId,
        toStageId: input.toStageId,
        kind: input.kind,
      },
    },
    create: { ...input, label: input.label ?? null },
    update: { label: input.label ?? null },
  })
  await writeThroughToLegacy(nodeId)
  await recordAudit(nodeId, 'EdgeCreated', userId, input)
  return (await getDefinition(nodeId, userId))!
}

export async function deleteEdge(
  nodeId: string,
  edgeId: string,
  userId: string,
): Promise<WorkbenchDefinitionView> {
  await requireEditAccess(nodeId, userId)
  const edge = await prisma.workbenchStageEdge.findUnique({
    where: { id: edgeId },
    include: { fromStage: { select: { definition: { select: { workflowNodeId: true } } } } },
  })
  if (!edge) throw new NotFoundError('WorkbenchStageEdge', edgeId)
  if (edge.fromStage.definition.workflowNodeId !== nodeId) {
    throw new ValidationError('Edge does not belong to this node')
  }
  await prisma.workbenchStageEdge.delete({ where: { id: edgeId } })
  await writeThroughToLegacy(nodeId)
  await recordAudit(nodeId, 'EdgeDeleted', userId, { edgeId, kind: edge.kind })
  return (await getDefinition(nodeId, userId))!
}

/**
 * Pin / replace an artifact-handoff edge. Looks up by
 * (consumerStageId, producerArtifactId) — upsert semantics.
 * Sets inferred=false since the operator is pinning it.
 */
export async function pinConsumes(
  nodeId: string,
  input: {
    consumerStageId: string
    producerArtifactId: string
    required?: boolean
  },
  userId: string,
): Promise<WorkbenchDefinitionView> {
  await requireEditAccess(nodeId, userId)
  await assertStageBelongsToNode(input.consumerStageId, nodeId)
  await assertArtifactBelongsToNode(input.producerArtifactId, nodeId)
  await prisma.workbenchArtifactConsumes.upsert({
    where: {
      consumerStageId_producerArtifactId: {
        consumerStageId: input.consumerStageId,
        producerArtifactId: input.producerArtifactId,
      },
    },
    create: {
      consumerStageId: input.consumerStageId,
      producerArtifactId: input.producerArtifactId,
      required: input.required ?? true,
      inferred: false,
    },
    update: {
      required: input.required ?? true,
      inferred: false,
    },
  })
  await writeThroughToLegacy(nodeId)
  await recordAudit(nodeId, 'ConsumesPinned', userId, input)
  return (await getDefinition(nodeId, userId))!
}

export async function deleteConsumes(
  nodeId: string,
  consumesId: string,
  userId: string,
): Promise<WorkbenchDefinitionView> {
  await requireEditAccess(nodeId, userId)
  const row = await prisma.workbenchArtifactConsumes.findUnique({
    where: { id: consumesId },
    include: {
      consumerStage: { select: { definition: { select: { workflowNodeId: true } } } },
    },
  })
  if (!row) throw new NotFoundError('WorkbenchArtifactConsumes', consumesId)
  if (row.consumerStage.definition.workflowNodeId !== nodeId) {
    throw new ValidationError('Consumes binding does not belong to this node')
  }
  await prisma.workbenchArtifactConsumes.delete({ where: { id: consumesId } })
  await writeThroughToLegacy(nodeId)
  await recordAudit(nodeId, 'ConsumesDeleted', userId, { consumesId })
  return (await getDefinition(nodeId, userId))!
}

// ─── Internal guards ───────────────────────────────────────────────────────

async function assertStageBelongsToNode(stageId: string, nodeId: string): Promise<void> {
  const stage = await prisma.workbenchStage.findUnique({
    where: { id: stageId },
    select: { definition: { select: { workflowNodeId: true } } },
  })
  if (!stage) throw new NotFoundError('WorkbenchStage', stageId)
  if (stage.definition.workflowNodeId !== nodeId) {
    throw new ValidationError(`Stage ${stageId} does not belong to node ${nodeId}`)
  }
}

async function assertArtifactBelongsToNode(artifactId: string, nodeId: string): Promise<void> {
  const art = await prisma.workbenchExpectedArtifact.findUnique({
    where: { id: artifactId },
    select: { stage: { select: { definition: { select: { workflowNodeId: true } } } } },
  })
  if (!art) throw new NotFoundError('WorkbenchExpectedArtifact', artifactId)
  if (art.stage.definition.workflowNodeId !== nodeId) {
    throw new ValidationError(`Artifact ${artifactId} does not belong to node ${nodeId}`)
  }
}
