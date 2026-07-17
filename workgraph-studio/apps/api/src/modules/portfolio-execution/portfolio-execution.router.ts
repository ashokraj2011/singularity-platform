import { Router } from 'express'
import { z } from 'zod'
import { validate } from '../../middleware/validate'
import {
  addDecisionOption,
  compileProjectSpecification,
  createDecisionDossier,
  evaluateProjectBudget,
  getProjectEconomics,
  getProjectLearning,
  getProjectPilotReadiness,
  getProjectTraceability,
  getTenantBudget,
  listDecisionDossiers,
  requestDecisionReview,
  transitionChangeRequest,
  upsertProjectBudgetEnvelope,
  upsertTenantBudget,
} from './portfolio-execution.service'

export const portfolioExecutionRouter: Router = Router()

const optionSchema = z.object({
  title: z.string().trim().min(1).max(300),
  summary: z.string().trim().min(1).max(5000),
  conceptCardId: z.string().uuid().optional(),
  claimRefs: z.array(z.string().uuid()).default([]),
  tradeoffs: z.array(z.string().trim().min(1).max(1000)).default([]),
  estimatedHours: z.number().nonnegative().optional(),
  estimatedCostLow: z.number().nonnegative().optional(),
  estimatedCostHigh: z.number().nonnegative().optional(),
  estimatedTokens: z.number().int().nonnegative().optional(),
  riskScore: z.number().int().min(1).max(5).optional(),
})

const dossierSchema = z.object({
  title: z.string().trim().min(1).max(300),
  problem: z.string().trim().min(1).max(5000),
  claimRefs: z.array(z.string().uuid()).default([]),
  resolvesTensions: z.array(z.string().trim().min(1).max(1000)).default([]),
  options: z.array(optionSchema).max(20).default([]),
})

portfolioExecutionRouter.get('/projects/:projectId/decisions', async (req, res, next) => {
  try { res.json({ items: await listDecisionDossiers(String(req.params.projectId)) }) } catch (error) { next(error) }
})

portfolioExecutionRouter.post('/projects/:projectId/decisions', validate(dossierSchema), async (req, res, next) => {
  try { res.status(201).json(await createDecisionDossier(String(req.params.projectId), req.body, req.user!.userId)) } catch (error) { next(error) }
})

portfolioExecutionRouter.post('/decisions/:dossierId/options', validate(optionSchema), async (req, res, next) => {
  try { res.status(201).json(await addDecisionOption(String(req.params.dossierId), req.body, req.user!.userId)) } catch (error) { next(error) }
})

portfolioExecutionRouter.post('/decisions/:dossierId/review', validate(z.object({ selectedOptionId: z.string().uuid() })), async (req, res, next) => {
  try { res.status(201).json(await requestDecisionReview(String(req.params.dossierId), req.body.selectedOptionId, req.user!.userId)) } catch (error) { next(error) }
})

portfolioExecutionRouter.post('/projects/:projectId/compile', validate(z.object({ waiverReasons: z.record(z.string().trim().min(20).max(2000)).optional() })), async (req, res, next) => {
  try { res.status(201).json(await compileProjectSpecification(String(req.params.projectId), req.body, req.user!.userId)) } catch (error) { next(error) }
})

portfolioExecutionRouter.get('/projects/:projectId/economics', async (req, res, next) => {
  try { res.json(await getProjectEconomics(String(req.params.projectId))) } catch (error) { next(error) }
})

portfolioExecutionRouter.get('/projects/:projectId/traceability', async (req, res, next) => {
  try { res.json(await getProjectTraceability(String(req.params.projectId))) } catch (error) { next(error) }
})

portfolioExecutionRouter.get('/projects/:projectId/learning', async (req, res, next) => {
  try { res.json(await getProjectLearning(String(req.params.projectId))) } catch (error) { next(error) }
})

portfolioExecutionRouter.get('/projects/:projectId/pilot-readiness', async (req, res, next) => {
  try { res.json(await getProjectPilotReadiness(String(req.params.projectId))) } catch (error) { next(error) }
})

portfolioExecutionRouter.get('/projects/:projectId/budget-decision', async (req, res, next) => {
  try { res.json(await evaluateProjectBudget(String(req.params.projectId), { stage: typeof req.query.stage === 'string' ? req.query.stage : undefined })) } catch (error) { next(error) }
})

portfolioExecutionRouter.post('/change-requests/:changeRequestId/transition', validate(z.object({
  status: z.enum(['OPEN', 'APPROVED', 'REJECTED', 'APPLIED']),
  comment: z.string().trim().max(2000).optional(),
})), async (req, res, next) => {
  try { res.json(await transitionChangeRequest(String(req.params.changeRequestId), req.body.status, req.user!.userId, req.body.comment)) } catch (error) { next(error) }
})

const tenantBudgetSchema = z.object({
  currency: z.string().trim().length(3).optional(),
  costLimitUsd: z.number().nonnegative().nullable().optional(),
  tokenLimit: z.number().int().positive().nullable().optional(),
  warningPercent: z.number().int().min(1).max(100).optional(),
  hardCapPercent: z.number().int().min(100).max(200).optional(),
  economyModelAlias: z.string().trim().max(200).nullable().optional(),
})

portfolioExecutionRouter.get('/tenant-budget', async (_req, res, next) => {
  try { res.json(await getTenantBudget()) } catch (error) { next(error) }
})

portfolioExecutionRouter.put('/tenant-budget', validate(tenantBudgetSchema), async (req, res, next) => {
  try { res.json(await upsertTenantBudget(req.body, req.user!.userId)) } catch (error) { next(error) }
})

portfolioExecutionRouter.put('/projects/:projectId/budget-envelope', validate(z.object({
  currency: z.string().trim().min(3).max(3).optional(),
  budgetLow: z.number().nonnegative().nullable().optional(),
  budgetHigh: z.number().nonnegative().nullable().optional(),
  tokenLimit: z.number().int().positive().nullable().optional(),
  warningPercent: z.number().int().min(1).max(100).optional(),
  hardCapPercent: z.number().int().min(100).max(200).optional(),
  stageBudgets: z.record(z.object({
    tokenLimit: z.number().int().positive().nullable().optional(),
    costLimitUsd: z.number().nonnegative().nullable().optional(),
  })).optional(),
})), async (req, res, next) => {
  try { res.json(await upsertProjectBudgetEnvelope(String(req.params.projectId), req.body, req.user!.userId)) } catch (error) { next(error) }
})
