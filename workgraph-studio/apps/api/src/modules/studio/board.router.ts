/**
 * Studio Board API — mounted at /api/studio (same front door as projects/rooms).
 * PR-1 exposes the event-sourcing backbone: create/list boards, append an event
 * (server allocates the fenced seq + coalesces), and the time-travel read path
 * (state at a cursor + replay stream). Moments / fork / diff / merge / ingestion /
 * verdicts arrive in later PRs.
 */
import { Router, type Request } from 'express'
import { z } from 'zod'
import { validate } from '../../middleware/validate'
import { createBoard, listBoards, appendEvent, readState, listEvents } from './board.service'

export const studioBoardRouter: Router = Router()

const createBoardSchema = z.object({
  name: z.string().trim().min(1).max(200),
})
const appendEventSchema = z.object({
  branch: z.string().trim().min(1).max(120).default('main'),
  eventType: z.string().trim().min(1).max(64),
  objectIds: z.array(z.string().max(200)).max(500).default([]),
  payload: z.record(z.unknown()).default({}),
  causedBy: z.array(z.unknown()).max(50).default([]),
  coalesceKey: z.string().trim().max(200).nullable().optional(),
  agentRole: z.string().trim().max(64).nullable().optional(),
  expectedHeadSeq: z.number().int().min(0).optional(),
})

const projectIdOf = (req: Request) => String(req.params.projectId)
const boardIdOf = (req: Request) => String(req.params.boardId)
const userIdOf = (req: Request) => req.user!.userId
const branchOf = (req: Request) => (typeof req.query.branch === 'string' && req.query.branch ? req.query.branch : 'main')

studioBoardRouter.post('/projects/:projectId/boards', validate(createBoardSchema), async (req, res, next) => {
  try {
    res.status(201).json(await createBoard(projectIdOf(req), req.body.name, userIdOf(req)))
  } catch (err) { next(err) }
})

studioBoardRouter.get('/projects/:projectId/boards', async (req, res, next) => {
  try {
    res.json(await listBoards(projectIdOf(req)))
  } catch (err) { next(err) }
})

studioBoardRouter.post('/boards/:boardId/events', validate(appendEventSchema), async (req, res, next) => {
  try {
    const { branch, ...input } = req.body
    res.status(201).json(await appendEvent(boardIdOf(req), branch, input, { actorType: 'HUMAN', actorId: userIdOf(req), agentRole: input.agentRole ?? null }))
  } catch (err) { next(err) }
})

studioBoardRouter.get('/boards/:boardId/state', async (req, res, next) => {
  try {
    const at = typeof req.query.at === 'string' ? req.query.at : undefined
    res.json(await readState(boardIdOf(req), branchOf(req), at))
  } catch (err) { next(err) }
})

studioBoardRouter.get('/boards/:boardId/events', async (req, res, next) => {
  try {
    const from = typeof req.query.from === 'string' && req.query.from !== '' ? Number(req.query.from) : undefined
    const to = typeof req.query.to === 'string' && req.query.to !== '' ? Number(req.query.to) : undefined
    res.json(await listEvents(boardIdOf(req), branchOf(req), from, to))
  } catch (err) { next(err) }
})
