import { Router, type Request } from 'express'
import { z } from 'zod'
import { validate } from '../../middleware/validate'
import {
  acceptIntakeScaffold,
  generateCanonicalArtifactDocument,
  getDesk,
  getMorningBrief,
  listValidationReports,
  proposeIntakeScaffold,
  recordIntakeTurn,
  refreshDesk,
  resolveAttentionItem,
  resolveIntakeSession,
  runOvernightShift,
  transmuteValidationReport,
  validateBoardArtifacts,
} from './experience.service'

export const experienceRouter: Router = Router()

const userId = (req: Request) => req.user!.userId
const id = (req: Request, name: string) => String(req.params[name])

const resolveAttentionSchema = z.object({
  resolution: z.enum(['DISMISSED', 'CONFIRMED', 'DEFERRED']),
  note: z.string().trim().min(3).max(2000).optional(),
})
const intakeTurnSchema = z.object({
  stage: z.enum(['PROBLEM', 'BELIEFS', 'SUCCESS', 'CONSTRAINTS', 'CONTEXT']),
  text: z.string().trim().min(8).max(20_000),
  confidence: z.number().min(0).max(1).default(0.7),
  tokensUsed: z.number().int().min(0).max(1_000_000).optional(),
  costUsd: z.number().min(0).max(10_000).optional(),
})

experienceRouter.get('/experience/desk', async (req, res, next) => {
  try {
    const projectId = String(req.query.projectId ?? '')
    const reviewBudget = Number(req.query.reviewBudget ?? 12)
    res.json(await getDesk(projectId, reviewBudget))
  } catch (error) { next(error) }
})

experienceRouter.post('/experience/desk/refresh', validate(z.object({ projectId: z.string().uuid() })), async (req, res, next) => {
  try { res.json(await refreshDesk(req.body.projectId)) } catch (error) { next(error) }
})

experienceRouter.post('/experience/attention/:itemId/resolve', validate(resolveAttentionSchema), async (req, res, next) => {
  try { res.json(await resolveAttentionItem(id(req, 'itemId'), req.body.resolution, req.body.note, userId(req))) } catch (error) { next(error) }
})

experienceRouter.post('/experience/intake/projects/:projectId/session', async (req, res, next) => {
  try { res.status(201).json(await resolveIntakeSession(id(req, 'projectId'), userId(req))) } catch (error) { next(error) }
})

experienceRouter.post('/experience/intake/sessions/:sessionId/turn', validate(intakeTurnSchema), async (req, res, next) => {
  try { res.json(await recordIntakeTurn(id(req, 'sessionId'), req.body, userId(req))) } catch (error) { next(error) }
})

experienceRouter.post('/experience/intake/sessions/:sessionId/scaffold', async (req, res, next) => {
  try { res.status(201).json(await proposeIntakeScaffold(id(req, 'sessionId'), userId(req))) } catch (error) { next(error) }
})

experienceRouter.post('/experience/intake/scaffolds/:proposalId/accept', validate(z.object({ note: z.string().trim().max(2000).optional() })), async (req, res, next) => {
  try { res.json(await acceptIntakeScaffold(id(req, 'proposalId'), userId(req), req.body.note)) } catch (error) { next(error) }
})

experienceRouter.get('/experience/boards/:boardId/validation-reports', async (req, res, next) => {
  try { res.json(await listValidationReports(id(req, 'boardId'))) } catch (error) { next(error) }
})

experienceRouter.post('/experience/boards/:boardId/validation-reports', async (req, res, next) => {
  try { res.status(201).json(await validateBoardArtifacts(id(req, 'boardId'), userId(req))) } catch (error) { next(error) }
})

experienceRouter.post('/experience/validation-reports/:reportId/transmute', async (req, res, next) => {
  try { res.status(201).json(await transmuteValidationReport(id(req, 'reportId'), userId(req))) } catch (error) { next(error) }
})

experienceRouter.get('/experience/validation-reports/:reportId/canonical-document', async (req, res, next) => {
  try { res.json(await generateCanonicalArtifactDocument(id(req, 'reportId'))) } catch (error) { next(error) }
})

experienceRouter.post('/experience/projects/:projectId/overnight/run', async (req, res, next) => {
  try { res.json(await runOvernightShift(id(req, 'projectId'), userId(req))) } catch (error) { next(error) }
})

experienceRouter.get('/experience/projects/:projectId/morning-brief', async (req, res, next) => {
  try { res.json(await getMorningBrief(id(req, 'projectId'))) } catch (error) { next(error) }
})
