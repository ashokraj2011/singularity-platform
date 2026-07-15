/**
 * Unified Discovery & Elicitation API (ADR 0006 §4). Thin HTTP layer over
 * DiscoveryService — session lifecycle, the active elicit loop, and
 * question/assumption mutations. Registered at /api/discovery.
 */
import { Router } from 'express'
import { z } from 'zod'
import { validate } from '../../middleware/validate'
import { NotFoundError } from '../../lib/errors'
import { logEvent } from '../../lib/audit'
import { resolveTenantFromRequest } from '../../lib/tenant-isolation'
import { discoveryService } from './discovery.deps'

export const discoveryRouter: Router = Router()

const createSessionSchema = z.object({
  scopeType: z.enum(['WORKFLOW_STAGE', 'WORK_ITEM', 'RUN']),
  scopeId: z.string().min(1),
  touchPoint: z.string().min(1).optional(),
})

const elicitSchema = z.object({
  hint: z.string().max(2000).optional(),
  context: z.string().max(20000).optional(),
  capabilityId: z.string().optional(),
  research: z
    .object({ toolName: z.string().min(1), args: z.record(z.unknown()).default({}) })
    .optional(),
  budget: z
    .object({
      maxTurns: z.number().int().positive().optional(),
      maxToolCalls: z.number().int().nonnegative().optional(),
      maxInputTokens: z.number().int().positive().optional(),
      maxOutputTokens: z.number().int().positive().optional(),
    })
    .optional(),
})

const addQuestionSchema = z.object({
  text: z.string().min(1),
  kind: z.enum(['single_select', 'multi_select', 'freeform', 'clarification']).optional(),
  blocking: z.boolean().optional(),
  options: z.unknown().optional(),
})

const answerSchema = z.object({ answer: z.string().min(1) })

const addAssumptionSchema = z.object({
  text: z.string().min(1),
  confidence: z.number().min(0).max(1).optional(),
  evidenceRef: z.unknown().optional(),
})

const validateAssumptionSchema = z.object({
  status: z.enum(['PROPOSED', 'ACCEPTED', 'REJECTED', 'VALIDATED', 'INVALIDATED']),
  evidenceRef: z.unknown().optional(),
})

discoveryRouter.post('/sessions', validate(createSessionSchema), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof createSessionSchema>
    const session = await discoveryService.createSession({
      scopeType: body.scopeType,
      scopeId: body.scopeId,
      touchPoint: body.touchPoint,
      createdById: req.user!.userId,
      tenantId: resolveTenantFromRequest(req),
    })
    await logEvent('DiscoverySessionCreated', 'DiscoverySession', session.id, req.user!.userId, {
      scopeType: body.scopeType,
      scopeId: body.scopeId,
    })
    res.status(201).json(session)
  } catch (err) {
    next(err)
  }
})

discoveryRouter.get('/sessions/:id', async (req, res, next) => {
  try {
    const session = await discoveryService.getSession(String(req.params.id))
    if (!session) throw new NotFoundError('DiscoverySession', String(req.params.id))
    res.json(session)
  } catch (err) {
    next(err)
  }
})

discoveryRouter.post('/sessions/:id/elicit', validate(elicitSchema), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof elicitSchema>
    const result = await discoveryService.elicit({
      sessionId: String(req.params.id),
      userId: req.user!.userId,
      capabilityId: body.capabilityId,
      hint: body.hint,
      context: body.context,
      research: body.research,
      budget: body.budget,
    })
    await logEvent('DiscoveryElicited', 'DiscoverySession', String(req.params.id), req.user!.userId, {
      addedQuestions: result.addedQuestions.length,
      addedAssumptions: result.addedAssumptions.length,
      status: result.session.status,
      notes: result.notes,
    })
    res.json(result)
  } catch (err) {
    next(err)
  }
})

discoveryRouter.post('/sessions/:id/questions', validate(addQuestionSchema), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof addQuestionSchema>
    const question = await discoveryService.addQuestion({
      sessionId: String(req.params.id),
      tenantId: resolveTenantFromRequest(req),
      text: body.text,
      kind: body.kind,
      source: 'human',
      blocking: body.blocking,
      options: body.options,
    })
    res.status(201).json(question)
  } catch (err) {
    next(err)
  }
})

discoveryRouter.post('/questions/:qid/answer', validate(answerSchema), async (req, res, next) => {
  try {
    const { answer } = req.body as z.infer<typeof answerSchema>
    const question = await discoveryService.answerQuestion(String(req.params.qid), answer, req.user!.userId)
    res.json(question)
  } catch (err) {
    next(err)
  }
})

discoveryRouter.post('/questions/:qid/dismiss', async (req, res, next) => {
  try {
    const question = await discoveryService.dismissQuestion(String(req.params.qid))
    res.json(question)
  } catch (err) {
    next(err)
  }
})

discoveryRouter.post('/sessions/:id/assumptions', validate(addAssumptionSchema), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof addAssumptionSchema>
    const assumption = await discoveryService.addAssumption({
      sessionId: String(req.params.id),
      tenantId: resolveTenantFromRequest(req),
      text: body.text,
      confidence: body.confidence,
      evidenceRef: body.evidenceRef,
    })
    res.status(201).json(assumption)
  } catch (err) {
    next(err)
  }
})

discoveryRouter.post('/assumptions/:aid/validate', validate(validateAssumptionSchema), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof validateAssumptionSchema>
    const assumption = await discoveryService.validateAssumption(String(req.params.aid), body.status, {
      validatedById: req.user!.userId,
      evidenceRef: body.evidenceRef,
    })
    res.json(assumption)
  } catch (err) {
    next(err)
  }
})
