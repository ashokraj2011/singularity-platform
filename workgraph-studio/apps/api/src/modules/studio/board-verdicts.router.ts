/**
 * Studio Board — AgentVerdicts API (PR-5). Two routers, deliberately:
 *  - studioBoardVerdictRouter  → mounted at /api/studio (human session): humans list,
 *    read the gate summary, answer (attach counter-evidence), and dismiss (with a
 *    required reason). Humans may also challenge AGENT artifacts through the same door.
 *  - studioBoardAgentVerdictRouter → mounted at /api/studio-agent (NO human auth), behind
 *    a service-principal token: only an agent principal may write agent-role verdicts.
 *    The runner-principal lesson from reconciliation, applied on day one.
 */
import { Router, type Request, type Response, type NextFunction } from 'express'
import { z } from 'zod'
import { validate } from '../../middleware/validate'
import { config } from '../../config'
import {
  createVerdict, listVerdicts, answerVerdict, dismissVerdict, concedeVerdict, reopenVerdict, verdictSummary,
} from './board-verdicts.service'
import { verdictInputSchema, verdictBaseSchema, challengeToneRefine, challengeToneMessage, AGENT_ROLES } from './board-verdicts'

const userIdOf = (req: Request) => req.user!.userId
const boardIdOf = (req: Request) => String(req.params.boardId)
const verdictIdOf = (req: Request) => String(req.params.verdictId)

const answerSchema = z.object({ note: z.string().trim().max(1200).optional() })
const dismissSchema = z.object({ note: z.string().trim().min(1).max(1200) })

// ── Human-facing (mounted at /api/studio, authMiddleware) ─────────────────────
export const studioBoardVerdictRouter: Router = Router()

// A human challenging an agent artifact goes through the same verdict vocabulary.
studioBoardVerdictRouter.post('/boards/:boardId/verdicts', validate(verdictInputSchema), async (req, res, next) => {
  try {
    res.status(201).json(await createVerdict(req.body, boardIdOf(req), { actorType: 'HUMAN', agentRole: 'HUMAN', actorId: userIdOf(req) }))
  } catch (err) { next(err) }
})

studioBoardVerdictRouter.get('/boards/:boardId/verdicts', async (req, res, next) => {
  try {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined
    const targetRef = typeof req.query.targetRef === 'string' ? req.query.targetRef : undefined
    res.json(await listVerdicts({ boardId: boardIdOf(req), status, targetRef }))
  } catch (err) { next(err) }
})

studioBoardVerdictRouter.get('/boards/:boardId/verdict-summary', async (req, res, next) => {
  try {
    const targetType = typeof req.query.targetType === 'string' ? req.query.targetType : undefined
    res.json(await verdictSummary(boardIdOf(req), { targetType }))
  } catch (err) { next(err) }
})

studioBoardVerdictRouter.post('/verdicts/:verdictId/answer', validate(answerSchema), async (req, res, next) => {
  try { res.json(await answerVerdict(verdictIdOf(req), req.body.note, userIdOf(req))) } catch (err) { next(err) }
})

studioBoardVerdictRouter.post('/verdicts/:verdictId/dismiss', validate(dismissSchema), async (req, res, next) => {
  try { res.json(await dismissVerdict(verdictIdOf(req), req.body.note, userIdOf(req))) } catch (err) { next(err) }
})

// ── Agent-principal (mounted at /api/studio-agent, service token only) ────────
export const studioBoardAgentVerdictRouter: Router = Router()

function requireServiceToken(req: Request, res: Response, next: NextFunction) {
  const bearer = typeof req.headers.authorization === 'string' && req.headers.authorization.startsWith('Bearer ')
    ? req.headers.authorization.slice(7) : undefined
  const header = typeof req.headers['x-service-token'] === 'string' ? req.headers['x-service-token'] : undefined
  if (!config.WORKGRAPH_INTERNAL_TOKEN || (bearer ?? header) !== config.WORKGRAPH_INTERNAL_TOKEN) {
    res.status(401).json({ error: 'Agent verdicts require a service principal token.' })
    return
  }
  next()
}
studioBoardAgentVerdictRouter.use(requireServiceToken)

const agentVerdictSchema = verdictBaseSchema.extend({
  agentRole: z.enum(AGENT_ROLES),
  actorId: z.string().trim().max(200).optional(),
  traceId: z.string().trim().max(200).optional(),
}).refine(challengeToneRefine, challengeToneMessage)

studioBoardAgentVerdictRouter.post('/boards/:boardId/verdicts', validate(agentVerdictSchema), async (req, res, next) => {
  try {
    const { agentRole, actorId, traceId, ...verdict } = req.body
    res.status(201).json(await createVerdict(verdict, boardIdOf(req), { actorType: 'AGENT', agentRole, actorId: actorId ?? null, traceId: traceId ?? null }))
  } catch (err) { next(err) }
})

studioBoardAgentVerdictRouter.post('/verdicts/:verdictId/concede', async (req, res, next) => {
  try { res.json(await concedeVerdict(verdictIdOf(req), 'agent')) } catch (err) { next(err) }
})

studioBoardAgentVerdictRouter.post('/verdicts/:verdictId/reopen', async (req, res, next) => {
  try { res.json(await reopenVerdict(verdictIdOf(req), 'agent')) } catch (err) { next(err) }
})
