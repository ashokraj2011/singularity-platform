/**
 * M84.s3 — Synchronize the first-class workbench tables from the
 * legacy loopDefinition JSON on a WorkflowNode.config.workbench.
 *
 * Called by WorkbenchTaskExecutor.activateWorkbenchTask on every
 * node activation so a freshly-instantiated workflow node — which
 * comes from a template clone, not through M84.s2's REST API — gets
 * its WorkbenchDefinition row created before the operator opens the
 * inspector / canvas. Without this, the new UI would see "no
 * definition exists yet" for every new node.
 *
 * The function is a thin reusable copy of prisma/backfill-m84-workbench.ts's
 * per-node logic. Idempotent: re-running replaces the definition
 * tree atomically (delete cascades, then re-insert). Safe to call
 * many times — calling on every activation is cheap.
 *
 * The reverse direction (tables → JSON) is handled inside
 * workbench-definitions.service.ts's writeThroughToLegacy. Both
 * directions exist during M84.s3-s5 because the executor still
 * reads JSON. M84.s6 cuts the executor over and removes one side.
 */
import { Prisma, type PrismaClient } from '@prisma/client'

interface LegacyExpectedArtifact {
  kind?: string
  title?: string
  description?: string
  format?: string
  required?: boolean
  editable?: boolean
  templateId?: string  // M102 — catalog ArtifactTemplate link
}

interface LegacyQuestion {
  id?: string
  questionId?: string
  text?: string
  question?: string
  required?: boolean
  freeform?: boolean
  options?: unknown
}

interface LegacyStage {
  key?: string
  label?: string
  agentRole?: string
  agentTemplateId?: string
  promptProfileKey?: string
  next?: string | null
  terminal?: boolean
  required?: boolean
  approvalRequired?: boolean
  repoAccess?: boolean
  toolPolicy?: string
  contextPolicy?: string
  // G8 — per-stage governance intent (threaded through the loop JSON so it
  // survives the tables<->JSON round trip; reconciled into IAM on save).
  governancePolicyId?: string | null
  governanceEnforcement?: string | null
  governancePriority?: number | null
  governanceContributions?: unknown
  expectedArtifacts?: LegacyExpectedArtifact[]
  questions?: LegacyQuestion[]
  allowedSendBackTo?: string[]
}

interface LegacyLoopDefinition {
  name?: string
  version?: number
  maxLoopsPerStage?: number
  maxTotalSendBacks?: number
  stages?: LegacyStage[]
}

interface LegacyWorkbenchConfig {
  profile?: string
  gateMode?: string
  goal?: string
  sourceType?: string
  sourceUri?: string
  sourceRef?: string
  capabilityId?: string
  agentBindings?: {
    architectAgentTemplateId?: string
    developerAgentTemplateId?: string
    qaAgentTemplateId?: string
  }
  loopDefinition?: LegacyLoopDefinition
  outputs?: { finalPackKey?: string }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read `node.config.workbench.loopDefinition` (or
 * `node.config.loopDefinition` for unwrapped shapes) and write the
 * first-class tables. Returns the number of stages promoted (0 when
 * the JSON had nothing to promote — e.g. a brand-new node where the
 * inspector hasn't filled in the loop yet).
 *
 * Caller is responsible for passing a prisma client; the service
 * version uses the singleton, but the executor flow may pass a
 * transaction client.
 */
export async function promoteWorkbenchToTables(
  prisma: PrismaClient,
  nodeId: string,
  rawConfig: unknown,
): Promise<{ stageCount: number; promoted: boolean }> {
  if (!isRecord(rawConfig)) {
    return { stageCount: 0, promoted: false }
  }
  // Legacy nodes nest the workbench config under config.workbench.
  // Newer shapes may have it at top level. Accept either.
  const workbench: LegacyWorkbenchConfig =
    isRecord(rawConfig.workbench)
      ? (rawConfig.workbench as LegacyWorkbenchConfig)
      : (rawConfig as LegacyWorkbenchConfig)

  const loopDef = workbench.loopDefinition
  if (!loopDef || !Array.isArray(loopDef.stages) || loopDef.stages.length === 0) {
    return { stageCount: 0, promoted: false }
  }

  // Atomic replace: drop existing definition (cascades to all
  // stage/artifact/edge/consumes/question rows) then re-insert.
  await prisma.workbenchDefinition.deleteMany({ where: { workflowNodeId: nodeId } })

  const definition = await prisma.workbenchDefinition.create({
    data: {
      workflowNodeId: nodeId,
      name: loopDef.name?.trim() || 'Workbench loop',
      version: typeof loopDef.version === 'number' ? loopDef.version : 1,
      goal: workbench.goal?.trim() || null,
      sourceType: workbench.sourceType ?? null,
      sourceUri: workbench.sourceUri ?? null,
      sourceRef: workbench.sourceRef ?? null,
      capabilityId: workbench.capabilityId ?? null,
      architectAgentTemplateId: workbench.agentBindings?.architectAgentTemplateId ?? null,
      developerAgentTemplateId: workbench.agentBindings?.developerAgentTemplateId ?? null,
      qaAgentTemplateId: workbench.agentBindings?.qaAgentTemplateId ?? null,
      maxLoopsPerStage: typeof loopDef.maxLoopsPerStage === 'number' ? loopDef.maxLoopsPerStage : 3,
      maxTotalSendBacks: typeof loopDef.maxTotalSendBacks === 'number' ? loopDef.maxTotalSendBacks : 6,
      gateMode: workbench.gateMode ?? 'manual',
      finalPackKey: workbench.outputs?.finalPackKey ?? null,
    },
  })

  const stageRowByKey: Record<string, { id: string; ordinal: number }> = {}
  for (const [idx, legacyStage] of loopDef.stages.entries()) {
    if (!legacyStage.key) continue
    const stage = await prisma.workbenchStage.create({
      data: {
        definitionId: definition.id,
        stageKey: legacyStage.key,
        label: legacyStage.label?.trim() || legacyStage.key,
        agentRole: legacyStage.agentRole?.trim() || 'AGENT',
        agentTemplateId: legacyStage.agentTemplateId ?? null,
        promptProfileKey: legacyStage.promptProfileKey?.trim() || null,
        ordinal: idx,
        required: legacyStage.required ?? true,
        terminal: legacyStage.terminal ?? false,
        approvalRequired: legacyStage.approvalRequired ?? true,
        repoAccess: legacyStage.repoAccess ?? false,
        toolPolicy: legacyStage.toolPolicy ?? 'NONE',
        contextPolicy: legacyStage.contextPolicy ?? 'NONE',
        governancePolicyId: legacyStage.governancePolicyId ?? null,
        governanceEnforcement: legacyStage.governanceEnforcement ?? null,
        governancePriority: legacyStage.governancePriority ?? null,
        governanceContributions:
          legacyStage.governanceContributions == null
            ? undefined
            : (legacyStage.governanceContributions as Prisma.InputJsonValue),
      },
    })
    stageRowByKey[legacyStage.key] = { id: stage.id, ordinal: idx }

    for (const [artIdx, art] of (legacyStage.expectedArtifacts ?? []).entries()) {
      if (!art.kind || !art.title) continue
      await prisma.workbenchExpectedArtifact.create({
        data: {
          stageId: stage.id,
          kind: art.kind,
          title: art.title.trim() || art.kind,
          description: art.description?.trim() || null,
          format: art.format ?? 'MARKDOWN',
          required: art.required ?? true,
          editable: art.editable ?? false,
          templateId: art.templateId ?? null,
          ordinal: artIdx,
        },
      })
    }

    for (const [qIdx, q] of (legacyStage.questions ?? []).entries()) {
      const qKey = (q.questionId || q.id || `q-${qIdx}`).trim()
      const text = (q.text || q.question || '').trim()
      if (!qKey || !text) continue
      await prisma.workbenchStageQuestion.create({
        data: {
          stageId: stage.id,
          questionId: qKey,
          text,
          required: q.required ?? false,
          freeform: q.freeform ?? true,
          ordinal: qIdx,
          options: q.options as Prisma.InputJsonValue | undefined,
        },
      })
    }
  }

  // Forward + send-back edges.
  for (const legacyStage of loopDef.stages) {
    if (!legacyStage.key) continue
    const from = stageRowByKey[legacyStage.key]
    if (!from) continue
    if (legacyStage.next) {
      const to = stageRowByKey[legacyStage.next]
      if (to) {
        await prisma.workbenchStageEdge.create({
          data: { fromStageId: from.id, toStageId: to.id, kind: 'FORWARD' },
        })
      }
    }
    for (const sb of legacyStage.allowedSendBackTo ?? []) {
      const target = stageRowByKey[sb]
      if (!target || target.id === from.id) continue
      await prisma.workbenchStageEdge.create({
        data: { fromStageId: from.id, toStageId: target.id, kind: 'SEND_BACK' },
      })
    }
  }

  return { stageCount: Object.keys(stageRowByKey).length, promoted: true }
}
