import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../lib/prisma'
import { validate } from '../../middleware/validate'
import { parsePagination, toPageResponse } from '../../lib/pagination'
import { NotFoundError, ValidationError } from '../../lib/errors'
import { logEvent, createReceipt, publishOutbox } from '../../lib/audit'
import { contextFabricClient, ContextFabricError } from '../../lib/context-fabric/client'

export const agentRunsRouter: Router = Router()

agentRunsRouter.get('/pending-review', async (req, res, next) => {
  try {
    const pg = parsePagination(req.query as Record<string, unknown>)
    const [runs, total] = await Promise.all([
      prisma.agentRun.findMany({
        where: { status: 'AWAITING_REVIEW' },
        include: { agent: true, outputs: true },
        skip: pg.skip, take: pg.take,
        orderBy: { completedAt: 'desc' },
      }),
      prisma.agentRun.count({ where: { status: 'AWAITING_REVIEW' } }),
    ])
    res.json(toPageResponse(runs, total, pg))
  } catch (err) {
    next(err)
  }
})

// M9.z — must be registered before `/:id` so Express doesn't treat
// "pending-approval" as a run id.
agentRunsRouter.get('/pending-approval', async (req, res, next) => {
  try {
    const pg = parsePagination(req.query as Record<string, unknown>)
    const [runs, total] = await Promise.all([
      prisma.agentRun.findMany({
        where: { status: 'PAUSED' },
        include: {
          agent: true,
          outputs: { where: { outputType: 'APPROVAL_REQUIRED' }, orderBy: { createdAt: 'desc' }, take: 1 },
        },
        skip: pg.skip, take: pg.take,
        orderBy: { startedAt: 'desc' },
      }),
      prisma.agentRun.count({ where: { status: 'PAUSED' } }),
    ])
    res.json(toPageResponse(runs, total, pg))
  } catch (err) {
    next(err)
  }
})

agentRunsRouter.get('/:id', async (req, res, next) => {
  try {
    const run = await prisma.agentRun.findUnique({
      where: { id: req.params.id },
      include: { agent: true, inputs: true, outputs: true, reviews: true },
    })
    if (!run) throw new NotFoundError('AgentRun', req.params.id)
    res.json(run)
  } catch (err) {
    next(err)
  }
})

agentRunsRouter.get('/:id/outputs', async (req, res, next) => {
  try {
    const outputs = await prisma.agentRunOutput.findMany({
      where: { runId: req.params.id },
      orderBy: { createdAt: 'desc' },
    })
    res.json(outputs)
  } catch (err) {
    next(err)
  }
})

const reviewSchema = z.object({
  decision: z.enum(['APPROVED', 'REJECTED']),
  notes: z.string().optional(),
})

agentRunsRouter.post('/:id/review', validate(reviewSchema), async (req, res, next) => {
  try {
    const { decision, notes } = req.body as z.infer<typeof reviewSchema>
    const userId = req.user!.userId
    const id = req.params.id as string

    const run = await prisma.agentRun.findUnique({ where: { id } })
    if (!run) throw new NotFoundError('AgentRun', id)

    const [review] = await prisma.$transaction([
      prisma.agentReview.create({
        data: { runId: id, reviewedById: userId, decision, notes },
      }),
      prisma.agentRun.update({
        where: { id },
        data: { status: decision },
      }),
    ])

    const eventId = await logEvent('AgentRunReviewed', 'AgentRun', id, userId, { decision })
    await createReceipt('AGENT_REVIEW', 'AgentRun', id, {
      runId: id,
      decision,
      reviewedBy: userId,
    }, eventId)
    await publishOutbox('AgentRun', id, 'AgentRunReviewed', { runId: id, decision })

    res.status(201).json(review)
  } catch (err) {
    next(err)
  }
})

// ── M9.z — resume hand-off to context-fabric ──

const approveSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  reason: z.string().optional(),
  args_override: z.record(z.string(), z.unknown()).optional(),
})

agentRunsRouter.post('/:id/approve', validate(approveSchema), async (req, res, next) => {
  try {
    const { decision, reason, args_override } = req.body as z.infer<typeof approveSchema>
    const userId = req.user!.userId
    const id = req.params.id as string

    const run = await prisma.agentRun.findUnique({
      where: { id },
      include: {
        outputs: {
          where: { outputType: 'APPROVAL_REQUIRED' },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    })
    if (!run) throw new NotFoundError('AgentRun', id)
    if (run.status !== 'PAUSED') {
      throw new ValidationError(`AgentRun ${id} is not PAUSED (current status: ${run.status})`)
    }
    const approvalOutput = run.outputs[0]
    const payload = (approvalOutput?.structuredPayload ?? {}) as Record<string, unknown>
    const cfCallId = payload.cfCallId as string | undefined
    if (!cfCallId) throw new ValidationError(`AgentRun ${id} has no cfCallId on its APPROVAL_REQUIRED output`)

    let cfResult
    try {
      cfResult = await contextFabricClient.resume({
        cf_call_id: cfCallId,
        decision,
        reason,
        args_override,
      })
    } catch (err) {
      const message = err instanceof ContextFabricError
        ? `context-fabric resume error (${err.status}): ${err.message}`
        : (err as Error).message
      await prisma.agentRunOutput.create({
        data: {
          runId: id,
          outputType: 'ERROR',
          rawContent: message,
          structuredPayload: { errorCode: 'cf-resume-error' },
        },
      })
      await prisma.agentRun.update({ where: { id }, data: { status: 'FAILED', completedAt: new Date() } })
      await logEvent('AgentRunFailed', 'AgentRun', id, userId, { errorCode: 'cf-resume-error', message })
      throw err
    }

    const correlation = {
      cfCallId: cfResult.correlation.cfCallId,
      traceId: cfResult.correlation.traceId,
      sessionId: cfResult.correlation.sessionId,
      promptAssemblyId: cfResult.correlation.promptAssemblyId,
      mcpServerId: cfResult.correlation.mcpServerId,
      mcpInvocationId: cfResult.correlation.mcpInvocationId,
      llmCallIds: cfResult.correlation.llmCallIds,
      toolInvocationIds: cfResult.correlation.toolInvocationIds,
      artifactIds: cfResult.correlation.artifactIds,
      finishReason: cfResult.finishReason,
      stepsTaken: cfResult.stepsTaken,
      tokensUsed: cfResult.tokensUsed,
      decision,
      reviewer: userId,
    }

    await prisma.agentRunOutput.create({
      data: {
        runId: id,
        outputType: cfResult.status === 'WAITING_APPROVAL' ? 'APPROVAL_REQUIRED' : 'LLM_RESPONSE',
        rawContent: cfResult.finalResponse ?? '',
        structuredPayload: cfResult.status === 'WAITING_APPROVAL'
          ? ({ ...correlation, pendingApproval: cfResult.pendingApproval ?? null } as unknown as object)
          : (correlation as unknown as object),
        tokenCount: cfResult.tokensUsed?.input ?? null,
      },
    })

    let nextStatus: 'PAUSED' | 'AWAITING_REVIEW' | 'REJECTED' | 'FAILED'
    if (cfResult.status === 'WAITING_APPROVAL') nextStatus = 'PAUSED'
    else if (cfResult.status === 'FAILED') nextStatus = 'FAILED'
    else if (decision === 'rejected') nextStatus = 'REJECTED'
    else nextStatus = 'AWAITING_REVIEW'

    await prisma.agentRun.update({
      where: { id },
      data: {
        status: nextStatus,
        completedAt: nextStatus === 'PAUSED' ? null : new Date(),
      },
    })

    const eventName = nextStatus === 'PAUSED' ? 'AgentRunPaused' : 'AgentRunResumed'
    const eventId = await logEvent(eventName, 'AgentRun', id, userId, {
      decision,
      cfCallId: cfResult.correlation.cfCallId,
      finishReason: cfResult.finishReason,
    })
    await createReceipt('AGENT_APPROVAL', 'AgentRun', id, {
      runId: id,
      decision,
      reviewedBy: userId,
      cfCallId: cfResult.correlation.cfCallId,
    }, eventId)
    await publishOutbox('AgentRun', id, eventName, {
      runId: id,
      decision,
      cfCallId: cfResult.correlation.cfCallId,
      pendingApproval: cfResult.pendingApproval ?? null,
    })

    res.json({
      runId: id,
      status: nextStatus,
      cfStatus: cfResult.status,
      correlation,
      pendingApproval: cfResult.pendingApproval ?? null,
    })
  } catch (err) {
    next(err)
  }
})
