import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../lib/prisma'
import { validate } from '../../middleware/validate'
import { parsePagination, toPageResponse } from '../../lib/pagination'
import { NotFoundError } from '../../lib/errors'
import { requestToolRun } from './gateway/ToolGatewayService'

export const toolsRouter: Router = Router()

const createToolSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  riskLevel: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('MEDIUM'),
  requiresApproval: z.boolean().default(true),
})

const createActionSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  inputSchema: z.record(z.unknown()).default({}),
  outputSchema: z.record(z.unknown()).default({}),
  riskLevel: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('MEDIUM'),
})

const requestRunSchema = z.object({
  actionId: z.string().uuid().optional(),
  instanceId: z.string().uuid().optional(),
  inputPayload: z.record(z.unknown()).default({}),
  idempotencyKey: z.string().min(1).max(200).optional(),
})

// M10 — local Tool CRUD removed. Tools are snapshots of tool-service entries.
// Author tools via tool-service (POST :3002/api/v1/tools) and pick with
// /api/lookup/tools.
toolsRouter.post('/', (_req, res) => {
  res.status(410).json({
    code: 'GONE',
    message:
      'Local tool creation is removed in M10. Author tools in agent-and-tools tool-service and pick them with /api/lookup/tools.',
  })
})

toolsRouter.get('/', async (req, res, next) => {
  try {
    const pg = parsePagination(req.query as Record<string, unknown>)
    const [tools, total] = await Promise.all([
      prisma.tool.findMany({
        skip: pg.skip, take: pg.take,
        include: { actions: true },
        orderBy: { name: 'asc' },
      }),
      prisma.tool.count(),
    ])
    res.json(toPageResponse(tools, total, pg))
  } catch (err) {
    next(err)
  }
})

toolsRouter.get('/:id', async (req, res, next) => {
  try {
    const tool = await prisma.tool.findUnique({
      where: { id: req.params.id },
      include: { actions: true },
    })
    if (!tool) throw new NotFoundError('Tool', req.params.id)
    res.json(tool)
  } catch (err) {
    next(err)
  }
})

toolsRouter.post('/:id/actions', validate(createActionSchema), async (req, res, next) => {
  try {
    const action = await prisma.toolAction.create({ data: { toolId: req.params.id, ...req.body } })
    res.status(201).json(action)
  } catch (err) {
    next(err)
  }
})

toolsRouter.post('/:id/request-run', validate(requestRunSchema), async (req, res, next) => {
  try {
    const { actionId, instanceId, inputPayload, idempotencyKey } = req.body as z.infer<typeof requestRunSchema>
    const runId = await requestToolRun(
      req.params.id as string,
      actionId,
      instanceId,
      inputPayload,
      req.user!.userId,
      idempotencyKey,
    )
    const run = await prisma.toolRun.findUnique({ where: { id: runId } })
    res.status(201).json(run)
  } catch (err) {
    next(err)
  }
})
