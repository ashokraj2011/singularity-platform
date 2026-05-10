import { Router } from 'express'
import { z } from 'zod'
import { Tool, ToolAction } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { validate } from '../../middleware/validate'
import { parsePagination, toPageResponse } from '../../lib/pagination'
import { NotFoundError, ValidationError } from '../../lib/errors'
import { logEvent, createReceipt, publishOutbox } from '../../lib/audit'
import { executeToolRun } from './gateway/ToolGatewayService'

export const toolRunsRouter: Router = Router()

toolRunsRouter.get('/pending-approval', async (req, res, next) => {
  try {
    const pg = parsePagination(req.query as Record<string, unknown>)
    const [runs, total] = await Promise.all([
      prisma.toolRun.findMany({
        where: { status: 'PENDING_APPROVAL' },
        include: { tool: true },
        skip: pg.skip, take: pg.take,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.toolRun.count({ where: { status: 'PENDING_APPROVAL' } }),
    ])
    res.json(toPageResponse(runs, total, pg))
  } catch (err) {
    next(err)
  }
})

toolRunsRouter.get('/:id', async (req, res, next) => {
  try {
    const run = await prisma.toolRun.findUnique({
      where: { id: req.params.id },
      include: { tool: true, approvals: true },
    })
    if (!run) throw new NotFoundError('ToolRun', req.params.id)
    res.json(run)
  } catch (err) {
    next(err)
  }
})

const approveSchema = z.object({ notes: z.string().optional() })

toolRunsRouter.post('/:id/approve', validate(approveSchema), async (req, res, next) => {
  try {
    const userId = req.user!.userId
    const id = req.params.id as string
    const run = await prisma.toolRun.findUnique({
      where: { id },
      include: { tool: { include: { actions: true } } },
    }) as (Awaited<ReturnType<typeof prisma.toolRun.findUnique>> & { tool: Tool & { actions: ToolAction[] } }) | null
    if (!run) throw new NotFoundError('ToolRun', id)
    if (run.status !== 'PENDING_APPROVAL') {
      throw new ValidationError(`ToolRun is not pending approval (status: ${run.status})`)
    }

    // Record approval
    await prisma.toolRunApproval.create({
      data: { runId: run.id, approvedById: userId, decision: 'APPROVED', decidedAt: new Date() },
    })

    const actionName = run.actionId
      ? run.tool.actions.find((a: ToolAction) => a.id === run.actionId)?.name ?? 'execute'
      : 'execute'

    // Execute
    await executeToolRun(
      run.toolId,
      run.actionId ?? undefined,
      run.instanceId ?? undefined,
      run.inputPayload as Record<string, unknown>,
      userId,
      actionName,
    )

    const eventId = await logEvent('ToolRunApproved', 'ToolRun', run.id, userId)
    await createReceipt('TOOL_RUN_APPROVAL', 'ToolRun', run.id, {
      runId: run.id,
      approvedBy: userId,
    }, eventId)
    await publishOutbox('ToolRun', run.id, 'ToolRunApproved', { runId: run.id })

    const updated = await prisma.toolRun.findUnique({ where: { id: run.id } })
    res.json(updated)
  } catch (err) {
    next(err)
  }
})

toolRunsRouter.post('/:id/reject', async (req, res, next) => {
  try {
    const userId = req.user!.userId
    const run = await prisma.toolRun.findUnique({ where: { id: req.params.id } })
    if (!run) throw new NotFoundError('ToolRun', req.params.id)

    await prisma.$transaction([
      prisma.toolRunApproval.create({
        data: { runId: run.id, approvedById: userId, decision: 'REJECTED', decidedAt: new Date() },
      }),
      prisma.toolRun.update({
        where: { id: req.params.id },
        data: { status: 'REJECTED' },
      }),
    ])

    await logEvent('ToolRunRejected', 'ToolRun', req.params.id, userId)
    await publishOutbox('ToolRun', req.params.id, 'ToolRunRejected', { runId: req.params.id })

    const updated = await prisma.toolRun.findUnique({ where: { id: req.params.id } })
    res.json(updated)
  } catch (err) {
    next(err)
  }
})
