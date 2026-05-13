import { Router } from 'express'
import { z } from 'zod'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { BlueprintStage, BlueprintSessionStatus, BlueprintStageStatus, BlueprintSourceType, Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { validate } from '../../middleware/validate'
import { NotFoundError, ValidationError } from '../../lib/errors'
import { logEvent, publishOutbox } from '../../lib/audit'
import { contextFabricClient, ContextFabricError, type ExecuteResponse } from '../../lib/context-fabric/client'
import { recordWorkflowLlmUsage } from '../workflow/runtime/budget'

export const blueprintRouter: Router = Router()

const MAX_FILES = 250
const MAX_TOTAL_BYTES = 2_000_000
const MAX_EXCERPT_BYTES = 4_000
const MAX_EXCERPT_FILES = 8
const EXECUTE_MANIFEST_MAX_FILES = 120
const EXECUTE_EXCERPT_MAX_FILES = 8
const EXECUTE_EXCERPT_MAX_CHARS = 4_000
const EXECUTE_EXCERPT_BUDGET_CHARS = 18_000

const DEFAULT_EXCLUDES = new Set([
  '.git', 'node_modules', 'dist', 'build', '.next', '.turbo', '.cache',
  'coverage', 'target', 'vendor', '__pycache__', '.venv', 'venv',
])

const optionalUuid = z.preprocess(
  value => value === '' || value === null ? undefined : value,
  z.string().uuid().optional(),
)

const createSessionSchema = z.object({
  goal: z.string().min(8),
  sourceType: z.enum(['github', 'localdir']),
  sourceUri: z.string().min(1),
  sourceRef: z.string().optional(),
  includeGlobs: z.array(z.string()).default([]),
  excludeGlobs: z.array(z.string()).default([]),
  capabilityId: z.string().min(1),
  architectAgentTemplateId: optionalUuid,
  developerAgentTemplateId: optionalUuid,
  qaAgentTemplateId: optionalUuid,
  workflowInstanceId: z.string().optional(),
  workflowNodeId: z.string().optional(),
  phaseId: z.string().optional(),
  loopDefinition: z.unknown().optional(),
  gateMode: z.enum(['manual', 'auto']).default('manual'),
  snapshotMode: z.enum(['summary', 'relevant_excerpts', 'full_debug']).default('relevant_excerpts'),
  excerptBudgetChars: z.number().int().min(2_000).max(120_000).optional(),
  reuseUnchangedAttempt: z.boolean().default(true),
})

const decisionAnswerSchema = z.object({
  questionId: z.string().min(1),
  answerType: z.enum(['option', 'freeform']),
  selectedOptionLabel: z.string().optional(),
  customAnswer: z.string().optional(),
  notes: z.string().optional(),
}).refine(answer => {
  if (answer.answerType === 'option') return Boolean(answer.selectedOptionLabel?.trim())
  return Boolean(answer.customAnswer?.trim() || answer.notes?.trim())
}, { message: 'Decision answers need either an option or free-form text' })

const saveDecisionAnswersSchema = z.object({
  answers: z.array(decisionAnswerSchema).max(100),
})

const stageActionParamsSchema = z.object({
  id: z.string().min(1),
  stageKey: z.string().min(1).max(80),
})

const verdictSchema = z.object({
  verdict: z.enum(['PASS', 'NEEDS_REWORK', 'BLOCKED', 'ACCEPTED_WITH_RISK']),
  feedback: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  acceptRisk: z.boolean().optional(),
  answers: z.array(decisionAnswerSchema).max(100).optional(),
})

const sendBackSchema = z.object({
  targetStageKey: z.string().min(1).max(80),
  reason: z.string().min(3),
  requiredChanges: z.string().optional(),
  blockingQuestions: z.array(z.string()).max(20).optional(),
})

type CreateSessionInput = z.infer<typeof createSessionSchema>
type DecisionAnswer = z.infer<typeof decisionAnswerSchema> & { updatedAt?: string; updatedById?: string }
type LoopAgentRole = string
type LoopVerdict = 'PASS' | 'NEEDS_REWORK' | 'BLOCKED' | 'ACCEPTED_WITH_RISK'
type LoopAttemptStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'PASSED' | 'NEEDS_REWORK' | 'BLOCKED' | 'ACCEPTED_WITH_RISK'

type LoopExpectedArtifact = {
  kind: string
  title: string
  description?: string
  required?: boolean
  format?: 'MARKDOWN' | 'TEXT' | 'JSON' | 'CODE'
}

type LoopQuestion = {
  id: string
  question: string
  required?: boolean
  options?: Array<{ label: string; impact?: string; recommended?: boolean }>
  freeform?: boolean
}

type LoopStageDefinition = {
  key: string
  label: string
  agentRole: LoopAgentRole
  agentTemplateId?: string
  description?: string
  next?: string | null
  terminal?: boolean
  required?: boolean
  approvalRequired?: boolean
  expectedArtifacts?: LoopExpectedArtifact[]
  allowedSendBackTo?: string[]
  questions?: LoopQuestion[]
}

type LoopDefinition = {
  version: number
  name: string
  stages: LoopStageDefinition[]
  maxLoopsPerStage: number
  maxTotalSendBacks: number
}

type GateRecommendation = {
  verdict: LoopVerdict
  confidence: number
  reason: string
  targetStageKey?: string
}

type StageAttempt = {
  id: string
  stageKey: string
  stageLabel: string
  agentRole: LoopAgentRole
  agentTemplateId: string
  attemptNumber: number
  status: LoopAttemptStatus
  startedAt: string
  completedAt?: string
  response?: string
  error?: string
  verdict?: LoopVerdict
  confidence?: number
  feedback?: string
  acceptedAt?: string
  acceptedById?: string
  artifactIds?: string[]
  inputSignature?: string
  gateRecommendation?: GateRecommendation
  correlation?: Record<string, unknown>
  tokensUsed?: Record<string, unknown>
  metrics?: Record<string, unknown>
}

type ReviewEvent = {
  id: string
  type: string
  stageKey?: string
  targetStageKey?: string
  attemptId?: string
  message: string
  actorId?: string
  payload?: Record<string, unknown>
  createdAt: string
}

type FinalPack = {
  id: string
  status: string
  generatedAt: string
  generatedById?: string
  summary: string
  stages: Array<{ stageKey: string; label: string; verdict: LoopVerdict; attemptNumber: number; artifactIds: string[] }>
  artifactKinds: string[]
}

type LoopState = {
  workflowNodeId?: string
  gateMode: 'manual' | 'auto'
  loopDefinition: LoopDefinition
  currentStageKey: string | null
  stageAttempts: StageAttempt[]
  reviewEvents: ReviewEvent[]
  decisionAnswers: DecisionAnswer[]
  finalPack?: FinalPack
  executionConfig?: {
    snapshotMode?: 'summary' | 'relevant_excerpts' | 'full_debug'
    excerptBudgetChars?: number
    reuseUnchangedAttempt?: boolean
  }
}

type ManifestEntry = {
  path: string
  size: number
  language?: string
  sha?: string
  excerpt?: string
}

type SnapshotResult = {
  manifest: ManifestEntry[]
  summary: Record<string, unknown>
  fileCount: number
  totalBytes: number
  rootHash: string
}

blueprintRouter.get('/sessions', async (req, res, next) => {
  try {
    const createdById = req.user!.userId
    const sessions = await prisma.blueprintSession.findMany({
      where: { createdById },
      include: {
        snapshots: { orderBy: { createdAt: 'desc' }, take: 1 },
        stageRuns: { orderBy: { createdAt: 'desc' } },
        artifacts: { orderBy: { createdAt: 'desc' } },
      },
      orderBy: { updatedAt: 'desc' },
      take: 50,
    })
    res.json({ items: sessions.map(shapeSession) })
  } catch (err) { next(err) }
})

blueprintRouter.post('/sessions', validate(createSessionSchema), async (req, res, next) => {
  try {
    const body = req.body as CreateSessionInput
    const initialLoopDefinition = normalizeLoopDefinition(body.loopDefinition, body)
    const agentTemplateIds = resolveSessionAgentTemplateIds(body, initialLoopDefinition)
    const loopDefinition = hydrateLoopAgentTemplates(initialLoopDefinition, agentTemplateIds)
    const now = new Date().toISOString()
    const initialLoopState: LoopState = {
      workflowNodeId: body.workflowNodeId,
      gateMode: body.gateMode,
      loopDefinition,
      currentStageKey: loopDefinition.stages[0]?.key ?? null,
      stageAttempts: [],
      decisionAnswers: [],
      reviewEvents: [{
        id: crypto.randomUUID(),
        type: 'SESSION_CREATED',
        stageKey: loopDefinition.stages[0]?.key,
        message: `Workbench session created with ${loopDefinition.stages.length} loop stages.`,
        actorId: req.user!.userId,
        createdAt: now,
        payload: { gateMode: body.gateMode, workflowNodeId: body.workflowNodeId },
      }],
      executionConfig: {
        snapshotMode: body.snapshotMode,
        excerptBudgetChars: body.excerptBudgetChars ?? EXECUTE_EXCERPT_BUDGET_CHARS,
        reuseUnchangedAttempt: body.reuseUnchangedAttempt,
      },
    }
    const session = await prisma.blueprintSession.create({
      data: {
        goal: body.goal,
        sourceType: body.sourceType === 'github' ? BlueprintSourceType.GITHUB : BlueprintSourceType.LOCALDIR,
        sourceUri: body.sourceUri,
        sourceRef: body.sourceRef ?? null,
        includeGlobs: body.includeGlobs as Prisma.InputJsonValue,
        excludeGlobs: body.excludeGlobs as Prisma.InputJsonValue,
        capabilityId: body.capabilityId,
        architectAgentTemplateId: agentTemplateIds.architectAgentTemplateId,
        developerAgentTemplateId: agentTemplateIds.developerAgentTemplateId,
        qaAgentTemplateId: agentTemplateIds.qaAgentTemplateId,
        workflowInstanceId: body.workflowInstanceId ?? null,
        phaseId: body.phaseId ?? null,
        metadata: initialLoopState as unknown as Prisma.InputJsonValue,
        createdById: req.user!.userId,
      },
    })
    await recordBlueprintAudit(session.id, 'BlueprintSessionCreated', req.user!.userId, {
      capabilityId: session.capabilityId,
      sourceType: session.sourceType,
      workflowInstanceId: session.workflowInstanceId,
      workflowNodeId: body.workflowNodeId,
    })
    res.status(201).json(await loadSession(session.id, req.user!.userId))
  } catch (err) { next(err) }
})

blueprintRouter.get('/sessions/:id', async (req, res, next) => {
  try {
    res.json(await loadSession(req.params.id, req.user!.userId))
  } catch (err) { next(err) }
})

blueprintRouter.post('/sessions/:id/snapshot', async (req, res, next) => {
  try {
    const session = await prisma.blueprintSession.findUnique({ where: { id: req.params.id } })
    if (!session) throw new NotFoundError('BlueprintSession', req.params.id)
    assertBlueprintAccess(session, req.user!.userId)

    let result: SnapshotResult
    try {
      result = session.sourceType === BlueprintSourceType.LOCALDIR
        ? await snapshotLocalDir(session.sourceUri, jsonStrings(session.includeGlobs), jsonStrings(session.excludeGlobs))
        : await snapshotGithub(session.sourceUri, session.sourceRef ?? undefined, jsonStrings(session.includeGlobs), jsonStrings(session.excludeGlobs))
    } catch (err) {
      const failed = await prisma.blueprintSourceSnapshot.create({
        data: {
          sessionId: session.id,
          status: 'FAILED',
          error: (err as Error).message,
          manifest: [],
          summary: { error: (err as Error).message },
        },
      })
      await prisma.blueprintSession.update({ where: { id: session.id }, data: { status: BlueprintSessionStatus.FAILED } })
      await recordBlueprintAudit(session.id, 'BlueprintSnapshotFailed', req.user!.userId, {
        sessionId: session.id,
        error: (err as Error).message,
      })
      return res.status(422).json({ snapshot: failed, error: (err as Error).message })
    }

    const snapshot = await prisma.blueprintSourceSnapshot.create({
      data: {
        sessionId: session.id,
        manifest: result.manifest as unknown as Prisma.InputJsonValue,
        summary: result.summary as Prisma.InputJsonValue,
        fileCount: result.fileCount,
        totalBytes: result.totalBytes,
        rootHash: result.rootHash,
      },
    })
    await prisma.blueprintSession.update({
      where: { id: session.id },
      data: { status: BlueprintSessionStatus.SNAPSHOTTED },
    })
    await recordBlueprintAudit(session.id, 'BlueprintSourceSnapshotted', req.user!.userId, {
      snapshotId: snapshot.id,
      fileCount: snapshot.fileCount,
      totalBytes: snapshot.totalBytes,
    })
    res.status(201).json(await loadSession(session.id, req.user!.userId))
  } catch (err) { next(err) }
})

blueprintRouter.post('/sessions/:id/run', async (req, res, next) => {
  try {
    const session = await prisma.blueprintSession.findUnique({
      where: { id: req.params.id },
      include: {
        snapshots: { orderBy: { createdAt: 'desc' }, take: 1 },
        artifacts: { orderBy: { createdAt: 'asc' } },
      },
    })
    if (!session) throw new NotFoundError('BlueprintSession', req.params.id)
    assertBlueprintAccess(session, req.user!.userId)
    const snapshot = session.snapshots[0]
    if (!snapshot || snapshot.status !== 'COMPLETED') {
      throw new ValidationError('Create a successful source snapshot before running the workbench agents')
    }

    await prisma.blueprintSession.update({ where: { id: session.id }, data: { status: BlueprintSessionStatus.RUNNING } })

    const stages: Array<{ stage: BlueprintStage; agentTemplateId: string; task: string }> = [
      {
        stage: BlueprintStage.ARCHITECT,
        agentTemplateId: session.architectAgentTemplateId,
        task: architectTask(session.goal),
      },
      {
        stage: BlueprintStage.DEVELOPER,
        agentTemplateId: session.developerAgentTemplateId,
        task: developerTask(session.goal),
      },
      {
        stage: BlueprintStage.QA,
        agentTemplateId: session.qaAgentTemplateId,
        task: qaTask(session.goal),
      },
    ]

    const queuedRuns = new Map<BlueprintStage, string>()
    for (const stage of stages) {
      const created = await prisma.blueprintStageRun.create({
        data: {
          sessionId: session.id,
          stage: stage.stage,
          status: BlueprintStageStatus.PENDING,
          task: stage.task,
        },
      })
      queuedRuns.set(stage.stage, created.id)
    }

    let failed = false
    for (const stage of stages) {
      const runId = queuedRuns.get(stage.stage)
      if (!runId) throw new ValidationError(`Missing queued run for stage ${stage.stage}`)
      await prisma.blueprintStageRun.update({
        where: { id: runId },
        data: { status: BlueprintStageStatus.RUNNING, startedAt: new Date() },
      })
      try {
        const result = await runStage(session, snapshot, stage.stage, stage.agentTemplateId, stage.task)
        await recordBlueprintBudgetUsage(session, result, stage.stage.toLowerCase())
        await prisma.blueprintStageRun.update({
          where: { id: runId },
          data: {
            status: result.status === 'FAILED' ? BlueprintStageStatus.FAILED : BlueprintStageStatus.COMPLETED,
            response: result.finalResponse ?? '',
            correlation: result.correlation as unknown as Prisma.InputJsonValue,
            tokensUsed: result.tokensUsed as unknown as Prisma.InputJsonValue,
            completedAt: new Date(),
            error: result.status === 'FAILED' ? result.finishReason ?? 'stage failed' : null,
          },
        })
        await createStageArtifacts(session, snapshot, stage.stage, result)
        if (result.status === 'FAILED') {
          failed = true
          break
        }
      } catch (err) {
        const message = err instanceof ContextFabricError
          ? `context-fabric error (${err.status}): ${err.message}`
          : (err as Error).message
        await prisma.blueprintStageRun.update({
          where: { id: runId },
          data: {
            status: BlueprintStageStatus.FAILED,
            error: message,
            completedAt: new Date(),
          },
        })
        await prisma.blueprintArtifact.create({
          data: {
            sessionId: session.id,
            stage: stage.stage,
            kind: 'stage_error',
            title: `${humanStage(stage.stage)} error`,
            content: message,
          },
        })
        failed = true
        break
      }
    }

    await prisma.blueprintSession.update({
      where: { id: session.id },
      data: { status: failed ? BlueprintSessionStatus.FAILED : BlueprintSessionStatus.COMPLETED },
    })
    await recordBlueprintAudit(session.id, failed ? 'BlueprintRunFailed' : 'BlueprintRunCompleted', req.user!.userId, {
      sessionId: session.id,
    })
    res.json(await loadSession(session.id, req.user!.userId))
  } catch (err) { next(err) }
})

blueprintRouter.post('/sessions/:id/stages/:stageKey/run', async (req, res, next) => {
  try {
    const params = stageActionParamsSchema.parse(req.params)
    const updated = await runLoopStage(params.id, params.stageKey, req.user!.userId)
    res.json(updated)
  } catch (err) { next(err) }
})

blueprintRouter.post('/sessions/:id/stages/:stageKey/verdict', validate(verdictSchema), async (req, res, next) => {
  try {
    const params = stageActionParamsSchema.parse(req.params)
    const body = req.body as z.infer<typeof verdictSchema>
    const updated = await saveStageVerdict(params.id, params.stageKey, body, req.user!.userId)
    res.json(updated)
  } catch (err) { next(err) }
})

blueprintRouter.post('/sessions/:id/stages/:stageKey/send-back', validate(sendBackSchema), async (req, res, next) => {
  try {
    const params = stageActionParamsSchema.parse(req.params)
    const body = req.body as z.infer<typeof sendBackSchema>
    const updated = await sendStageBack(params.id, params.stageKey, body, req.user!.userId)
    res.json(updated)
  } catch (err) { next(err) }
})

blueprintRouter.post('/sessions/:id/finalize', async (req, res, next) => {
  try {
    const updated = await finalizeLoop(req.params.id, req.user!.userId)
    res.json(updated)
  } catch (err) { next(err) }
})

blueprintRouter.post('/sessions/:id/approve', async (req, res, next) => {
  try {
    const session = await prisma.blueprintSession.findUnique({
      where: { id: req.params.id },
      include: { stageRuns: { orderBy: { createdAt: 'desc' } } },
    })
    if (!session) throw new NotFoundError('BlueprintSession', req.params.id)
    assertBlueprintAccess(session, req.user!.userId)
    const completed = new Set(
      session.stageRuns
        .filter(r => r.status === BlueprintStageStatus.COMPLETED)
        .map(r => r.stage),
    )
    for (const stage of [BlueprintStage.ARCHITECT, BlueprintStage.DEVELOPER, BlueprintStage.QA]) {
      if (!completed.has(stage)) throw new ValidationError(`Cannot approve until ${humanStage(stage)} is completed`)
    }
    await prisma.blueprintSession.update({
      where: { id: session.id },
      data: {
        status: BlueprintSessionStatus.APPROVED,
        approvedById: req.user!.userId,
        approvedAt: new Date(),
      },
    })
    await prisma.blueprintArtifact.create({
      data: {
        sessionId: session.id,
        kind: 'approval_receipt',
        title: 'Blueprint approval receipt',
        payload: {
          approvedById: req.user!.userId,
          approvedAt: new Date().toISOString(),
          requiredStages: ['ARCHITECT', 'DEVELOPER', 'QA'],
        } as Prisma.InputJsonValue,
      },
    })
    await recordBlueprintAudit(session.id, 'BlueprintApproved', req.user!.userId, { sessionId: session.id })
    res.json(await loadSession(session.id, req.user!.userId))
  } catch (err) { next(err) }
})

blueprintRouter.post('/sessions/:id/decision-answers', validate(saveDecisionAnswersSchema), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof saveDecisionAnswersSchema>
    const sessionId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id
    const session = await prisma.blueprintSession.findUnique({ where: { id: sessionId } })
    if (!session) throw new NotFoundError('BlueprintSession', sessionId)
    assertBlueprintAccess(session, req.user!.userId)

    const metadata = isRecord(session.metadata) ? session.metadata : {}
    const updatedAt = new Date().toISOString()
    const decisionAnswers = body.answers.map(answer => ({
        questionId: answer.questionId,
        answerType: answer.answerType,
        selectedOptionLabel: answer.selectedOptionLabel?.trim() || undefined,
        customAnswer: answer.customAnswer?.trim() || undefined,
        notes: answer.notes?.trim() || undefined,
        updatedAt,
        updatedById: req.user!.userId,
    }))
    await prisma.blueprintSession.update({
      where: { id: session.id },
      data: {
        metadata: {
          ...metadata,
          decisionAnswers,
          decisionAnswersUpdatedAt: updatedAt,
        } as Prisma.InputJsonValue,
      },
    })

    const snapshot = await prisma.blueprintSourceSnapshot.findFirst({
      where: { sessionId: session.id },
      orderBy: { createdAt: 'desc' },
    })
    if (snapshot?.status === 'COMPLETED') {
      const ctx = buildSnapshotContext(snapshot as ArtifactSnapshot)
      await prisma.blueprintArtifact.createMany({
        data: [
          {
            sessionId: session.id,
            kind: 'stakeholder_answers',
            title: 'Stakeholder answers',
            content: buildStakeholderAnswersMarkdown(decisionAnswers),
            payload: { answers: decisionAnswers } as Prisma.InputJsonValue,
          },
          {
            sessionId: session.id,
            stage: BlueprintStage.QA,
            kind: 'implementation_contract',
            title: 'Implementation contract',
            content: buildImplementationContractMarkdown(session, ctx, decisionAnswers),
            payload: { contract: buildImplementationContractPayload(session, ctx, decisionAnswers) } as Prisma.InputJsonValue,
          },
        ],
      })
    }

    await recordBlueprintAudit(session.id, 'BlueprintDecisionAnswersSaved', req.user!.userId, {
      answerCount: body.answers.length,
    })
    res.json(await loadSession(session.id, req.user!.userId))
  } catch (err) { next(err) }
})

async function loadSession(id: string, actorId?: string) {
  const session = await prisma.blueprintSession.findUnique({
    where: { id },
    include: {
      snapshots: { orderBy: { createdAt: 'desc' } },
      stageRuns: { orderBy: { createdAt: 'asc' } },
      artifacts: { orderBy: { createdAt: 'asc' } },
    },
  })
  if (!session) throw new NotFoundError('BlueprintSession', id)
  if (actorId) assertBlueprintAccess(session, actorId)
  return shapeSession(session)
}

function assertBlueprintAccess(session: { id: string; createdById?: string | null }, actorId: string) {
  if (!session.createdById || session.createdById === actorId) return
  throw new NotFoundError('BlueprintSession', session.id)
}

async function recordBlueprintAudit(
  sessionId: string,
  eventType: string,
  actorId: string,
  payload: Record<string, unknown> = {},
) {
  await logEvent(eventType, 'BlueprintSession', sessionId, actorId, { sessionId, actorId, ...payload })
  await publishOutbox('BlueprintSession', sessionId, eventType, { sessionId, actorId, ...payload })
}

type LoopSessionSeed = {
  id?: string
  goal: string
  architectAgentTemplateId: string
  developerAgentTemplateId: string
  qaAgentTemplateId: string
  metadata?: Prisma.JsonValue
  workflowInstanceId?: string | null
  phaseId?: string | null
}

type AgentTemplateSeed = {
  architectAgentTemplateId?: string | null
  developerAgentTemplateId?: string | null
  qaAgentTemplateId?: string | null
}

type ResolvedAgentTemplateSeed = {
  architectAgentTemplateId: string
  developerAgentTemplateId: string
  qaAgentTemplateId: string
}

function shapeSession<T extends LoopSessionSeed & { artifacts?: Array<{ payload?: Prisma.JsonValue | null }> }>(session: T) {
  const loop = readLoopState(session)
  return {
    ...session,
    workflowNodeId: loop.workflowNodeId,
    gateMode: loop.gateMode,
    loopDefinition: loop.loopDefinition,
    currentStageKey: loop.currentStageKey,
    stageAttempts: loop.stageAttempts,
    reviewEvents: loop.reviewEvents,
    decisionAnswers: loop.decisionAnswers,
    finalPack: loop.finalPack,
    executionConfig: loop.executionConfig,
    artifacts: session.artifacts?.map(shapeArtifact) ?? [],
  }
}

function shapeArtifact<T extends { payload?: Prisma.JsonValue | null }>(artifact: T) {
  const payload = isRecord(artifact.payload) ? artifact.payload : {}
  return {
    ...artifact,
    stageKey: typeof payload.stageKey === 'string' ? payload.stageKey : undefined,
    attemptId: typeof payload.attemptId === 'string' ? payload.attemptId : undefined,
    version: typeof payload.version === 'number' ? payload.version : undefined,
  }
}

function readLoopState(session: LoopSessionSeed): LoopState {
  const metadata = isRecord(session.metadata) ? session.metadata : {}
  const loopDefinition = normalizeLoopDefinition(metadata.loopDefinition, session)
  const currentStageKey = typeof metadata.currentStageKey === 'string'
    ? metadata.currentStageKey
    : loopDefinition.stages[0]?.key ?? null
  return {
    workflowNodeId: typeof metadata.workflowNodeId === 'string' ? metadata.workflowNodeId : undefined,
    gateMode: metadata.gateMode === 'auto' ? 'auto' : 'manual',
    loopDefinition,
    currentStageKey,
    stageAttempts: Array.isArray(metadata.stageAttempts) ? (metadata.stageAttempts as unknown[]).filter(isStageAttempt) : [],
    reviewEvents: Array.isArray(metadata.reviewEvents) ? (metadata.reviewEvents as unknown[]).filter(isReviewEvent) : [],
    decisionAnswers: Array.isArray(metadata.decisionAnswers) ? (metadata.decisionAnswers as unknown[]).filter(isDecisionAnswerRecord) : [],
    finalPack: isFinalPack(metadata.finalPack) ? metadata.finalPack : undefined,
    executionConfig: readExecutionConfig(metadata.executionConfig),
  }
}

function stateToMetadata(session: LoopSessionSeed, state: LoopState): Prisma.InputJsonValue {
  const current = isRecord(session.metadata) ? session.metadata : {}
  return {
    ...current,
    workflowNodeId: state.workflowNodeId,
    gateMode: state.gateMode,
    loopDefinition: state.loopDefinition,
    currentStageKey: state.currentStageKey,
    stageAttempts: state.stageAttempts,
    reviewEvents: state.reviewEvents,
    decisionAnswers: state.decisionAnswers,
    finalPack: state.finalPack,
    executionConfig: state.executionConfig,
    decisionAnswersUpdatedAt: current.decisionAnswersUpdatedAt,
  } as Prisma.InputJsonValue
}

function readExecutionConfig(value: unknown): LoopState['executionConfig'] {
  if (!isRecord(value)) return undefined
  return {
    snapshotMode: value.snapshotMode === 'summary' || value.snapshotMode === 'full_debug' ? value.snapshotMode : 'relevant_excerpts',
    excerptBudgetChars: typeof value.excerptBudgetChars === 'number' ? value.excerptBudgetChars : undefined,
    reuseUnchangedAttempt: value.reuseUnchangedAttempt !== false,
  }
}

function normalizeLoopDefinition(input: unknown, session: AgentTemplateSeed): LoopDefinition {
  if (isRecord(input) && Array.isArray(input.stages)) {
    const rawStages = input.stages.filter(isRecord)
    const stages = rawStages.map((raw, index) => normalizeLoopStage(raw, index, session)).filter((stage): stage is LoopStageDefinition => Boolean(stage))
    if (stages.length > 0) {
      const known = new Set(stages.map(stage => stage.key))
      return {
        version: typeof input.version === 'number' ? input.version : 1,
        name: typeof input.name === 'string' ? input.name : 'Workflow blueprint loop',
        stages: stages.map((stage, index) => ({
          ...stage,
          next: stage.next && known.has(stage.next) ? stage.next : stage.terminal ? null : stages[index + 1]?.key ?? null,
          allowedSendBackTo: (stage.allowedSendBackTo ?? []).filter(key => known.has(key)),
        })),
        maxLoopsPerStage: numberOr(input.maxLoopsPerStage, 3),
        maxTotalSendBacks: numberOr(input.maxTotalSendBacks, 8),
      }
    }
  }
  return defaultLoopDefinition(session)
}

function normalizeLoopStage(raw: Record<string, unknown>, index: number, session: AgentTemplateSeed): LoopStageDefinition | null {
  const key = slug(typeof raw.key === 'string' ? raw.key : typeof raw.id === 'string' ? raw.id : `stage-${index + 1}`)
  if (!key) return null
  const agentRole = normalizeAgentRole(raw.agentRole ?? raw.role)
  return {
    key,
    label: typeof raw.label === 'string' ? raw.label : titleFromKey(key),
    agentRole,
    agentTemplateId: typeof raw.agentTemplateId === 'string' ? raw.agentTemplateId : defaultAgentTemplateForRole(session, agentRole),
    description: typeof raw.description === 'string' ? raw.description : undefined,
    next: typeof raw.next === 'string' ? slug(raw.next) : raw.next === null ? null : undefined,
    terminal: raw.terminal === true,
    required: raw.required !== false,
    approvalRequired: raw.approvalRequired !== false,
    expectedArtifacts: normalizeExpectedArtifacts(raw.expectedArtifacts),
    allowedSendBackTo: Array.isArray(raw.allowedSendBackTo) ? raw.allowedSendBackTo.filter((item): item is string => typeof item === 'string').map(slug) : [],
    questions: Array.isArray(raw.questions) ? raw.questions.filter(isRecord).map(normalizeQuestion).filter((q): q is LoopQuestion => Boolean(q)) : [],
  }
}

function normalizeExpectedArtifacts(input: unknown): LoopExpectedArtifact[] {
  if (!Array.isArray(input)) return []
  return input
    .filter(isRecord)
    .map((raw, index): LoopExpectedArtifact | null => {
      const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : undefined
      const kind = typeof raw.kind === 'string' && raw.kind.trim() ? artifactKind(raw.kind) : title ? artifactKind(title) : `artifact_${index + 1}`
      if (!kind || !title) return null
      const format = raw.format === 'TEXT' || raw.format === 'JSON' || raw.format === 'CODE' ? raw.format : 'MARKDOWN'
      return {
        kind,
        title,
        description: typeof raw.description === 'string' && raw.description.trim() ? raw.description.trim() : undefined,
        required: raw.required !== false,
        format,
      }
    })
    .filter((artifact): artifact is LoopExpectedArtifact => Boolean(artifact))
}

function normalizeQuestion(raw: Record<string, unknown>): LoopQuestion | null {
  const id = typeof raw.id === 'string' ? raw.id : undefined
  const question = typeof raw.question === 'string' ? raw.question : undefined
  if (!id || !question) return null
  return {
    id,
    question,
    required: raw.required === true,
    freeform: raw.freeform !== false,
    options: Array.isArray(raw.options) ? raw.options.filter(isRecord).map(option => ({
      label: String(option.label ?? ''),
      impact: typeof option.impact === 'string' ? option.impact : undefined,
      recommended: option.recommended === true,
    })).filter(option => option.label.trim()) : [],
  }
}

function defaultLoopDefinition(session: AgentTemplateSeed): LoopDefinition {
  return {
    version: 1,
    name: 'Blueprint implementation loop',
    maxLoopsPerStage: 3,
    maxTotalSendBacks: 8,
    stages: [
      {
        key: 'plan',
        label: 'Plan',
        agentRole: 'ARCHITECT',
        agentTemplateId: firstAgentTemplate(session.architectAgentTemplateId),
        description: 'Create the mental model, scope, risks, and planning questions.',
        next: 'design',
        allowedSendBackTo: [],
        required: true,
        approvalRequired: true,
        expectedArtifacts: [
          { kind: 'mental_model', title: 'Mental model', required: true, format: 'MARKDOWN' },
          { kind: 'gaps', title: 'Gaps and open risks', required: true, format: 'MARKDOWN' },
        ],
        questions: [
          { id: 'PLAN-001', question: 'What is the smallest valuable outcome for this change?', required: true, freeform: true },
          { id: 'PLAN-002', question: 'Which constraints must not be violated?', required: false, freeform: true },
        ],
      },
      {
        key: 'design',
        label: 'Design',
        agentRole: 'ARCHITECT',
        agentTemplateId: firstAgentTemplate(session.architectAgentTemplateId),
        description: 'Turn the plan into solution architecture, contracts, and acceptance boundaries.',
        next: 'develop',
        allowedSendBackTo: ['plan'],
        required: true,
        approvalRequired: true,
        expectedArtifacts: [
          { kind: 'solution_architecture', title: 'Solution architecture', required: true, format: 'MARKDOWN' },
          { kind: 'approved_spec_draft', title: 'Approved spec draft', required: true, format: 'MARKDOWN' },
        ],
        questions: [
          { id: 'DESIGN-001', question: 'Is the proposed design acceptable for implementation?', required: true, options: [
            { label: 'Accept design', recommended: true, impact: 'Developer can produce the implementation task pack.' },
            { label: 'Needs redesign', impact: 'Send back to planning or design with constraints.' },
          ], freeform: true },
        ],
      },
      {
        key: 'develop',
        label: 'Develop',
        agentRole: 'DEVELOPER',
        agentTemplateId: firstAgentTemplate(session.developerAgentTemplateId),
        description: 'Produce the proposed implementation plan, file changes, and read-only code-change evidence.',
        next: 'qa-review',
        allowedSendBackTo: ['design', 'plan'],
        required: true,
        approvalRequired: true,
        expectedArtifacts: [
          { kind: 'developer_task_pack', title: 'Developer task pack', required: true, format: 'MARKDOWN' },
          { kind: 'simulated_code_change', title: 'Simulated code-change evidence', required: true, format: 'MARKDOWN' },
        ],
        questions: [
          { id: 'DEV-001', question: 'Is the implementation plan complete enough for QA to review?', required: true, options: [
            { label: 'Ready for QA', recommended: true, impact: 'Move into QA review.' },
            { label: 'Needs developer rework', impact: 'Run another developer iteration.' },
          ], freeform: true },
        ],
      },
      {
        key: 'qa-review',
        label: 'QA Review',
        agentRole: 'QA',
        agentTemplateId: firstAgentTemplate(session.qaAgentTemplateId),
        description: 'Review implementation evidence against requirements, edge cases, and failure modes.',
        next: 'test-certification',
        allowedSendBackTo: ['develop', 'design'],
        required: true,
        approvalRequired: true,
        expectedArtifacts: [
          { kind: 'qa_task_pack', title: 'QA review pack', required: true, format: 'MARKDOWN' },
        ],
        questions: [
          { id: 'QA-001', question: 'What must be proven before this can be certified?', required: true, freeform: true },
        ],
      },
      {
        key: 'test-certification',
        label: 'Test Certification',
        agentRole: 'QA',
        agentTemplateId: firstAgentTemplate(session.qaAgentTemplateId),
        description: 'Stamp the testing strategy, verification notes, traceability, and final certification readiness.',
        next: null,
        terminal: true,
        allowedSendBackTo: ['develop', 'qa-review', 'design'],
        required: true,
        approvalRequired: true,
        expectedArtifacts: [
          { kind: 'verification_rules', title: 'Verification rules', required: true, format: 'MARKDOWN' },
          { kind: 'traceability_matrix', title: 'Traceability matrix', required: true, format: 'MARKDOWN' },
          { kind: 'certification_receipt', title: 'Certification receipt', required: true, format: 'MARKDOWN' },
        ],
        questions: [
          { id: 'TEST-001', question: 'Can this be finalized for workflow handoff?', required: true, options: [
            { label: 'Finalize', recommended: true, impact: 'Generate the final implementation pack.' },
            { label: 'Send back', impact: 'Return to the failing stage with feedback.' },
          ], freeform: true },
        ],
      },
    ],
  }
}

function normalizeAgentRole(value: unknown): LoopAgentRole {
  const role = String(value ?? 'ARCHITECT').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  return role || 'ARCHITECT'
}

function defaultAgentTemplateForRole(session: AgentTemplateSeed, role: LoopAgentRole) {
  const normalizedRole = normalizeAgentRole(role)
  if (normalizedRole.includes('DEV') || normalizedRole === 'ENGINEER') {
    return firstAgentTemplate(session.developerAgentTemplateId, session.architectAgentTemplateId, session.qaAgentTemplateId)
  }
  if (normalizedRole.includes('QA') || normalizedRole.includes('TEST') || normalizedRole.includes('VERIFY')) {
    return firstAgentTemplate(session.qaAgentTemplateId, session.developerAgentTemplateId, session.architectAgentTemplateId)
  }
  return firstAgentTemplate(session.architectAgentTemplateId, session.developerAgentTemplateId, session.qaAgentTemplateId)
}

function firstAgentTemplate(...ids: Array<string | null | undefined>) {
  return ids.find((id): id is string => Boolean(id?.trim()))
}

function resolveSessionAgentTemplateIds(input: AgentTemplateSeed, loopDefinition: LoopDefinition): ResolvedAgentTemplateSeed {
  const stageIds = loopDefinition.stages.map(stage => stage.agentTemplateId).filter((id): id is string => Boolean(id?.trim()))
  const architect = input.architectAgentTemplateId ?? stageIds.find((_, index) => index === 0)
  const developer = input.developerAgentTemplateId
    ?? loopDefinition.stages.find(stage => normalizeAgentRole(stage.agentRole).includes('DEV') && stage.agentTemplateId)?.agentTemplateId
    ?? stageIds[1]
    ?? architect
  const qa = input.qaAgentTemplateId
    ?? loopDefinition.stages.find(stage => {
      const role = normalizeAgentRole(stage.agentRole)
      return (role.includes('QA') || role.includes('TEST') || role.includes('VERIFY')) && stage.agentTemplateId
    })?.agentTemplateId
    ?? stageIds.at(-1)
    ?? developer
    ?? architect

  if (!architect || !developer || !qa) {
    throw new ValidationError('At least one agent template must be selected, either as a default binding or per loop phase')
  }
  return {
    architectAgentTemplateId: architect,
    developerAgentTemplateId: developer,
    qaAgentTemplateId: qa,
  }
}

function hydrateLoopAgentTemplates(loopDefinition: LoopDefinition, session: ResolvedAgentTemplateSeed): LoopDefinition {
  return {
    ...loopDefinition,
    stages: loopDefinition.stages.map(stage => ({
      ...stage,
      agentTemplateId: stage.agentTemplateId ?? defaultAgentTemplateForRole(session, stage.agentRole),
      approvalRequired: stage.approvalRequired !== false,
    })),
  }
}

function slug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

function artifactKind(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

function titleFromKey(key: string): string {
  return key.split('-').filter(Boolean).map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ')
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

async function runLoopStage(sessionId: string, stageKey: string, actorId: string) {
  const session = await prisma.blueprintSession.findUnique({
    where: { id: sessionId },
    include: {
      snapshots: { orderBy: { createdAt: 'desc' }, take: 1 },
      artifacts: { orderBy: { createdAt: 'asc' } },
    },
  })
  if (!session) throw new NotFoundError('BlueprintSession', sessionId)
  assertBlueprintAccess(session, actorId)
  const snapshot = session.snapshots[0]
  if (!snapshot || snapshot.status !== 'COMPLETED') {
    throw new ValidationError('Create a successful source snapshot before running a loop stage')
  }

  const state = readLoopState(session)
  const stage = findLoopStage(state, stageKey)
  const priorAttempts = state.stageAttempts.filter(attempt => attempt.stageKey === stage.key)
  const agentTemplateId = stage.agentTemplateId ?? defaultAgentTemplateForRole(session, stage.agentRole)
  if (!agentTemplateId) {
    throw new ValidationError(`Stage ${stage.label} needs an agent template before it can run`)
  }
  const task = loopStageTask(session, stage, state)
  const inputSignature = buildStageInputSignature(snapshot, stage, agentTemplateId, task, state)
  const reusable = state.executionConfig?.reuseUnchangedAttempt === false ? undefined : [...priorAttempts].reverse().find(attempt =>
      attempt.inputSignature === inputSignature &&
      attempt.status !== 'RUNNING' &&
      attempt.status !== 'FAILED' &&
      (attempt.artifactIds?.length ?? 0) > 0,
    )
  if (reusable) {
    const reusedState: LoopState = {
      ...state,
      currentStageKey: stage.key,
      reviewEvents: [...state.reviewEvents, reviewEvent('STAGE_RUN_REUSED', `${stage.label} reused unchanged attempt ${reusable.attemptNumber}.`, actorId, {
        stageKey: stage.key,
        attemptId: reusable.id,
        inputSignature,
        artifactIds: reusable.artifactIds ?? [],
      })],
    }
    await prisma.blueprintSession.update({
      where: { id: session.id },
      data: { status: BlueprintSessionStatus.SNAPSHOTTED, metadata: stateToMetadata(session, reusedState) },
    })
    await recordBlueprintAudit(session.id, 'BlueprintStageRunReused', actorId, {
      stageKey: stage.key,
      stageLabel: stage.label,
      attemptId: reusable.id,
      attemptNumber: reusable.attemptNumber,
      inputSignature,
      artifactIds: reusable.artifactIds ?? [],
    })
    return loadSession(session.id, actorId)
  }
  if (priorAttempts.length >= state.loopDefinition.maxLoopsPerStage) {
    throw new ValidationError(`Stage ${stage.label} reached the max loop count (${state.loopDefinition.maxLoopsPerStage})`)
  }

  const attempt: StageAttempt = {
    id: crypto.randomUUID(),
    stageKey: stage.key,
    stageLabel: stage.label,
    agentRole: stage.agentRole,
    agentTemplateId,
    attemptNumber: priorAttempts.length + 1,
    status: 'RUNNING',
    startedAt: new Date().toISOString(),
    inputSignature,
  }
  const startedState: LoopState = {
    ...state,
    currentStageKey: stage.key,
    stageAttempts: [...state.stageAttempts, attempt],
    reviewEvents: [...state.reviewEvents, reviewEvent('STAGE_RUN_STARTED', `${stage.label} attempt ${attempt.attemptNumber} started.`, actorId, { stageKey: stage.key, attemptId: attempt.id })],
  }
  await prisma.blueprintSession.update({
    where: { id: session.id },
    data: { status: BlueprintSessionStatus.RUNNING, metadata: stateToMetadata(session, startedState) },
  })
  await recordBlueprintAudit(session.id, 'BlueprintStageRunStarted', actorId, {
    stageKey: stage.key,
    stageLabel: stage.label,
    attemptId: attempt.id,
    attemptNumber: attempt.attemptNumber,
  })

  const dbRun = await prisma.blueprintStageRun.create({
    data: {
      sessionId: session.id,
      stage: legacyStage(stage),
      status: BlueprintStageStatus.RUNNING,
      task,
      startedAt: new Date(),
    },
  })

  try {
    const result = await runLoopStageExecute(session, snapshot, stage, attempt.agentTemplateId, task)
    await recordBlueprintBudgetUsage(session, result, stage.key, readLoopState(session).workflowNodeId)
    const completedAt = new Date().toISOString()
    const gateRecommendation = buildGateRecommendation(result, stage)
    const artifactIds = await createLoopStageArtifacts(session, snapshot, stage, attempt, result, gateRecommendation)
    await prisma.blueprintStageRun.update({
      where: { id: dbRun.id },
      data: {
        status: result.status === 'FAILED' ? BlueprintStageStatus.FAILED : BlueprintStageStatus.COMPLETED,
        response: result.finalResponse ?? '',
        correlation: result.correlation as unknown as Prisma.InputJsonValue,
        tokensUsed: result.tokensUsed as unknown as Prisma.InputJsonValue,
        completedAt: new Date(completedAt),
        error: result.status === 'FAILED' ? result.finishReason ?? 'stage failed' : null,
      },
    })

    const latest = await prisma.blueprintSession.findUnique({ where: { id: session.id } })
    const nextState = readLoopState(latest ?? session)
    const updatedAttempts = nextState.stageAttempts.map(item => item.id === attempt.id ? {
      ...item,
      status: result.status === 'FAILED' ? 'FAILED' as const : 'COMPLETED' as const,
      completedAt,
      response: result.finalResponse ?? '',
      error: result.status === 'FAILED' ? result.finishReason ?? 'stage failed' : undefined,
      correlation: result.correlation as unknown as Record<string, unknown>,
      tokensUsed: result.tokensUsed as unknown as Record<string, unknown>,
      metrics: result.metrics as unknown as Record<string, unknown>,
      gateRecommendation,
      artifactIds,
    } : item)
    let updatedState: LoopState = {
      ...nextState,
      currentStageKey: stage.key,
      stageAttempts: updatedAttempts,
      reviewEvents: [...nextState.reviewEvents, reviewEvent(
        stage.approvalRequired !== false ? 'ARTIFACTS_AWAITING_APPROVAL' : 'STAGE_RUN_COMPLETED',
        stage.approvalRequired !== false
          ? `${stage.label} produced ${artifactIds.length} artifacts and is waiting for human approval.`
          : `${stage.label} attempt ${attempt.attemptNumber} completed with ${gateRecommendation.verdict}.`,
        actorId,
        {
        stageKey: stage.key,
        attemptId: attempt.id,
        gateRecommendation,
        artifactIds,
        approvalRequired: stage.approvalRequired !== false,
      })],
    }
    updatedState = maybeApplyAutoGate(updatedState, stage, attempt.id, actorId)
    await prisma.blueprintSession.update({
      where: { id: session.id },
      data: {
        status: BlueprintSessionStatus.SNAPSHOTTED,
        metadata: stateToMetadata(latest ?? session, updatedState),
      },
    })
    await recordBlueprintAudit(session.id, 'BlueprintStageRunCompleted', actorId, {
      stageKey: stage.key,
      stageLabel: stage.label,
      attemptId: attempt.id,
      attemptNumber: attempt.attemptNumber,
      verdict: gateRecommendation.verdict,
      confidence: gateRecommendation.confidence,
      cfCallId: result.correlation?.cfCallId,
      traceId: result.correlation?.traceId,
      mcpInvocationId: result.correlation?.mcpInvocationId,
    tokensUsed: result.tokensUsed,
    metrics: result.metrics,
  })
    return loadSession(session.id, actorId)
  } catch (err) {
    const message = err instanceof ContextFabricError
      ? `context-fabric error (${err.status}): ${err.message}`
      : (err as Error).message
    await prisma.blueprintStageRun.update({
      where: { id: dbRun.id },
      data: { status: BlueprintStageStatus.FAILED, error: message, completedAt: new Date() },
    })
    const latest = await prisma.blueprintSession.findUnique({ where: { id: session.id } })
    const failedState = readLoopState(latest ?? session)
    const attempts = failedState.stageAttempts.map(item => item.id === attempt.id ? {
      ...item,
      status: 'FAILED' as const,
      completedAt: new Date().toISOString(),
      error: message,
      gateRecommendation: { verdict: 'BLOCKED' as const, confidence: 0.95, reason: message, targetStageKey: stage.allowedSendBackTo?.[0] },
    } : item)
    await prisma.blueprintArtifact.create({
      data: {
        sessionId: session.id,
        stage: legacyStage(stage),
        kind: 'loop_stage_error',
        title: `${stage.label} error`,
        content: message,
        payload: { stageKey: stage.key, attemptId: attempt.id, version: attempt.attemptNumber } as Prisma.InputJsonValue,
      },
    })
    await prisma.blueprintSession.update({
      where: { id: session.id },
      data: {
        status: BlueprintSessionStatus.FAILED,
        metadata: stateToMetadata(latest ?? session, {
          ...failedState,
          currentStageKey: stage.key,
          stageAttempts: attempts,
          reviewEvents: [...failedState.reviewEvents, reviewEvent('STAGE_RUN_FAILED', `${stage.label} failed: ${message}`, actorId, { stageKey: stage.key, attemptId: attempt.id })],
        }),
      },
    })
    await recordBlueprintAudit(session.id, 'BlueprintStageRunFailed', actorId, {
      stageKey: stage.key,
      stageLabel: stage.label,
      attemptId: attempt.id,
      attemptNumber: attempt.attemptNumber,
      error: message,
    })
    return loadSession(session.id, actorId)
  }
}

async function saveStageVerdict(
  sessionId: string,
  stageKey: string,
  body: z.infer<typeof verdictSchema>,
  actorId: string,
) {
  const session = await prisma.blueprintSession.findUnique({ where: { id: sessionId } })
  if (!session) throw new NotFoundError('BlueprintSession', sessionId)
  assertBlueprintAccess(session, actorId)
  const state = readLoopState(session)
  const stage = findLoopStage(state, stageKey)
  const latestAttempt = latestStageAttempt(state, stage.key)
  if (!latestAttempt || latestAttempt.status === 'RUNNING') {
    throw new ValidationError(`Run ${stage.label} before saving a verdict`)
  }
  const mergedAnswers = mergeDecisionAnswers(state.decisionAnswers, body.answers ?? [], actorId)
  const missing = missingRequiredQuestions(stage, mergedAnswers)
  if ((body.verdict === 'PASS' || body.verdict === 'ACCEPTED_WITH_RISK') && missing.length > 0 && !body.acceptRisk) {
    throw new ValidationError(`Required questions must be answered before approval: ${missing.join(', ')}`)
  }

  const accepted = body.verdict === 'PASS' || body.verdict === 'ACCEPTED_WITH_RISK'
  const attempts = state.stageAttempts.map(item => item.id === latestAttempt.id ? {
    ...item,
    status: verdictToAttemptStatus(body.verdict),
    verdict: body.verdict,
    confidence: body.confidence,
    feedback: body.feedback,
    acceptedAt: accepted ? new Date().toISOString() : item.acceptedAt,
    acceptedById: accepted ? actorId : item.acceptedById,
  } : item)
  const nextStageKey = accepted ? stage.next ?? null : stage.key
  const nextState: LoopState = {
    ...state,
    decisionAnswers: mergedAnswers,
    currentStageKey: nextStageKey,
    stageAttempts: attempts,
    reviewEvents: [...state.reviewEvents, reviewEvent('STAGE_VERDICT', `${stage.label} marked ${body.verdict}.`, actorId, {
      stageKey: stage.key,
      attemptId: latestAttempt.id,
      verdict: body.verdict,
      feedback: body.feedback,
      missingQuestionsAcceptedWithRisk: missing,
    })],
  }
  await prisma.blueprintSession.update({
    where: { id: session.id },
    data: {
      status: isLoopGreen(nextState) ? BlueprintSessionStatus.COMPLETED : BlueprintSessionStatus.SNAPSHOTTED,
      metadata: stateToMetadata(session, nextState),
    },
  })
  await recordBlueprintAudit(session.id, 'BlueprintStageVerdictSaved', actorId, {
    stageKey: stage.key,
    stageLabel: stage.label,
    attemptId: latestAttempt.id,
    verdict: body.verdict,
    confidence: body.confidence,
    acceptRisk: body.acceptRisk === true,
    missingQuestionsAcceptedWithRisk: missing,
  })
  return loadSession(session.id, actorId)
}

async function sendStageBack(
  sessionId: string,
  stageKey: string,
  body: z.infer<typeof sendBackSchema>,
  actorId: string,
) {
  const session = await prisma.blueprintSession.findUnique({ where: { id: sessionId } })
  if (!session) throw new NotFoundError('BlueprintSession', sessionId)
  assertBlueprintAccess(session, actorId)
  const state = readLoopState(session)
  const stage = findLoopStage(state, stageKey)
  const target = findLoopStage(state, body.targetStageKey)
  if (!(stage.allowedSendBackTo ?? []).includes(target.key)) {
    throw new ValidationError(`${stage.label} cannot send work back to ${target.label}`)
  }
  if (sendBackCount(state) >= state.loopDefinition.maxTotalSendBacks) {
    throw new ValidationError(`Session reached the max send-back count (${state.loopDefinition.maxTotalSendBacks})`)
  }
  const latestAttempt = latestStageAttempt(state, stage.key)
  const attempts = latestAttempt ? state.stageAttempts.map(item => item.id === latestAttempt.id ? {
    ...item,
    status: 'NEEDS_REWORK' as const,
    verdict: item.verdict ?? 'NEEDS_REWORK' as const,
    feedback: body.reason,
  } : item) : state.stageAttempts
  const nextState: LoopState = {
    ...state,
    currentStageKey: target.key,
    stageAttempts: attempts,
    reviewEvents: [...state.reviewEvents, reviewEvent('SEND_BACK', `${stage.label} sent back to ${target.label}: ${body.reason}`, actorId, {
      stageKey: stage.key,
      targetStageKey: target.key,
      attemptId: latestAttempt?.id,
      reason: body.reason,
      requiredChanges: body.requiredChanges,
      blockingQuestions: body.blockingQuestions ?? [],
    })],
  }
  await prisma.blueprintSession.update({
    where: { id: session.id },
    data: { status: BlueprintSessionStatus.SNAPSHOTTED, metadata: stateToMetadata(session, nextState) },
  })
  await recordBlueprintAudit(session.id, 'BlueprintStageSentBack', actorId, {
    stageKey: stage.key,
    stageLabel: stage.label,
    targetStageKey: target.key,
    targetStageLabel: target.label,
    attemptId: latestAttempt?.id,
    reason: body.reason,
    requiredChanges: body.requiredChanges,
    blockingQuestions: body.blockingQuestions ?? [],
  })
  return loadSession(session.id, actorId)
}

async function finalizeLoop(sessionId: string, actorId: string) {
  const session = await prisma.blueprintSession.findUnique({
    where: { id: sessionId },
    include: { artifacts: { orderBy: { createdAt: 'asc' } } },
  })
  if (!session) throw new NotFoundError('BlueprintSession', sessionId)
  assertBlueprintAccess(session, actorId)
  const state = readLoopState(session)
  if (!isLoopGreen(state)) {
    throw new ValidationError('All required loop stages must be passed or accepted with risk before finalizing')
  }
  const finalPack = buildFinalPack(state, session.artifacts, actorId)
  const artifact = await prisma.blueprintArtifact.create({
    data: {
      sessionId: session.id,
      kind: 'final_implementation_pack',
      title: 'Final implementation pack',
      content: buildFinalPackMarkdown(finalPack, state),
      payload: { finalPack, stageKey: state.currentStageKey, version: 1 } as Prisma.InputJsonValue,
    },
  })
  const stampedPack: FinalPack = {
    ...finalPack,
    artifactKinds: [...finalPack.artifactKinds, artifact.kind],
  }
  const finalizedState: LoopState = {
    ...state,
    finalPack: stampedPack,
    reviewEvents: [...state.reviewEvents, reviewEvent('FINALIZED', 'Final implementation pack generated for workflow handoff.', actorId, { artifactId: artifact.id })],
  }
  await prisma.blueprintSession.update({
    where: { id: session.id },
    data: {
      status: BlueprintSessionStatus.APPROVED,
      approvedById: actorId,
      approvedAt: new Date(),
      metadata: stateToMetadata(session, finalizedState),
    },
  })
  await attachFinalPackToWorkflowNode(session, stampedPack, actorId)
  await recordBlueprintAudit(session.id, 'BlueprintFinalized', actorId, {
    artifactId: artifact.id,
    finalPackId: stampedPack.id,
    workflowInstanceId: session.workflowInstanceId,
    workflowNodeId: state.workflowNodeId,
  })
  return loadSession(session.id, actorId)
}

async function runLoopStageExecute(
  session: Awaited<ReturnType<typeof prisma.blueprintSession.findUnique>> & { id: string },
  snapshot: { id?: string; summary: Prisma.JsonValue; manifest: Prisma.JsonValue; rootHash: string | null },
  stage: LoopStageDefinition,
  agentTemplateId: string,
  task: string,
): Promise<ExecuteResponse> {
  const traceId = `blueprint-${session.id}-${stage.key}`
  const executionConfig = readLoopState(session).executionConfig
  const snapshotArtifact = buildSnapshotExecuteArtifact(snapshot, {
    stageKey: stage.key,
    stageLabel: stage.label,
    task,
    snapshotMode: executionConfig?.snapshotMode,
    excerptBudgetChars: executionConfig?.excerptBudgetChars,
  })
  return contextFabricClient.execute({
    trace_id: traceId,
    idempotency_key: `${session.id}:${stage.key}:${Date.now()}`,
    run_context: {
      workflow_instance_id: session.workflowInstanceId ?? `blueprint-${session.id}`,
      workflow_node_id: readLoopState(session).workflowNodeId ?? session.phaseId ?? `blueprint-${stage.key}`,
      capability_id: session.capabilityId,
      agent_template_id: agentTemplateId,
      user_id: session.createdById ?? undefined,
      trace_id: traceId,
    },
    task,
    vars: {
      blueprintSessionId: session.id,
      sourceType: session.sourceType,
      sourceUri: session.sourceUri,
      sourceRef: session.sourceRef,
      stageKey: stage.key,
      stageLabel: stage.label,
      agentRole: stage.agentRole,
    },
    artifacts: [
      {
        label: 'Source snapshot',
        role: 'CONTEXT',
        mediaType: 'application/json',
        content: JSON.stringify(snapshotArtifact, null, 2),
      },
    ],
    overrides: {
      systemPromptAppend: loopStageSystemPrompt(stage),
      extraContext: 'This workbench is read-only. Produce implementation guidance, QA proof, and reviewable artifacts without mutating source files.',
    },
    model_overrides: { provider: 'mock', model: 'mock-fast', temperature: 0.2, maxOutputTokens: 1200 },
    context_policy: {
      optimizationMode: 'code_aware',
      maxContextTokens: 6000,
      compareWithRaw: false,
      knowledgeTopK: 4,
      memoryTopK: 2,
      codeTopK: 5,
      maxLayerChars: 2000,
      maxPromptChars: 24_000,
    },
    limits: {
      maxSteps: 3,
      timeoutSec: 180,
      inputTokenBudget: 6000,
      outputTokenBudget: 1200,
      maxHistoryMessages: 4,
      maxToolResultChars: 8000,
      maxPromptChars: 24_000,
    },
  })
}

async function createLoopStageArtifacts(
  session: ArtifactSession,
  snapshot: ArtifactSnapshot,
  stage: LoopStageDefinition,
  attempt: StageAttempt,
  result: ExecuteResponse,
  gateRecommendation: GateRecommendation,
): Promise<string[]> {
  const ctx = buildSnapshotContext(snapshot)
  const response = isUsefulModelResponse(result.finalResponse) ? result.finalResponse ?? '' : ''
  const commonPayload = {
    stageKey: stage.key,
    attemptId: attempt.id,
    version: attempt.attemptNumber,
    gateRecommendation,
    cfCallId: result.correlation.cfCallId,
    traceId: result.correlation.traceId,
    promptAssemblyId: result.correlation.promptAssemblyId,
    mcpInvocationId: result.correlation.mcpInvocationId,
    codeChangeIds: result.correlation.codeChangeIds ?? [],
    warnings: result.warnings ?? [],
  }
  const baseContent = buildLoopStageMarkdown(session, ctx, stage, attempt, response, gateRecommendation)
  const specs: Array<{ kind: string; title: string; content: string; payload?: Record<string, unknown> }> = [
    {
      kind: `loop_${stage.key}_attempt`,
      title: `${stage.label} attempt ${attempt.attemptNumber}`,
      content: baseContent,
    },
  ]
  if ((stage.expectedArtifacts ?? []).length > 0) {
    specs.push(...(stage.expectedArtifacts ?? []).map(artifact => ({
      kind: artifact.kind,
      title: `${artifact.title} v${attempt.attemptNumber}`,
      content: buildConfiguredArtifactMarkdown(session, ctx, stage, attempt, response, gateRecommendation, artifact),
      payload: {
        expectedArtifact: artifact,
        artifactRequired: artifact.required !== false,
        approvalRequired: stage.approvalRequired !== false,
      },
    })))
  } else if (stage.key === 'plan') {
    specs.push(
      { kind: 'mental_model', title: `Mental model v${attempt.attemptNumber}`, content: buildMentalModel(session, ctx) },
      { kind: 'gaps', title: `Gaps v${attempt.attemptNumber}`, content: buildGaps(session, ctx) },
    )
  } else if (stage.key === 'design') {
    specs.push(
      { kind: 'solution_architecture', title: `Solution architecture v${attempt.attemptNumber}`, content: buildSolutionArchitecture(session, ctx) },
      { kind: 'approved_spec_draft', title: `Spec draft v${attempt.attemptNumber}`, content: buildApprovedSpec(session, ctx, response) },
    )
  } else if (normalizeAgentRole(stage.agentRole).includes('DEV')) {
    specs.push(
      { kind: 'developer_task_pack', title: `Developer task pack v${attempt.attemptNumber}`, content: buildDeveloperTaskPack(session, ctx, response) },
      { kind: 'simulated_code_change', title: `Code-change evidence v${attempt.attemptNumber}`, content: buildCodeChangeEvidence(session, ctx) },
    )
  } else if (stage.key.includes('test') || stage.terminal) {
    specs.push(
      { kind: 'verification_rules', title: `Verification rules v${attempt.attemptNumber}`, content: buildVerificationRules(session, ctx) },
      { kind: 'traceability_matrix', title: `Traceability matrix v${attempt.attemptNumber}`, content: buildTraceabilityMatrix() },
      { kind: 'certification_receipt', title: `Certification receipt v${attempt.attemptNumber}`, content: buildCertificationReceipt(session, ctx) },
    )
  } else {
    specs.push({ kind: 'qa_task_pack', title: `QA task pack v${attempt.attemptNumber}`, content: buildQaTaskPack(session, ctx, response) })
  }

  const created = await Promise.all(specs.map(spec => prisma.blueprintArtifact.create({
    data: {
      sessionId: session.id,
      stage: legacyStage(stage),
      kind: spec.kind,
      title: spec.title,
      content: spec.content,
      payload: { ...commonPayload, ...(spec.payload ?? {}) } as Prisma.InputJsonValue,
    },
    select: { id: true },
  })))
  return created.map(item => item.id)
}

function buildConfiguredArtifactMarkdown(
  session: ArtifactSession,
  ctx: SnapshotContext,
  stage: LoopStageDefinition,
  attempt: StageAttempt,
  response: string,
  gate: GateRecommendation,
  artifact: LoopExpectedArtifact,
) {
  return [
    `# ${artifact.title}`,
    '',
    `Stage: ${stage.label} (${stage.key})`,
    `Agent role: ${stage.agentRole}`,
    `Attempt: ${attempt.attemptNumber}`,
    `Required: ${artifact.required !== false ? 'yes' : 'no'}`,
    `Format: ${artifact.format ?? 'MARKDOWN'}`,
    '',
    artifact.description ? `## Artifact intent\n${artifact.description}` : undefined,
    '## Workbench output',
    response || 'The execution layer did not return a detailed response; use the generated snapshot context and gate evidence below.',
    '',
    '## Gate recommendation',
    `- Verdict: ${gate.verdict}`,
    `- Confidence: ${Math.round(gate.confidence * 100)}%`,
    `- Reason: ${gate.reason}`,
    '',
    '## Source context signal',
    `- Goal: ${session.goal}`,
    `- Languages: ${Object.keys(ctx.languages).join(', ') || 'unknown'}`,
    `- Key files: ${ctx.keyFiles.slice(0, 5).join(', ') || 'none detected'}`,
    `- Sampled files: ${ctx.sampledFiles.length}`,
    '',
    '## Human approval',
    stage.approvalRequired !== false
      ? 'This artifact must be reviewed and approved, accepted with risk, or sent back before the loop can advance.'
      : 'This stage is configured for automatic progression after execution.',
  ].filter(Boolean).join('\n')
}

function loopStageTask(session: ArtifactSession, stage: LoopStageDefinition, state: LoopState): string {
  const latestAccepted = state.stageAttempts
    .filter(attempt => attempt.verdict === 'PASS' || attempt.verdict === 'ACCEPTED_WITH_RISK')
    .map(attempt => `${attempt.stageLabel}#${attempt.attemptNumber}: ${attempt.verdict}`)
    .join('\n') || 'No accepted stages yet.'
  const questions = (stage.questions ?? []).map(question => `- ${question.id}: ${question.question}${question.required ? ' (required)' : ''}`).join('\n') || '- No configured questions.'
  const artifacts = (stage.expectedArtifacts ?? []).map(artifact =>
    `- ${artifact.title} (${artifact.kind})${artifact.required !== false ? ' [required]' : ''}${artifact.description ? `: ${artifact.description}` : ''}`,
  ).join('\n') || '- No explicit artifact contract; produce the stage default artifact pack.'
  const sendBacks = state.reviewEvents.filter(event => event.type === 'SEND_BACK' || event.type === 'AUTO_SEND_BACK').slice(-5)
    .map(event => `- ${event.message}`)
    .join('\n') || '- No send-backs yet.'
  return [
    `Run Blueprint loop stage: ${stage.label}`,
    '',
    `Goal: ${session.goal}`,
    `Stage key: ${stage.key}`,
    `Agent role: ${stage.agentRole}`,
    '',
    'Stage description:',
    stage.description ?? 'No description supplied.',
    '',
    'Expected artifacts:',
    artifacts,
    '',
    'Configured questions:',
    questions,
    '',
    'Latest accepted stage decisions:',
    latestAccepted,
    '',
    'Recent feedback loops:',
    sendBacks,
    '',
    'Return concise, structured workbench output with: decisions, risks, artifact updates for every expected artifact, open questions, and a gate recommendation of PASS, NEEDS_REWORK, or BLOCKED.',
  ].join('\n')
}

function loopStageSystemPrompt(stage: LoopStageDefinition): string {
  return [
    `You are the ${stage.label} stage agent in a governed agentic delivery loop.`,
    'Be explicit about what should pass, what should go back, and why.',
    stage.approvalRequired !== false
      ? 'Human approval is required after artifact production; prepare the artifact evidence for review.'
      : 'This stage may proceed without human approval if policy allows.',
    'When uncertain, ask targeted questions and preserve traceability to files, requirements, and tests.',
    normalizeAgentRole(stage.agentRole).includes('DEV')
      ? 'Do not write source files. Produce a proposed implementation pack and simulated code-change evidence.'
      : normalizeAgentRole(stage.agentRole).includes('QA') || normalizeAgentRole(stage.agentRole).includes('TEST') || normalizeAgentRole(stage.agentRole).includes('VERIFY')
        ? 'Focus on verification, regressions, acceptance criteria, and certification proof.'
        : 'Focus on architecture, planning, constraints, and design decisions.',
  ].join(' ')
}

function buildStageInputSignature(
  snapshot: { rootHash: string | null },
  stage: LoopStageDefinition,
  agentTemplateId: string,
  task: string,
  state: LoopState,
): string {
  const accepted = state.stageAttempts
    .filter(attempt => attempt.verdict === 'PASS' || attempt.verdict === 'ACCEPTED_WITH_RISK')
    .map(attempt => ({
      stageKey: attempt.stageKey,
      attemptNumber: attempt.attemptNumber,
      verdict: attempt.verdict,
      artifactIds: attempt.artifactIds ?? [],
      acceptedAt: attempt.acceptedAt,
    }))
  const answers = state.decisionAnswers.map(answer => ({
    questionId: answer.questionId,
    answerType: answer.answerType,
    selectedOptionLabel: answer.selectedOptionLabel,
    customAnswer: answer.customAnswer,
    notes: answer.notes,
  }))
  return sha256(JSON.stringify({
    rootHash: snapshot.rootHash,
    stageKey: stage.key,
    agentRole: stage.agentRole,
    agentTemplateId,
    taskHash: sha256(task),
    accepted,
    answers,
  }))
}

function buildSnapshotExecuteArtifact(
  snapshot: { id?: string; summary: Prisma.JsonValue; manifest: Prisma.JsonValue; rootHash: string | null },
  input: {
    stageKey: string
    stageLabel: string
    task: string
    snapshotMode?: 'summary' | 'relevant_excerpts' | 'full_debug'
    excerptBudgetChars?: number
  },
): Record<string, unknown> {
  const summary = isRecord(snapshot.summary) ? snapshot.summary : {}
  const snapshotMode = input.snapshotMode ?? 'relevant_excerpts'
  const excerptBudgetChars = Math.min(input.excerptBudgetChars ?? EXECUTE_EXCERPT_BUDGET_CHARS, snapshotMode === 'full_debug' ? 120_000 : EXECUTE_EXCERPT_BUDGET_CHARS)
  const sampledFiles = Array.isArray(summary.sampledFiles)
    ? summary.sampledFiles.filter((file): file is { path: string; excerpt: string } =>
        isRecord(file) && typeof file.path === 'string' && typeof file.excerpt === 'string',
      )
    : []
  const manifest = Array.isArray(snapshot.manifest) ? snapshot.manifest as ManifestEntry[] : []
  const compactManifest = manifest.slice(0, EXECUTE_MANIFEST_MAX_FILES).map(file => ({
    path: file.path,
    size: file.size,
    language: file.language,
    sha: file.sha,
  }))
  const relevantExcerpts = snapshotMode === 'summary' ? [] : selectRelevantSnapshotExcerpts(sampledFiles, {
      ...input,
      maxFiles: snapshotMode === 'full_debug' ? MAX_EXCERPT_FILES : EXECUTE_EXCERPT_MAX_FILES,
      maxCharsPerFile: EXECUTE_EXCERPT_MAX_CHARS,
      totalBudgetChars: excerptBudgetChars,
    })
  const { sampledFiles: _omitted, ...compactSummary } = summary
  return {
    snapshotId: snapshot.id,
    rootHash: snapshot.rootHash,
    snapshotMode,
    compactSummary,
    compactManifest,
    manifestTruncated: manifest.length > compactManifest.length,
    relevantExcerpts,
    excerptBudgetChars,
    estimatedChars: JSON.stringify({ compactSummary, compactManifest, relevantExcerpts }).length,
    guidance: 'Use the snapshotId/rootHash as the stable source reference. Ask for more context only when these excerpts are insufficient.',
  }
}

function selectRelevantSnapshotExcerpts(
  files: Array<{ path: string; excerpt: string }>,
  input: { stageKey: string; stageLabel: string; task: string; maxFiles: number; maxCharsPerFile: number; totalBudgetChars: number },
): Array<{ path: string; excerpt: string; score: number }> {
  const keywords = snapshotKeywords(`${input.stageKey} ${input.stageLabel} ${input.task}`)
  let used = 0
  return files
    .map(file => ({
      ...file,
      score: snapshotExcerptScore(file, keywords),
    }))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, Math.max(input.maxFiles * 2, input.maxFiles))
    .reduce<Array<{ path: string; excerpt: string; score: number }>>((selected, file) => {
      if (selected.length >= input.maxFiles || used >= input.totalBudgetChars) return selected
      const remaining = input.totalBudgetChars - used
      const excerpt = file.excerpt.slice(0, Math.min(input.maxCharsPerFile, remaining)).trim()
      if (!excerpt) return selected
      selected.push({ path: file.path, excerpt, score: file.score })
      used += excerpt.length
      return selected
    }, [])
}

function snapshotKeywords(value: string): Set<string> {
  const tokens = value
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter(token => token.length >= 3 && !['the', 'and', 'for', 'with', 'this', 'that', 'from', 'stage', 'agent', 'return'].includes(token))
  return new Set(tokens.slice(0, 80))
}

function snapshotExcerptScore(file: { path: string; excerpt: string }, keywords: Set<string>): number {
  const pathText = file.path.toLowerCase()
  const excerptText = file.excerpt.toLowerCase()
  let score = 0
  for (const keyword of keywords) {
    if (pathText.includes(keyword)) score += 8
    if (excerptText.includes(keyword)) score += 2
  }
  if (/readme|claude|agents|skill|instruction|docs\//i.test(file.path)) score += 12
  if (/test|spec|rule|engine|operator|service|controller|model|schema/i.test(file.path)) score += 8
  if (/\.(ts|tsx|js|jsx|py|java|kt|go|rs)$/i.test(file.path)) score += 4
  return score
}

function buildGateRecommendation(result: ExecuteResponse, stage: LoopStageDefinition): GateRecommendation {
  if (result.status === 'FAILED') {
    return {
      verdict: 'BLOCKED',
      confidence: 0.95,
      reason: result.finishReason ?? 'Context Fabric reported a failed stage.',
      targetStageKey: stage.allowedSendBackTo?.[0],
    }
  }
  const warningCount = result.warnings?.length ?? 0
  if (warningCount > 1) {
    return {
      verdict: 'NEEDS_REWORK',
      confidence: 0.86,
      reason: `${warningCount} execution warnings were produced; human review should decide whether to send work back.`,
      targetStageKey: stage.allowedSendBackTo?.[0],
    }
  }
  return {
    verdict: 'PASS',
    confidence: 0.74,
    reason: 'No blocking execution signal was detected. Human review still owns the stage verdict.',
  }
}

function maybeApplyAutoGate(state: LoopState, stage: LoopStageDefinition, attemptId: string, actorId: string): LoopState {
  if (state.gateMode !== 'auto') return state
  const attempt = state.stageAttempts.find(item => item.id === attemptId)
  const rec = attempt?.gateRecommendation
  if (!attempt || !rec || rec.verdict === 'PASS' || rec.confidence < 0.9) return state
  const target = rec.targetStageKey && (stage.allowedSendBackTo ?? []).includes(rec.targetStageKey) ? rec.targetStageKey : undefined
  if (!target || sendBackCount(state) >= state.loopDefinition.maxTotalSendBacks) return state
  return {
    ...state,
    currentStageKey: target,
    stageAttempts: state.stageAttempts.map(item => item.id === attemptId ? {
      ...item,
      status: 'NEEDS_REWORK',
      verdict: rec.verdict,
      feedback: rec.reason,
    } : item),
    reviewEvents: [...state.reviewEvents, reviewEvent('AUTO_SEND_BACK', `${stage.label} automatically sent back to ${titleFromKey(target)}: ${rec.reason}`, actorId, {
      stageKey: stage.key,
      targetStageKey: target,
      attemptId,
      gateRecommendation: rec,
    })],
  }
}

function buildLoopStageMarkdown(
  session: ArtifactSession,
  ctx: SnapshotContext,
  stage: LoopStageDefinition,
  attempt: StageAttempt,
  response: string,
  gateRecommendation: GateRecommendation,
) {
  return [
    `# ${stage.label} Attempt ${attempt.attemptNumber}`,
    '',
    `Goal: ${session.goal}`,
    `Stage key: ${stage.key}`,
    `Agent role: ${stage.agentRole}`,
    '',
    '## Gate Recommendation',
    '',
    `- Verdict: ${gateRecommendation.verdict}`,
    `- Confidence: ${gateRecommendation.confidence}`,
    `- Reason: ${gateRecommendation.reason}`,
    '',
    '## Source Signals',
    '',
    `- Snapshot files: ${ctx.files.length}`,
    `- Key files: ${ctx.keyFiles.map(file => `\`${file}\``).join(', ') || 'none detected'}`,
    '',
    '## Model Notes',
    '',
    response || 'No model notes returned.',
  ].join('\n')
}

function findLoopStage(state: LoopState, stageKey: string): LoopStageDefinition {
  const stage = state.loopDefinition.stages.find(item => item.key === slug(stageKey) || item.key === stageKey)
  if (!stage) throw new NotFoundError('BlueprintLoopStage', stageKey)
  return stage
}

function latestStageAttempt(state: LoopState, stageKey: string): StageAttempt | undefined {
  return state.stageAttempts.filter(attempt => attempt.stageKey === stageKey).at(-1)
}

function verdictToAttemptStatus(verdict: LoopVerdict): LoopAttemptStatus {
  return verdict === 'PASS' ? 'PASSED' : verdict
}

function missingRequiredQuestions(stage: LoopStageDefinition, answers: DecisionAnswer[]): string[] {
  const answered = new Set(answers.filter(answer =>
    answer.selectedOptionLabel?.trim() || answer.customAnswer?.trim() || answer.notes?.trim(),
  ).map(answer => answer.questionId))
  return (stage.questions ?? []).filter(question => question.required && !answered.has(question.id)).map(question => question.id)
}

function mergeDecisionAnswers(existing: DecisionAnswer[], incoming: DecisionAnswer[], actorId: string): DecisionAnswer[] {
  const byId = new Map(existing.map(answer => [answer.questionId, answer]))
  const updatedAt = new Date().toISOString()
  for (const answer of incoming) {
    byId.set(answer.questionId, {
      questionId: answer.questionId,
      answerType: answer.answerType,
      selectedOptionLabel: answer.selectedOptionLabel?.trim() || undefined,
      customAnswer: answer.customAnswer?.trim() || undefined,
      notes: answer.notes?.trim() || undefined,
      updatedAt,
      updatedById: actorId,
    })
  }
  return Array.from(byId.values())
}

function isLoopGreen(state: LoopState): boolean {
  return state.loopDefinition.stages
    .filter(stage => stage.required !== false)
    .every(stage => {
      const attempt = latestStageAttempt(state, stage.key)
      return attempt?.verdict === 'PASS' || attempt?.verdict === 'ACCEPTED_WITH_RISK'
    })
}

function sendBackCount(state: LoopState): number {
  return state.reviewEvents.filter(event => event.type === 'SEND_BACK' || event.type === 'AUTO_SEND_BACK').length
}

function reviewEvent(type: string, message: string, actorId: string, payload: Record<string, unknown> = {}): ReviewEvent {
  return {
    id: crypto.randomUUID(),
    type,
    stageKey: typeof payload.stageKey === 'string' ? payload.stageKey : undefined,
    targetStageKey: typeof payload.targetStageKey === 'string' ? payload.targetStageKey : undefined,
    attemptId: typeof payload.attemptId === 'string' ? payload.attemptId : undefined,
    message,
    actorId,
    payload,
    createdAt: new Date().toISOString(),
  }
}

function legacyStage(stage: LoopStageDefinition): BlueprintStage {
  const role = normalizeAgentRole(stage.agentRole)
  if (role.includes('DEV') || role === 'ENGINEER') return BlueprintStage.DEVELOPER
  if (role.includes('QA') || role.includes('TEST') || role.includes('VERIFY')) return BlueprintStage.QA
  return BlueprintStage.ARCHITECT
}

function buildFinalPack(state: LoopState, artifacts: Array<{ id: string; kind: string; payload?: Prisma.JsonValue | null }>, actorId: string): FinalPack {
  const latestAccepted = state.loopDefinition.stages.reduce<FinalPack['stages']>((acc, stage) => {
    const attempt = latestStageAttempt(state, stage.key)
    if (!attempt || (attempt.verdict !== 'PASS' && attempt.verdict !== 'ACCEPTED_WITH_RISK')) return acc
    acc.push({
      stageKey: stage.key,
      label: stage.label,
      verdict: attempt.verdict,
      attemptNumber: attempt.attemptNumber,
      artifactIds: attempt.artifactIds ?? [],
    })
    return acc
  }, [])
  const artifactKinds = new Set<string>()
  for (const artifact of artifacts) {
    const payload = isRecord(artifact.payload) ? artifact.payload : {}
    if (latestAccepted.some(stage => stage.artifactIds.includes(artifact.id)) || payload.stageKey) artifactKinds.add(artifact.kind)
  }
  return {
    id: crypto.randomUUID(),
    status: 'READY_FOR_WORKFLOW_HANDOFF',
    generatedAt: new Date().toISOString(),
    generatedById: actorId,
    summary: `Final pack combines ${latestAccepted.length} accepted loop stages with ${state.decisionAnswers.length} captured stakeholder answers.`,
    stages: latestAccepted,
    artifactKinds: Array.from(artifactKinds).sort(),
  }
}

function buildFinalPackMarkdown(finalPack: FinalPack, state: LoopState) {
  return [
    '# Final Implementation Pack',
    '',
    `Status: ${finalPack.status}`,
    `Generated: ${finalPack.generatedAt}`,
    '',
    '## Summary',
    '',
    finalPack.summary,
    '',
    '## Accepted Stages',
    '',
    ...finalPack.stages.map(stage => `- ${stage.label}: ${stage.verdict} on attempt ${stage.attemptNumber}`),
    '',
    '## Stakeholder Answers',
    '',
    ...(state.decisionAnswers.length
      ? state.decisionAnswers.map(answer => `- ${answer.questionId}: ${answer.selectedOptionLabel ?? answer.customAnswer ?? answer.notes ?? 'answered'}`)
      : ['- No stakeholder answers captured.']),
    '',
    '## Artifact Kinds',
    '',
    ...finalPack.artifactKinds.map(kind => `- ${kind}`),
  ].join('\n')
}

async function attachFinalPackToWorkflowNode(
  session: { id: string; workflowInstanceId?: string | null; metadata?: Prisma.JsonValue },
  finalPack: FinalPack,
  actorId: string,
) {
  const state = readLoopState(session as LoopSessionSeed)
  if (!session.workflowInstanceId || !state.workflowNodeId) return
  const node = await prisma.workflowNode.findFirst({
    where: { id: state.workflowNodeId, instanceId: session.workflowInstanceId },
    select: { id: true, config: true, instanceId: true },
  })
  if (!node) return
  const config = isRecord(node.config) ? node.config : {}
  const workbench = isRecord(config.workbench) ? config.workbench : {}
  const outputs = isRecord(workbench.outputs) ? workbench.outputs : {}
  const finalPackKey = typeof outputs.finalPackKey === 'string' && outputs.finalPackKey.trim()
    ? outputs.finalPackKey.trim()
    : 'finalImplementationPack'
  const nextConfig = {
    ...config,
    workbench: {
      ...workbench,
      sessionId: session.id,
      finalPack,
      output: {
        blueprintSessionId: session.id,
        workbenchStatus: 'FINALIZED',
        [finalPackKey]: finalPack,
      },
      finalizedAt: finalPack.generatedAt,
    },
  }
  await prisma.$transaction([
    prisma.workflowNode.update({
      where: { id: node.id },
      data: { config: nextConfig as Prisma.InputJsonValue },
    }),
    prisma.workflowMutation.create({
      data: {
        instanceId: node.instanceId,
        nodeId: node.id,
        mutationType: 'BLUEPRINT_FINAL_PACK_ATTACHED',
        beforeState: { workbench } as Prisma.InputJsonValue,
        afterState: { workbench: nextConfig.workbench } as Prisma.InputJsonValue,
        performedById: actorId,
      },
    }),
  ])
  await logEvent('BlueprintFinalPackAttachedToWorkflowNode', 'WorkflowNode', node.id, actorId, {
    sessionId: session.id,
    finalPackId: finalPack.id,
    workflowInstanceId: node.instanceId,
  })
  await publishOutbox('WorkflowNode', node.id, 'BlueprintFinalPackAttached', {
    sessionId: session.id,
    finalPackId: finalPack.id,
    workflowInstanceId: node.instanceId,
    actorId,
  })
}

async function runStage(
  session: Awaited<ReturnType<typeof prisma.blueprintSession.findUnique>> & { id: string },
  snapshot: { id?: string; summary: Prisma.JsonValue; manifest: Prisma.JsonValue; rootHash: string | null },
  stage: BlueprintStage,
  agentTemplateId: string,
  task: string,
): Promise<ExecuteResponse> {
  const traceId = `blueprint-${session.id}-${stage.toLowerCase()}`
  const executionConfig = readLoopState(session).executionConfig
  const snapshotArtifact = buildSnapshotExecuteArtifact(snapshot, {
    stageKey: stage.toLowerCase(),
    stageLabel: humanStage(stage),
    task,
    snapshotMode: executionConfig?.snapshotMode,
    excerptBudgetChars: executionConfig?.excerptBudgetChars,
  })
  return contextFabricClient.execute({
    trace_id: traceId,
    idempotency_key: `${session.id}:${stage}`,
    run_context: {
      workflow_instance_id: session.workflowInstanceId ?? `blueprint-${session.id}`,
      workflow_node_id: session.phaseId ?? `blueprint-${stage.toLowerCase()}`,
      capability_id: session.capabilityId,
      agent_template_id: agentTemplateId,
      user_id: session.createdById ?? undefined,
      trace_id: traceId,
    },
    task,
    vars: {
      blueprintSessionId: session.id,
      sourceType: session.sourceType,
      sourceUri: session.sourceUri,
      sourceRef: session.sourceRef,
      stage,
    },
    artifacts: [
      {
        label: 'Source snapshot',
        role: 'CONTEXT',
        mediaType: 'application/json',
        content: JSON.stringify(snapshotArtifact, null, 2),
      },
    ],
    overrides: {
      systemPromptAppend: stageSystemPrompt(stage),
      extraContext: 'This MVP must not mutate source code. Coding output is a simulated, reviewable proposal with evidence.',
    },
    model_overrides: { provider: 'mock', model: 'mock-fast', temperature: 0.2, maxOutputTokens: 1200 },
    context_policy: {
      optimizationMode: 'code_aware',
      maxContextTokens: 6000,
      compareWithRaw: false,
      knowledgeTopK: 4,
      memoryTopK: 2,
      codeTopK: 5,
      maxLayerChars: 2000,
      maxPromptChars: 24_000,
    },
    limits: {
      maxSteps: 3,
      timeoutSec: 180,
      inputTokenBudget: 6000,
      outputTokenBudget: 1200,
      maxHistoryMessages: 4,
      maxToolResultChars: 8000,
      maxPromptChars: 24_000,
    },
  })
}

async function recordBlueprintBudgetUsage(
  session: { workflowInstanceId?: string | null; workflowNodeId?: string | null; phaseId?: string | null },
  result: ExecuteResponse,
  stageKey: string,
  workflowNodeId?: string | null,
) {
  if (!session.workflowInstanceId) return
  try {
    await recordWorkflowLlmUsage(session.workflowInstanceId, {
      nodeId: workflowNodeId ?? session.workflowNodeId ?? session.phaseId ?? null,
      cfCallId: result.correlation.cfCallId,
      promptAssemblyId: result.correlation.promptAssemblyId,
      inputTokens: result.tokensUsed?.input,
      outputTokens: result.tokensUsed?.output,
      totalTokens: result.tokensUsed?.total,
      estimatedCost: result.modelUsage?.estimatedCost,
      provider: result.modelUsage?.provider,
      model: result.modelUsage?.model,
      metadata: {
        source: 'blueprint-workbench',
        stageKey,
        finishReason: result.finishReason,
        status: result.status,
        tokensSaved: result.usage?.tokensSaved,
      },
    })
  } catch (err) {
    await logEvent('WorkflowBudgetUsageRecordFailed', 'WorkflowInstance', session.workflowInstanceId, undefined, {
      stageKey,
      cfCallId: result.correlation.cfCallId,
      error: (err as Error).message,
    })
  }
}

type ArtifactSession = {
  id: string
  goal: string
  sourceType: BlueprintSourceType
  sourceUri: string
  metadata?: Prisma.JsonValue
}

type ArtifactSnapshot = {
  summary: Prisma.JsonValue
  manifest: Prisma.JsonValue
  rootHash: string | null
}

async function createStageArtifacts(session: ArtifactSession, snapshot: ArtifactSnapshot, stage: BlueprintStage, result: ExecuteResponse) {
  const ctx = buildSnapshotContext(snapshot)
  const response = isUsefulModelResponse(result.finalResponse)
    ? `\n\n## Model notes\n\n${result.finalResponse}`
    : ''
  const commonPayload = {
    cfCallId: result.correlation.cfCallId,
    traceId: result.correlation.traceId,
    promptAssemblyId: result.correlation.promptAssemblyId,
    mcpInvocationId: result.correlation.mcpInvocationId,
    codeChangeIds: result.correlation.codeChangeIds ?? [],
    status: result.status,
    warnings: result.warnings ?? [],
  }
  type ArtifactSpec = { kind: string; title: string; content: string; payload?: Record<string, unknown> }
  const artifacts =
    stage === BlueprintStage.ARCHITECT ? [
      { kind: 'decision_tree', title: 'Question tree', content: buildDecisionTreeMarkdown(session, ctx), payload: { tree: buildDecisionTreePayload(session, ctx) } },
      { kind: 'agent_questions', title: 'Agent questions', content: buildAgentQuestions(session, ctx) },
      { kind: 'mental_model', title: 'Mental model', content: buildMentalModel(session, ctx) },
      { kind: 'gaps', title: 'Gaps and open questions', content: buildGaps(session, ctx) },
      { kind: 'solution_architecture', title: 'Solution architecture', content: buildSolutionArchitecture(session, ctx) },
      { kind: 'approved_spec_draft', title: 'Approved spec draft', content: buildApprovedSpec(session, ctx, response) },
    ] :
	    stage === BlueprintStage.DEVELOPER ? [
	      { kind: 'developer_task_pack', title: 'Developer task pack', content: buildDeveloperTaskPack(session, ctx, response) },
	      { kind: 'simulated_code_change', title: 'Simulated code-change evidence', content: buildCodeChangeEvidence(session, ctx) },
	    ] : [
	      { kind: 'implementation_contract', title: 'Implementation contract', content: buildImplementationContractMarkdown(session, ctx, readSessionDecisionAnswers(session)), payload: { contract: buildImplementationContractPayload(session, ctx, readSessionDecisionAnswers(session)) } },
	      { kind: 'qa_task_pack', title: 'QA task pack', content: buildQaTaskPack(session, ctx, response) },
	      { kind: 'verification_rules', title: 'Verification rules', content: buildVerificationRules(session, ctx) },
	      { kind: 'traceability_matrix', title: 'Traceability matrix', content: buildTraceabilityMatrix() },
	      { kind: 'certification_receipt', title: 'Certification receipt', content: buildCertificationReceipt(session, ctx) },
	    ] satisfies ArtifactSpec[]

  await prisma.blueprintArtifact.createMany({
    data: artifacts.map((artifact) => ({
      sessionId: session.id,
      stage,
      kind: artifact.kind,
      title: artifact.title,
      content: artifact.content,
      payload: { ...commonPayload, ...(artifact.payload ?? {}) } as Prisma.InputJsonValue,
    })),
  })
}

type SnapshotContext = {
  files: ManifestEntry[]
  sampledFiles: Array<{ path: string; excerpt: string }>
  languages: Record<string, number>
  keyFiles: string[]
  hasBetweenEnum: boolean
  hasBetweenSwitch: boolean
  hasLengthCase: boolean
  hasLengthEnum: boolean
}

function buildSnapshotContext(snapshot: ArtifactSnapshot): SnapshotContext {
  const files = Array.isArray(snapshot.manifest) ? snapshot.manifest as ManifestEntry[] : []
  const summary = isRecord(snapshot.summary) ? snapshot.summary : {}
  const sampledFiles = Array.isArray(summary.sampledFiles)
    ? summary.sampledFiles.filter((f): f is { path: string; excerpt: string } =>
        isRecord(f) && typeof f.path === 'string' && typeof f.excerpt === 'string',
      )
    : []
  const languages = isRecord(summary.languages) ? Object.fromEntries(
    Object.entries(summary.languages).filter(([, v]) => typeof v === 'number'),
  ) as Record<string, number> : {}
  const keyFiles = files
    .map(f => f.path)
    .filter(p => /RuleEngineService|Operator|Controller|EvaluateRequest|EvaluateResponse|RuleEngine.*Test/.test(p))
    .slice(0, 12)
  const operator = sampledFiles.find(f => f.path.endsWith('Operator.java'))?.excerpt ?? ''
  const service = sampledFiles.find(f => f.path.endsWith('RuleEngineService.java'))?.excerpt ?? ''
  return {
    files,
    sampledFiles,
    languages,
    keyFiles,
    hasBetweenEnum: /\bbetween\b/.test(operator),
    hasBetweenSwitch: /case\s+between\s*:/.test(service),
    hasLengthCase: /case\s+length\s*:/.test(service),
    hasLengthEnum: /\blength\b/.test(operator),
  }
}

function buildAgentQuestions(session: ArtifactSession, ctx: SnapshotContext) {
  return [
    '# Agent Questions',
    '',
    `Goal: ${session.goal}`,
    '',
    '## Architect questions',
    '',
    '- Should `between` be inclusive on both ends (`min <= value <= max`)? The existing service implementation appears inclusive.',
    '- Should `between` support only numbers, or also dates/instants and comparable strings?',
    '- What should happen when the lower bound is greater than the upper bound: reject the rule or return false?',
    '- Should missing/null field values return false or raise a validation error?',
    '',
    '## Developer questions',
    '',
    `- The scan ${ctx.hasBetweenEnum ? 'found' : 'did not find'} ` + '`between` in `Operator.java`.',
    `- The scan ${ctx.hasBetweenSwitch ? 'found' : 'did not find'} a ` + '`case between` branch in `RuleEngineService.java`.',
    '- Should the change mainly add tests/docs, or should the implementation be refactored for stronger validation?',
    ctx.hasLengthCase && !ctx.hasLengthEnum
      ? '- There is a compile-risk signal: `RuleEngineService` references `case length`, but `Operator.java` does not appear to declare `length`.'
      : '- No compile-risk signal was detected from the sampled enum/switch relationship.',
    '',
    '## QA questions',
    '',
    '- Which boundary cases are mandatory: exactly min, exactly max, below min, above max, null, missing field, bad value shape?',
    '- Do API/controller tests need to cover `between`, or is service-level coverage enough for this increment?',
    '- Should invalid `value` arrays produce a 400 response through `GlobalExceptionHandler`?',
  ].join('\n')
}

function buildDecisionTreePayload(session: ArtifactSession, ctx: SnapshotContext) {
  return {
    title: 'Between operator decision tree',
    goal: session.goal,
    nodes: [
      {
        id: 'Q-ARCH-001',
        lane: 'Architect',
        question: 'Should `between` be inclusive on both ends?',
        recommended: 'Yes. Use `min <= fieldValue <= max`.',
        evidence: ctx.hasBetweenSwitch
          ? 'The scanned evaluator already compares with >= lower bound and <= upper bound.'
          : 'Existing comparison operators include lt/lte/gt/gte; inclusive range matches common rule-engine expectations.',
        options: [
          { label: 'Inclusive bounds', status: 'recommended', impact: 'Matches common business rules and boundary QA cases.' },
          { label: 'Exclusive bounds', status: 'not recommended', impact: 'Requires new semantics and additional operator naming such as betweenExclusive.' },
        ],
        downstream: ['DEV-001 verify evaluator branch', 'QA-001 boundary tests'],
      },
      {
        id: 'Q-ARCH-002',
        lane: 'Architect',
        question: 'Which value types should `between` support?',
        recommended: 'Use the existing `compare(...)` behavior for numbers/dates/strings; document exact supported coercions.',
        evidence: 'RuleEngineService already centralizes comparisons through `compare(...)` for lt/lte/gt/gte.',
        options: [
          { label: 'Reuse compare(...)', status: 'recommended', impact: 'Smallest implementation, consistent with existing operators.' },
          { label: 'Numbers only', status: 'safe but narrow', impact: 'Simpler validation but weaker platform capability.' },
          { label: 'Custom range comparator', status: 'defer', impact: 'More control, more test burden.' },
        ],
        downstream: ['DEV-001 contract verification', 'QA-002 malformed value tests'],
      },
      {
        id: 'Q-DEV-001',
        lane: 'Developer',
        question: 'Is implementation required or is this mostly certification?',
        recommended: ctx.hasBetweenEnum && ctx.hasBetweenSwitch
          ? 'Treat as certification/hardening: add tests, docs, and validation review.'
          : 'Add enum support and evaluator implementation before tests.',
        evidence: `Scan result: enum=${ctx.hasBetweenEnum ? 'found' : 'missing'}, evaluator=${ctx.hasBetweenSwitch ? 'found' : 'missing'}.`,
        options: [
          { label: 'Harden existing implementation', status: ctx.hasBetweenEnum && ctx.hasBetweenSwitch ? 'recommended' : 'blocked', impact: 'Fast path when code already exists.' },
          { label: 'Implement from scratch', status: ctx.hasBetweenEnum && ctx.hasBetweenSwitch ? 'avoid duplicate' : 'recommended', impact: 'Needed only when enum/evaluator branch is absent.' },
        ],
        downstream: ['DEV-002 service tests', 'DEV-003 API example'],
      },
      {
        id: 'Q-DEV-002',
        lane: 'Developer',
        question: 'Should compile-risk be fixed in this change?',
        recommended: ctx.hasLengthCase && !ctx.hasLengthEnum
          ? 'Yes. Resolve the `length` enum/switch mismatch before certifying the feature.'
          : 'No extra compile-risk fix detected from sampled files.',
        evidence: ctx.hasLengthCase && !ctx.hasLengthEnum
          ? '`RuleEngineService` references `case length`, but `Operator.java` did not declare `length` in the scanned excerpt.'
          : 'No enum/switch mismatch detected.',
        options: [
          { label: 'Fix now', status: ctx.hasLengthCase && !ctx.hasLengthEnum ? 'recommended' : 'optional', impact: 'Prevents build failure from blocking between-operator QA.' },
          { label: 'Separate task', status: 'risk accepted', impact: 'Keeps scope tight but may fail `mvn test`.' },
        ],
        downstream: ['VR-004 mvn test', 'Certification receipt'],
      },
      {
        id: 'Q-QA-001',
        lane: 'QA',
        question: 'Which tests prove the operator?',
        recommended: 'Use boundary, malformed input, null/missing field, and controller-path tests.',
        evidence: 'Snapshot includes service tests and controller tests, so both layers can be covered.',
        options: [
          { label: 'Service + API tests', status: 'recommended', impact: 'Best confidence for developer-facing certification.' },
          { label: 'Service only', status: 'minimum', impact: 'Faster but misses API error mapping.' },
        ],
        downstream: ['QA-001', 'QA-002', 'QA-003', 'VR-002', 'VR-003'],
      },
    ],
  }
}

function buildDecisionTreeMarkdown(session: ArtifactSession, ctx: SnapshotContext) {
  const tree = buildDecisionTreePayload(session, ctx)
  return [
    '# Question Tree',
    '',
    `Goal: ${session.goal}`,
    '',
    ...tree.nodes.flatMap(node => [
      `## ${node.id}: ${node.question}`,
      '',
      `Lane: ${node.lane}`,
      '',
      `Recommended: ${node.recommended}`,
      '',
      `Evidence: ${node.evidence}`,
      '',
      'Options:',
      ...node.options.map(option => `- ${option.label} (${option.status}): ${option.impact}`),
      '',
      `Downstream: ${node.downstream.join(', ')}`,
      '',
    ]),
  ].join('\n')
}

function buildMentalModel(session: ArtifactSession, ctx: SnapshotContext) {
  return [
    '# Mental Model',
    '',
    `The requested feature is a rule-engine operator change: ${session.goal}`,
    '',
    'The scanned project is a Java/Spring rule engine. A request reaches the API controller, is mapped into DTOs, and delegates rule evaluation to `RuleEngineService`. Operators are represented by the `Operator` enum and evaluated in a switch inside `RuleEngineService`.',
    '',
    '## Codebase signals',
    '',
    `- Snapshot files: ${ctx.files.length}`,
    `- Languages: ${Object.entries(ctx.languages).map(([k, v]) => `${k} ${v}`).join(', ') || 'not available'}`,
    `- Key files: ${ctx.keyFiles.map(f => `\`${f}\``).join(', ')}`,
    `- \`between\` in enum: ${ctx.hasBetweenEnum ? 'yes' : 'no'}`,
    `- \`between\` in evaluator switch: ${ctx.hasBetweenSwitch ? 'yes' : 'no'}`,
    '',
    '## Working theory',
    '',
    ctx.hasBetweenEnum && ctx.hasBetweenSwitch
      ? '`between` looks partially or fully implemented already. The useful next step is to verify behavior, strengthen validation, and add tests/documentation so the feature is certified.'
      : '`between` needs to be added to the operator contract and evaluator dispatch, then covered through service and API tests.',
  ].join('\n')
}

function buildGaps(_session: ArtifactSession, ctx: SnapshotContext) {
  return [
    '# Gaps and Open Questions',
    '',
    '## Confirmed gaps from scan',
    '',
    ctx.hasBetweenEnum && ctx.hasBetweenSwitch
      ? '- Implementation signal exists for `between`, but certification evidence is missing in the generated workbench artifacts.'
      : '- `between` implementation is not fully visible in the scanned enum/evaluator files.',
    '- Need explicit tests for inclusive lower/upper boundaries.',
    '- Need tests for invalid `value` payloads: non-array, one-element array, three-element array, non-comparable values.',
    '- Need API-level examples or README update showing the JSON rule shape.',
    ctx.hasLengthCase && !ctx.hasLengthEnum
      ? '- Compile-risk: `case length` appears in `RuleEngineService`, but `length` was not detected in `Operator.java`.'
      : '- No enum/switch compile-risk was detected for sampled files.',
    '',
    '## Product decisions needed',
    '',
    '- Numeric/date/string support policy.',
    '- Inclusive vs exclusive bounds.',
    '- Validation behavior for reversed bounds.',
    '- Error response shape for malformed rules.',
  ].join('\n')
}

function buildSolutionArchitecture(session: ArtifactSession, ctx: SnapshotContext) {
  return [
    '# Solution Architecture',
    '',
    `Feature: ${session.goal}`,
    '',
    '## Recommended implementation',
    '',
    '1. Treat `between` as an inclusive range operator: `min <= fieldValue <= max`.',
    '2. Keep `Operator` as the source of truth for valid operator names.',
    '3. Keep evaluation inside `RuleEngineService.evalCondition` to match the existing operator architecture.',
    '4. Validate `value` is exactly a two-item array before comparing.',
    '5. Use the existing `compare(...)` path so number/date/string comparison behavior stays consistent with `lt/lte/gt/gte`.',
    '6. Add focused service tests and one API test to prove request-level behavior.',
    '',
    '## Impacted files',
    '',
    ...ctx.keyFiles.map(f => `- \`${f}\``),
    '',
    '## Current scan assessment',
    '',
    ctx.hasBetweenEnum && ctx.hasBetweenSwitch
      ? 'The code already shows `between` in the enum and evaluator branch. The architecture task should therefore certify, test, and harden the existing implementation rather than blindly adding duplicate logic.'
      : 'The code needs enum and evaluator additions before tests can pass.',
  ].join('\n')
}

function buildApprovedSpec(session: ArtifactSession, ctx: SnapshotContext, response: string) {
  return [
    '# approved-spec.md',
    '',
    '## Problem Statement',
    '',
    session.goal,
    '',
    '## Functional Requirements',
    '',
    '- REQ-001: The rule engine must accept `op: "between"` in rule JSON.',
    '- REQ-002: `between` must require `value` to be an array with exactly `[min, max]`.',
    '- REQ-003: Evaluation must return true when the field value is greater than or equal to min and less than or equal to max.',
    '- REQ-004: Evaluation must return false for null or missing field values unless existing comparison policy says otherwise.',
    '- REQ-005: Malformed `between` rules must produce a clear validation error.',
    '',
    '## Non-goals',
    '',
    '- Do not introduce a new rule DSL.',
    '- Do not change existing comparison semantics except where needed for `between` validation.',
    '- Do not mutate repository files in this MVP workbench run.',
    '',
    '## Acceptance Criteria',
    '',
    '- Service tests cover below min, exactly min, inside range, exactly max, and above max.',
    '- Tests cover malformed `value` payloads.',
    '- API test demonstrates a valid `between` rule through the controller.',
    ctx.hasLengthCase && !ctx.hasLengthEnum ? '- Resolve the `length` enum/switch mismatch before certification.' : '- Existing enum/switch shape remains consistent.',
    response,
  ].join('\n')
}

function buildDeveloperTaskPack(session: ArtifactSession, ctx: SnapshotContext, response: string) {
  return [
    '# developer-task-pack.yaml',
    '',
    'developer_tasks:',
    '  - id: DEV-001',
    '    title: Verify between operator contract',
    '    linked_requirements: [REQ-001, REQ-002]',
    '    expected_files:',
    '      - src/main/java/org/example/rules/Operator.java',
    '      - src/main/java/org/example/rules/RuleEngineService.java',
    `    notes: "${ctx.hasBetweenEnum && ctx.hasBetweenSwitch ? 'Implementation signal already exists; inspect and harden.' : 'Add enum value and evaluator branch.'}"`,
    '  - id: DEV-002',
    '    title: Add service-level coverage for between',
    '    linked_requirements: [REQ-003, REQ-004, REQ-005]',
    '    expected_files:',
    '      - src/test/java/org/example/rules/RuleEngineServiceTest.java',
    '  - id: DEV-003',
    '    title: Add API-level example/coverage',
    '    linked_requirements: [REQ-001, REQ-005]',
    '    expected_files:',
    '      - src/test/java/org/example/api/RuleEngineControllerTest.java',
    '      - README.md',
    '',
    `# Goal: ${session.goal}`,
    response,
  ].join('\n')
}

function buildCodeChangeEvidence(_session: ArtifactSession, ctx: SnapshotContext) {
  return [
    '# code-change-evidence.yaml',
    '',
    'simulated_change_set:',
    '  mode: read_only_mvp',
    '  repository_mutated: false',
    '  expected_paths:',
    ...ctx.keyFiles.map(f => `    - ${f}`),
    '  summary:',
    '    - Verify or add inclusive `between` support.',
    '    - Add boundary and malformed payload tests.',
    '    - Update README/API examples if missing.',
  ].join('\n')
}

function buildQaTaskPack(session: ArtifactSession, _ctx: SnapshotContext, response: string) {
  return [
    '# qa-task-pack.yaml',
    '',
    'qa_tasks:',
    '  - id: QA-001',
    '    title: Boundary coverage',
    '    scenarios:',
    '      - value below min returns false',
    '      - value equal to min returns true',
    '      - value inside range returns true',
    '      - value equal to max returns true',
    '      - value above max returns false',
    '  - id: QA-002',
    '    title: Malformed rule coverage',
    '    scenarios:',
    '      - missing value',
    '      - non-array value',
    '      - array with fewer or more than two values',
    '      - non-comparable bounds',
    '  - id: QA-003',
    '    title: API behavior',
    '    scenarios:',
    '      - valid between rule through controller',
    '      - invalid between rule maps to expected error response',
    '',
    `# Goal: ${session.goal}`,
    response,
  ].join('\n')
}

function buildImplementationContractPayload(session: ArtifactSession, ctx: SnapshotContext, decisionAnswers: DecisionAnswer[] = []) {
  const compileRisk = ctx.hasLengthCase && !ctx.hasLengthEnum
  const inclusiveDecision = answerText(decisionAnswers, 'Q-ARCH-001', 'Inclusive `min <= fieldValue <= max` semantics.')
  const valueTypeDecision = answerText(decisionAnswers, 'Q-ARCH-002', 'Reuse existing `compare(...)` behavior for comparable values.')
  const implementationDecision = answerText(decisionAnswers, 'Q-DEV-001', ctx.hasBetweenEnum && ctx.hasBetweenSwitch
    ? 'Harden existing implementation rather than duplicating logic.'
    : 'Add the missing enum/evaluator implementation.')
  const compileRiskDecision = answerText(decisionAnswers, 'Q-DEV-002', compileRisk
    ? 'Fix the detected compile risk in this implementation increment.'
    : 'No compile-risk fix is required from the sampled files.')
  const qaDecision = answerText(decisionAnswers, 'Q-QA-001', 'Use service and API tests for certification.')
  return {
    title: 'Final implementation contract',
    status: 'READY_FOR_IMPLEMENTATION_REVIEW',
    goal: session.goal,
    capturedDecisions: decisionAnswers.map(answer => ({
      questionId: answer.questionId,
      answer: answer.answerType === 'option' ? answer.selectedOptionLabel : answer.customAnswer,
      notes: answer.notes,
      updatedAt: answer.updatedAt,
    })),
    stakeholderInputs: [
      {
        role: 'Architect',
        contribution: `Defines operator semantics and boundaries. Decision: ${inclusiveDecision} Value policy: ${valueTypeDecision}`,
        outputs: ['REQ-001..REQ-005', 'architecture decisions', 'gaps'],
      },
      {
        role: 'Developer',
        contribution: `Owns implementation and hardening. Decision: ${implementationDecision} Compile policy: ${compileRiskDecision}`,
        outputs: ['DEV-001', 'DEV-002', 'DEV-003', 'simulated change evidence'],
      },
      {
        role: 'QA',
        contribution: `Turns the requirement set into executable verification. Decision: ${qaDecision}`,
        outputs: ['QA-001', 'QA-002', 'QA-003', 'VR-001..VR-004'],
      },
    ],
    implementationUnits: [
      {
        id: 'IMP-001',
        title: 'Operator contract',
        owner: 'Developer',
        files: ['src/main/java/org/example/rules/Operator.java'],
        instructions: ctx.hasBetweenEnum
          ? 'Confirm `between` remains in the enum and is documented as a supported operator.'
          : 'Add `between` to the operator enum and make it available to request validation.',
        acceptance: ['REQ-001', 'VR-001'],
      },
      {
        id: 'IMP-002',
        title: 'Evaluator behavior',
        owner: 'Developer',
        files: ['src/main/java/org/example/rules/RuleEngineService.java'],
        instructions: ctx.hasBetweenSwitch
          ? `Verify the evaluator follows the chosen range rule: ${inclusiveDecision}`
          : `Add a \`between\` evaluator branch following the chosen range rule: ${inclusiveDecision}`,
        acceptance: ['REQ-002', 'REQ-003', 'VR-002'],
      },
      {
        id: 'IMP-003',
        title: 'Validation and error behavior',
        owner: 'Architect + Developer',
        files: ['src/main/java/org/example/api/GlobalExceptionHandler.java', 'src/main/java/org/example/api/dto/EvaluateRequest.java'],
        instructions: `Make malformed \`between\` payloads predictable. Value type policy: ${valueTypeDecision}`,
        acceptance: ['REQ-005', 'VR-003'],
      },
      {
        id: 'IMP-004',
        title: 'Proof and certification',
        owner: 'QA',
        files: ['src/test/java/org/example/rules/RuleEngineServiceTest.java', 'src/test/java/org/example/api/RuleEngineControllerTest.java', 'README.md'],
        instructions: `Add proof for the chosen QA policy: ${qaDecision}`,
        acceptance: ['QA-001', 'QA-002', 'QA-003', 'VR-004'],
      },
    ],
    finalChecklist: [
      `Range behavior decision: ${inclusiveDecision}`,
      `Value policy decision: ${valueTypeDecision}`,
      `Implementation decision: ${implementationDecision}`,
      `Compile-risk decision: ${compileRiskDecision}`,
      'Run the project test command and attach logs to the workflow handoff.',
    ],
    handoffArtifacts: [
      'Question tree',
      'Approved spec draft',
      'Developer task pack',
      'QA task pack',
      'Verification rules',
      'Traceability matrix',
      'Certification receipt',
    ],
  }
}

function buildImplementationContractMarkdown(session: ArtifactSession, ctx: SnapshotContext, decisionAnswers: DecisionAnswer[] = []) {
  const contract = buildImplementationContractPayload(session, ctx, decisionAnswers)
  return [
    '# implementation-contract.yaml',
    '',
    `goal: ${session.goal}`,
    `status: ${contract.status}`,
    '',
    'captured_decisions:',
    ...(contract.capturedDecisions.length > 0
      ? contract.capturedDecisions.map(answer => `  - ${answer.questionId}: "${answer.answer ?? answer.notes ?? 'answered'}"`)
      : ['  - none_captured_yet']),
    '',
    'stakeholder_inputs:',
    ...contract.stakeholderInputs.flatMap(input => [
      `  - role: ${input.role}`,
      `    contribution: "${input.contribution}"`,
      `    outputs: [${input.outputs.join(', ')}]`,
    ]),
    '',
    'implementation_units:',
    ...contract.implementationUnits.flatMap(unit => [
      `  - id: ${unit.id}`,
      `    title: ${unit.title}`,
      `    owner: ${unit.owner}`,
      `    files: [${unit.files.join(', ')}]`,
      `    instructions: "${unit.instructions}"`,
      `    acceptance: [${unit.acceptance.join(', ')}]`,
    ]),
    '',
    'final_checklist:',
    ...contract.finalChecklist.map(item => `  - ${item}`),
    '',
    'handoff_artifacts:',
    ...contract.handoffArtifacts.map(item => `  - ${item}`),
  ].join('\n')
}

function buildStakeholderAnswersMarkdown(answers: DecisionAnswer[]) {
  return [
    '# stakeholder-answers.yaml',
    '',
    'answers:',
    ...(answers.length > 0 ? answers.flatMap(answer => [
      `  - question_id: ${answer.questionId}`,
      `    answer_type: ${answer.answerType}`,
      answer.selectedOptionLabel ? `    selected_option: "${answer.selectedOptionLabel}"` : undefined,
      answer.customAnswer ? `    custom_answer: "${answer.customAnswer}"` : undefined,
      answer.notes ? `    notes: "${answer.notes}"` : undefined,
      answer.updatedAt ? `    updated_at: ${answer.updatedAt}` : undefined,
    ].filter((line): line is string => Boolean(line))) : ['  - none']),
  ].join('\n')
}

function buildVerificationRules(_session: ArtifactSession, ctx: SnapshotContext) {
  return [
    '# verification-rules.yaml',
    '',
    'verification_rules:',
    '  - id: VR-001',
    '    requirement: REQ-001',
    '    check: Operator enum and evaluator accept `between`.',
    `    current_signal: ${ctx.hasBetweenEnum && ctx.hasBetweenSwitch ? 'present' : 'missing_or_partial'}`,
    '  - id: VR-002',
    '    requirement: REQ-003',
    '    check: Inclusive boundary tests pass.',
    '  - id: VR-003',
    '    requirement: REQ-005',
    '    check: Malformed value arrays produce controlled errors.',
    '  - id: VR-004',
    '    requirement: BUILD',
    '    check: `mvn test` passes without enum/switch compile errors.',
  ].join('\n')
}

function buildTraceabilityMatrix() {
  return [
    '# traceability-matrix.yaml',
    '',
    'traceability:',
    '  - requirement: REQ-001',
    '    developer_tasks: [DEV-001]',
    '    qa_tasks: [QA-003]',
    '    verification_rules: [VR-001]',
    '  - requirement: REQ-002',
    '    developer_tasks: [DEV-001]',
    '    qa_tasks: [QA-002]',
    '    verification_rules: [VR-003]',
    '  - requirement: REQ-003',
    '    developer_tasks: [DEV-002]',
    '    qa_tasks: [QA-001]',
    '    verification_rules: [VR-002]',
  ].join('\n')
}

function buildCertificationReceipt(_session: ArtifactSession, ctx: SnapshotContext) {
  return [
    '# certification-receipt.yaml',
    '',
    'certification:',
    `  implementation_signal: ${ctx.hasBetweenEnum && ctx.hasBetweenSwitch ? 'detected' : 'not_detected'}`,
    `  compile_risk: ${ctx.hasLengthCase && !ctx.hasLengthEnum ? 'length_operator_enum_mismatch' : 'none_detected_from_snapshot'}`,
    '  status: READY_FOR_HUMAN_REVIEW',
    '  note: This MVP generated a governed plan and QA pack from read-only source context; it did not mutate code.',
  ].join('\n')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isDecisionAnswerRecord(value: unknown): value is DecisionAnswer {
  return readDecisionAnswers([value]).length === 1
}

function isStageAttempt(value: unknown): value is StageAttempt {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.stageKey === 'string'
    && typeof value.stageLabel === 'string'
    && typeof value.agentRole === 'string'
    && typeof value.agentTemplateId === 'string'
    && typeof value.attemptNumber === 'number'
    && typeof value.status === 'string'
    && typeof value.startedAt === 'string'
}

function isReviewEvent(value: unknown): value is ReviewEvent {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.type === 'string'
    && typeof value.message === 'string'
    && typeof value.createdAt === 'string'
}

function isFinalPack(value: unknown): value is FinalPack {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.status === 'string'
    && typeof value.generatedAt === 'string'
    && typeof value.summary === 'string'
    && Array.isArray(value.stages)
    && Array.isArray(value.artifactKinds)
}

function readSessionDecisionAnswers(session: { metadata?: Prisma.JsonValue | null }) {
  return isRecord(session.metadata) ? readDecisionAnswers(session.metadata.decisionAnswers) : []
}

function readDecisionAnswers(value: unknown): DecisionAnswer[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.questionId !== 'string') return []
    const answerType = item.answerType === 'freeform' ? 'freeform' : 'option'
    const selectedOptionLabel = typeof item.selectedOptionLabel === 'string' ? item.selectedOptionLabel : undefined
    const customAnswer = typeof item.customAnswer === 'string' ? item.customAnswer : undefined
    const notes = typeof item.notes === 'string' ? item.notes : undefined
    const updatedAt = typeof item.updatedAt === 'string' ? item.updatedAt : undefined
    const updatedById = typeof item.updatedById === 'string' ? item.updatedById : undefined
    if (answerType === 'option' && !selectedOptionLabel) return []
    if (answerType === 'freeform' && !customAnswer && !notes) return []
    return [{ questionId: item.questionId, answerType, selectedOptionLabel, customAnswer, notes, updatedAt, updatedById }]
  })
}

function answerText(answers: DecisionAnswer[], questionId: string, fallback: string) {
  const answer = answers.find(item => item.questionId === questionId)
  if (!answer) return fallback
  const base = answer.answerType === 'option'
    ? answer.selectedOptionLabel
    : answer.customAnswer
  return [base, answer.notes].filter(Boolean).join(' | notes: ') || fallback
}

function isUsefulModelResponse(value: string | undefined) {
  return Boolean(value && value.trim() && !value.includes('[mock]'))
}

function architectTask(goal: string) {
  return [
    `Create a solution architecture blueprint for: ${goal}`,
    'Produce a mental model, user-visible gaps, architecture decisions, risks, and a contract-pack outline.',
    'Keep the output structured with headings that can be reviewed by a human approver.',
  ].join('\n')
}

function developerTask(goal: string) {
  return [
    `Create a simulated developer implementation plan for: ${goal}`,
    'Do not mutate the repository. Produce expected file changes, task breakdown, code-level approach, and handoff notes.',
    'For MCP evidence, write simulated developer code change summary to blueprint-proposed-change.md if a demo write tool is available.',
  ].join('\n')
}

function qaTask(goal: string) {
  return [
    `Create QA and verification coverage for: ${goal}`,
    'Produce QA tasks, verifier rules, acceptance criteria coverage, risk checks, and a certification recommendation.',
    'Identify whether any spec gaps should send the work back to the Architect stage.',
  ].join('\n')
}

function stageSystemPrompt(stage: BlueprintStage) {
  if (stage === BlueprintStage.ARCHITECT) {
    return 'You are the Architect agent. Build governed solution architecture from the approved source snapshot and call out gaps plainly.'
  }
  if (stage === BlueprintStage.DEVELOPER) {
    return 'You are the Developer agent. Produce simulated implementation artifacts only; do not claim real files were changed.'
  }
  return 'You are the QA agent. Validate requirements, acceptance criteria, architecture decisions, and test strategy against the blueprint.'
}

function humanStage(stage: BlueprintStage) {
  return stage === BlueprintStage.ARCHITECT ? 'Architect'
    : stage === BlueprintStage.DEVELOPER ? 'Developer'
    : 'QA'
}

function jsonStrings(value: Prisma.JsonValue): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

async function snapshotLocalDir(root: string, includeGlobs: string[], excludeGlobs: string[]): Promise<SnapshotResult> {
  const absoluteRoot = path.resolve(root)
  const st = await fs.stat(absoluteRoot)
  if (!st.isDirectory()) throw new ValidationError('Local source must be a directory')

  const manifest: ManifestEntry[] = []
  let totalBytes = 0
  let excerptCount = 0

  async function walk(dir: string): Promise<void> {
    if (manifest.length >= MAX_FILES || totalBytes >= MAX_TOTAL_BYTES) return
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (manifest.length >= MAX_FILES || totalBytes >= MAX_TOTAL_BYTES) return
      const full = path.join(dir, entry.name)
      const rel = path.relative(absoluteRoot, full).split(path.sep).join('/')
      if (isExcluded(rel, excludeGlobs)) continue
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      if (!entry.isFile() || !isIncluded(rel, includeGlobs)) continue
      const stat = await fs.stat(full)
      if (stat.size > MAX_EXCERPT_BYTES * 10) continue
      const file: ManifestEntry = { path: rel, size: stat.size, language: languageFor(rel) }
      totalBytes += stat.size
      if (excerptCount < MAX_EXCERPT_FILES && isTextPath(rel) && totalBytes < MAX_TOTAL_BYTES) {
        const buf = await fs.readFile(full)
        const excerpt = buf.toString('utf8', 0, Math.min(buf.length, MAX_EXCERPT_BYTES))
        file.excerpt = excerpt
        file.sha = sha256(excerpt)
        excerptCount += 1
      }
      manifest.push(file)
    }
  }

  await walk(absoluteRoot)
  return summarizeSnapshot({ source: 'localdir', root: absoluteRoot }, manifest, totalBytes)
}

async function snapshotGithub(sourceUri: string, sourceRef: string | undefined, includeGlobs: string[], excludeGlobs: string[]): Promise<SnapshotResult> {
  const parsed = parseGithubUrl(sourceUri)
  const branch = sourceRef || parsed.branch || await githubDefaultBranch(parsed.owner, parsed.repo)
  const treeUrl = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`
  const treeResp = await fetch(treeUrl, { headers: { accept: 'application/vnd.github+json' } })
  if (!treeResp.ok) throw new ValidationError(`GitHub tree scan failed (${treeResp.status})`)
  const treeJson = await treeResp.json() as { tree?: Array<{ path: string; type: string; size?: number; sha?: string }> }
  const prefix = parsed.path ? parsed.path.replace(/^\/+|\/+$/g, '') : ''
  const manifest: ManifestEntry[] = []
  let totalBytes = 0
  let excerptCount = 0
  for (const item of treeJson.tree ?? []) {
    if (manifest.length >= MAX_FILES || totalBytes >= MAX_TOTAL_BYTES) break
    if (item.type !== 'blob') continue
    const itemPath = item.path
    if (prefix && !itemPath.startsWith(`${prefix}/`) && itemPath !== prefix) continue
    const rel = prefix ? itemPath.slice(prefix.length).replace(/^\/+/, '') : itemPath
    if (!rel || isExcluded(rel, excludeGlobs) || !isIncluded(rel, includeGlobs)) continue
    const size = item.size ?? 0
    if (size > MAX_EXCERPT_BYTES * 10) continue
    const file: ManifestEntry = { path: rel, size, sha: item.sha, language: languageFor(rel) }
    totalBytes += size
    if (excerptCount < MAX_EXCERPT_FILES && isTextPath(rel) && size <= MAX_EXCERPT_BYTES) {
      const raw = `https://raw.githubusercontent.com/${parsed.owner}/${parsed.repo}/${encodeURIComponent(branch)}/${itemPath.split('/').map(encodeURIComponent).join('/')}`
      const rawResp = await fetch(raw)
      if (rawResp.ok) {
        file.excerpt = (await rawResp.text()).slice(0, MAX_EXCERPT_BYTES)
        excerptCount += 1
      }
    }
    manifest.push(file)
  }
  return summarizeSnapshot({ source: 'github', repo: `${parsed.owner}/${parsed.repo}`, branch, path: prefix }, manifest, totalBytes)
}

function summarizeSnapshot(source: Record<string, unknown>, manifest: ManifestEntry[], totalBytes: number): SnapshotResult {
  const languages: Record<string, number> = {}
  const topLevel: Record<string, number> = {}
  for (const f of manifest) {
    const lang = f.language ?? 'Other'
    languages[lang] = (languages[lang] ?? 0) + 1
    const top = f.path.split('/')[0] || f.path
    topLevel[top] = (topLevel[top] ?? 0) + 1
  }
  const sampledFiles = manifest.filter(f => f.excerpt).map(f => ({ path: f.path, excerpt: f.excerpt }))
  const rootHash = sha256(JSON.stringify(manifest.map(f => [f.path, f.size, f.sha ?? ''])))
  return {
    manifest,
    fileCount: manifest.length,
    totalBytes,
    rootHash,
    summary: {
      ...source,
      generatedAt: new Date().toISOString(),
      limits: { maxFiles: MAX_FILES, maxTotalBytes: MAX_TOTAL_BYTES, maxExcerptBytes: MAX_EXCERPT_BYTES },
      languages,
      topLevel,
      sampledFiles,
    },
  }
}

function parseGithubUrl(sourceUri: string): { owner: string; repo: string; branch?: string; path?: string } {
  const url = new URL(sourceUri)
  if (url.hostname !== 'github.com') throw new ValidationError('GitHub source must be a github.com URL')
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts.length < 2) throw new ValidationError('GitHub URL must include owner and repository')
  const [owner, repoRaw] = parts
  const repo = repoRaw.replace(/\.git$/, '')
  const treeIdx = parts.indexOf('tree')
  if (treeIdx >= 0 && parts.length > treeIdx + 1) {
    return { owner, repo, branch: parts[treeIdx + 1], path: parts.slice(treeIdx + 2).join('/') }
  }
  return { owner, repo }
}

async function githubDefaultBranch(owner: string, repo: string): Promise<string> {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers: { accept: 'application/vnd.github+json' } })
  if (!res.ok) throw new ValidationError(`GitHub repository lookup failed (${res.status})`)
  const body = await res.json() as { default_branch?: string }
  return body.default_branch ?? 'main'
}

function isExcluded(relPath: string, excludeGlobs: string[]) {
  const parts = relPath.split('/')
  if (parts.some(p => DEFAULT_EXCLUDES.has(p))) return true
  return excludeGlobs.some(pattern => matchesGlob(relPath, pattern))
}

function isIncluded(relPath: string, includeGlobs: string[]) {
  if (includeGlobs.length === 0) return true
  return includeGlobs.some(pattern => matchesGlob(relPath, pattern))
}

function matchesGlob(relPath: string, pattern: string) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '::DOUBLE_STAR::')
    .replace(/\*/g, '[^/]*')
    .replace(/::DOUBLE_STAR::/g, '.*')
  return new RegExp(`^${escaped}$`).test(relPath)
}

function isTextPath(relPath: string) {
  return /\.(ts|tsx|js|jsx|mjs|cjs|json|md|mdx|yml|yaml|toml|prisma|py|rb|go|rs|java|kt|cs|php|css|scss|html|sql|sh|env|txt)$/i.test(relPath)
    || /(^|\/)(Dockerfile|Makefile|README|LICENSE)(\..*)?$/i.test(relPath)
}

function languageFor(relPath: string) {
  const ext = path.extname(relPath).toLowerCase()
  const map: Record<string, string> = {
    '.ts': 'TypeScript',
    '.tsx': 'TypeScript React',
    '.js': 'JavaScript',
    '.jsx': 'JavaScript React',
    '.py': 'Python',
    '.go': 'Go',
    '.rs': 'Rust',
    '.java': 'Java',
    '.css': 'CSS',
    '.scss': 'SCSS',
    '.html': 'HTML',
    '.json': 'JSON',
    '.md': 'Markdown',
    '.yaml': 'YAML',
    '.yml': 'YAML',
    '.prisma': 'Prisma',
    '.sql': 'SQL',
  }
  return map[ext] ?? 'Other'
}

function sha256(input: string) {
  return crypto.createHash('sha256').update(input).digest('hex')
}
