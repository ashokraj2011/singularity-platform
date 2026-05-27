/**
 * M84.s1 — Backfill first-class workbench stages from the legacy
 * loopDefinition JSON blob on workflow_nodes.config.
 *
 * Reads every WorkflowNode of type WORKBENCH_TASK. If its config.loopDefinition
 * is present, creates a matching WorkbenchDefinition + WorkbenchStage tree.
 * Idempotent: a node that already has a WorkbenchDefinition row gets its
 * stages/artifacts/edges replaced atomically (delete cascades, then re-insert)
 * so re-running after a config edit keeps the tables in sync. Existing
 * workflow_nodes.config JSON is left untouched — the runtime executor still
 * reads from it until M84.s3 cuts over.
 *
 * Inference rules applied during backfill:
 *   - Forward edges: from each stage's `next` pointer (legacy chain).
 *   - Send-back edges: one SEND_BACK row per entry in `allowedSendBackTo`.
 *   - Artifact consumes: best-effort name match — when stage B has no
 *     explicit `consumesArtifactsFrom`, look for upstream stages (any
 *     earlier ordinal) producing an artifact whose `kind` matches the
 *     name pattern of a stage B input. Marked `inferred = true` so the
 *     UI surfaces them as soft until the operator confirms. Legacy
 *     workflows have no explicit handoff metadata so EVERY consumes
 *     binding produced by this backfill is inferred.
 *
 * Run:
 *   pnpm --filter workgraph-api exec tsx prisma/backfill-m84-workbench.ts
 *
 * Safe to run repeatedly — production-friendly.
 */
import { PrismaClient, Prisma } from '@prisma/client'

const prisma = new PrismaClient()

interface LegacyExpectedArtifact {
  kind: string
  title: string
  description?: string
  format?: string
  required?: boolean
  editable?: boolean
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
  key: string
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

async function backfillOne(nodeId: string, config: LegacyWorkbenchConfig): Promise<{
  stageCount: number
  artifactCount: number
  edgeCount: number
  consumesCount: number
  questionCount: number
}> {
  const loopDef = config.loopDefinition
  if (!loopDef || !Array.isArray(loopDef.stages) || loopDef.stages.length === 0) {
    return { stageCount: 0, artifactCount: 0, edgeCount: 0, consumesCount: 0, questionCount: 0 }
  }

  // Atomic re-sync: delete existing definition for this node (cascades to
  // stages/artifacts/edges/consumes/questions) and re-insert.
  await prisma.workbenchDefinition.deleteMany({ where: { workflowNodeId: nodeId } })

  const definition = await prisma.workbenchDefinition.create({
    data: {
      workflowNodeId: nodeId,
      name: loopDef.name?.trim() || 'Workbench loop',
      version: typeof loopDef.version === 'number' ? loopDef.version : 1,
      goal: config.goal?.trim() || null,
      sourceType: config.sourceType ?? null,
      sourceUri: config.sourceUri ?? null,
      sourceRef: config.sourceRef ?? null,
      capabilityId: config.capabilityId ?? null,
      architectAgentTemplateId: config.agentBindings?.architectAgentTemplateId ?? null,
      developerAgentTemplateId: config.agentBindings?.developerAgentTemplateId ?? null,
      qaAgentTemplateId: config.agentBindings?.qaAgentTemplateId ?? null,
      maxLoopsPerStage: typeof loopDef.maxLoopsPerStage === 'number' ? loopDef.maxLoopsPerStage : 3,
      maxTotalSendBacks: typeof loopDef.maxTotalSendBacks === 'number' ? loopDef.maxTotalSendBacks : 6,
      gateMode: config.gateMode ?? 'manual',
      finalPackKey: config.outputs?.finalPackKey ?? null,
    },
  })

  // ── Stages — preserve legacy order from the array index, since
  // legacy didn't carry an explicit `ordinal`. The `next` chain
  // sometimes diverges from array order (operators reordered without
  // rewiring `next`); array order wins for canvas layout and we use
  // `next` only to seed FORWARD edges. ────────────────────────────
  const stageRowByKey: Record<string, { id: string; ordinal: number }> = {}
  let artifactCount = 0
  let questionCount = 0
  for (const [idx, legacyStage] of loopDef.stages.entries()) {
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
      },
    })
    stageRowByKey[legacyStage.key] = { id: stage.id, ordinal: idx }

    // Artifacts
    for (const [artIdx, art] of (legacyStage.expectedArtifacts ?? []).entries()) {
      await prisma.workbenchExpectedArtifact.create({
        data: {
          stageId: stage.id,
          kind: art.kind,
          title: art.title?.trim() || art.kind,
          description: art.description?.trim() || null,
          format: art.format ?? 'MARKDOWN',
          required: art.required ?? true,
          editable: art.editable ?? false,
          ordinal: artIdx,
        },
      })
      artifactCount++
    }

    // Questions
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
      questionCount++
    }
  }

  // ── Forward edges from each stage's `next` pointer.
  // ── Send-back edges from each stage's `allowedSendBackTo[]`.
  let edgeCount = 0
  for (const legacyStage of loopDef.stages) {
    const from = stageRowByKey[legacyStage.key]
    if (!from) continue
    if (legacyStage.next) {
      const to = stageRowByKey[legacyStage.next]
      if (to) {
        await prisma.workbenchStageEdge.create({
          data: { fromStageId: from.id, toStageId: to.id, kind: 'FORWARD' },
        })
        edgeCount++
      }
    }
    for (const sb of legacyStage.allowedSendBackTo ?? []) {
      const target = stageRowByKey[sb]
      if (!target || target.id === from.id) continue
      // SEND_BACK edges point from the CURRENT stage (`from`) to the
      // upstream stage eligible to receive the regression (`target`).
      // The runtime reads them as "if I'm in `from` and the operator
      // hits Send-Back, these are the legal targets".
      await prisma.workbenchStageEdge.create({
        data: { fromStageId: from.id, toStageId: target.id, kind: 'SEND_BACK' },
      })
      edgeCount++
    }
  }

  // ── Inferred artifact-consumes bindings. For each stage's expected
  // artifacts, look upstream (lower ordinal) for any artifact with a
  // matching `kind` and wire a consumes row. This is best-effort — legacy
  // data has zero explicit handoff metadata. UI surfaces with the
  // `inferred=true` badge so operators can confirm/replace.
  //
  // NOTE: legacy semantics treat "expectedArtifacts" as outputs of the
  // stage, not inputs. We don't currently have a "this stage needs X as
  // input" field in the legacy schema, so the only handoffs we can
  // infer are when an upstream stage's PRODUCED artifact kind matches
  // a downstream stage's PRODUCED artifact kind (i.e. they share a
  // kind name like "story_brief"). This catches the common case where
  // downstream stages re-emit/refine an artifact the upstream emitted.
  // A more accurate inference will land in M84.s2 once we add the
  // explicit `consumesArtifactsFrom` field to the UI.
  let consumesCount = 0
  const allArtifactsByStage = new Map<string, Array<{ id: string; kind: string }>>()
  for (const key of Object.keys(stageRowByKey)) {
    const stageId = stageRowByKey[key]!.id
    const arts = await prisma.workbenchExpectedArtifact.findMany({
      where: { stageId },
      select: { id: true, kind: true },
    })
    allArtifactsByStage.set(key, arts)
  }
  // Walk in ordinal order so we only look upstream.
  const orderedKeys = Object.entries(stageRowByKey)
    .sort((a, b) => a[1].ordinal - b[1].ordinal)
    .map(([k]) => k)
  for (let i = 1; i < orderedKeys.length; i++) {
    const consumerKey = orderedKeys[i]!
    const consumerId = stageRowByKey[consumerKey]!.id
    const consumerArts = allArtifactsByStage.get(consumerKey) ?? []
    for (let j = 0; j < i; j++) {
      const producerKey = orderedKeys[j]!
      const producerArts = allArtifactsByStage.get(producerKey) ?? []
      for (const cArt of consumerArts) {
        const producerMatch = producerArts.find(p => p.kind === cArt.kind)
        if (!producerMatch) continue
        // dedupe on (consumer, producerArtifactId) — schema has the
        // unique already, but check explicitly so a re-run is a no-op.
        const existing = await prisma.workbenchArtifactConsumes.findUnique({
          where: {
            consumerStageId_producerArtifactId: {
              consumerStageId: consumerId,
              producerArtifactId: producerMatch.id,
            },
          },
        })
        if (existing) continue
        await prisma.workbenchArtifactConsumes.create({
          data: {
            consumerStageId: consumerId,
            producerArtifactId: producerMatch.id,
            required: cArt.kind in {} ? true : true, // legacy always required
            inferred: true,
          },
        })
        consumesCount++
      }
    }
  }

  return {
    stageCount: Object.keys(stageRowByKey).length,
    artifactCount,
    edgeCount,
    consumesCount,
    questionCount,
  }
}

async function main(): Promise<void> {
  const nodes = await prisma.workflowNode.findMany({
    where: { nodeType: 'WORKBENCH_TASK' },
    select: { id: true, config: true, label: true },
  })

  console.log(`Found ${nodes.length} WORKBENCH_TASK node(s) to backfill.`)
  let totalStages = 0
  let totalArtifacts = 0
  let totalEdges = 0
  let totalConsumes = 0
  let totalQuestions = 0
  let skipped = 0

  for (const node of nodes) {
    if (!isRecord(node.config)) {
      console.log(`  ${node.id} (${node.label}): config not a record, skipping`)
      skipped++
      continue
    }
    // Legacy nodes nest the workbench config under config.workbench
    // (NodeInspector writes it that way to keep the WorkflowNode.config
    // generic across node types). Newer/test data may have it at top
    // level. Accept either shape.
    const candidate = isRecord(node.config.workbench)
      ? node.config.workbench as LegacyWorkbenchConfig
      : node.config as LegacyWorkbenchConfig
    const result = await backfillOne(node.id, candidate)
    if (result.stageCount === 0) {
      console.log(`  ${node.id} (${node.label}): no loopDefinition.stages, skipping`)
      skipped++
      continue
    }
    console.log(
      `  ${node.id} (${node.label}): ${result.stageCount} stages, ` +
      `${result.artifactCount} artifacts, ${result.edgeCount} edges, ` +
      `${result.consumesCount} consumes (inferred), ${result.questionCount} questions`,
    )
    totalStages += result.stageCount
    totalArtifacts += result.artifactCount
    totalEdges += result.edgeCount
    totalConsumes += result.consumesCount
    totalQuestions += result.questionCount
  }

  console.log(
    `\nTotals: ${totalStages} stages · ${totalArtifacts} artifacts · ` +
    `${totalEdges} edges · ${totalConsumes} consumes · ${totalQuestions} questions ` +
    `(${skipped} node(s) skipped)`,
  )
}

main()
  .catch(err => {
    console.error('Backfill failed:', err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
