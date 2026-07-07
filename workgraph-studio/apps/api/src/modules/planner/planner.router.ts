/**
 * Planner endpoints.
 *   POST /api/planner/converse — one conversational turn: the agent either asks
 *                                clarifying questions or returns/updates a
 *                                milestone-grouped roadmap (+ critic). Creates nothing.
 *   POST /api/planner/commit   — create a WorkItem for every task; each lands in
 *                                its target capability's inbox.
 */
import { Router, type Request } from 'express'
import { z } from 'zod'
import { validate } from '../../middleware/validate'
import { converse, commitRoadmap, launchRoadmap, chatMessageSchema, milestoneSchema } from './planner.service'

export const plannerRouter: Router = Router()

function callerBearerToken(req: Request): string | undefined {
  const auth = req.headers.authorization ?? ''
  if (!auth.startsWith('Bearer ')) return undefined
  const token = auth.slice('Bearer '.length).trim()
  return token || undefined
}

const converseSchema = z.object({
  capabilityId: z.string().uuid(),
  messages: z.array(chatMessageSchema).min(1).max(40),
  plan: z.array(milestoneSchema).max(12).optional(),
  allowChildren: z.boolean().optional().default(true),
  maxItems: z.coerce.number().int().min(1).max(40).optional(),
})

plannerRouter.post('/converse', validate(converseSchema), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof converseSchema>
    const result = await converse(body, req.user!.userId, callerBearerToken(req))
    res.json(result)
  } catch (err) {
    next(err)
  }
})

const commitSchema = z.object({
  capabilityId: z.string().uuid(),
  milestones: z.array(milestoneSchema).min(1).max(12),
})

plannerRouter.post('/commit', validate(commitSchema), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof commitSchema>
    const result = await commitRoadmap(body, req.user!.userId, callerBearerToken(req))
    res.status(201).json(result)
  } catch (err) {
    next(err)
  }
})

const launchSchema = z.object({
  capabilityId: z.string().uuid(),
  intent: z.string().optional(),
  story: z.string().max(12000).optional(),
  plan: z.array(milestoneSchema).max(12).optional(),
  milestones: z.array(milestoneSchema).max(12).optional(),
  workflowTemplateId: z.string().uuid().optional(),
  modelAlias: z.string().max(120).optional(),
  runtimePreference: z.string().max(120).optional(),
  governancePreset: z.string().max(120).optional(),
}).refine(body => (body.plan?.length ?? 0) > 0 || (body.milestones?.length ?? 0) > 0 || (body.story?.trim().length ?? 0) >= 8, {
  message: 'Provide a planner roadmap or a story with at least 8 characters.',
})

plannerRouter.post('/launch', validate(launchSchema), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof launchSchema>
    const result = await launchRoadmap(body, req.user!.userId, callerBearerToken(req))
    res.status(201).json(result)
  } catch (err) {
    next(err)
  }
})
