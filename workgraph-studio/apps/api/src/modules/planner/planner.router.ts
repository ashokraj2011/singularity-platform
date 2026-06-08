/**
 * Planner endpoints.
 *   POST /api/planner/converse — one conversational turn: the agent either asks
 *                                clarifying questions or returns/updates a
 *                                milestone-grouped roadmap (+ critic). Creates nothing.
 *   POST /api/planner/commit   — create a WorkItem for every task; each lands in
 *                                its target capability's inbox.
 */
import { Router } from 'express'
import { z } from 'zod'
import { validate } from '../../middleware/validate'
import { converse, commitRoadmap, chatMessageSchema, milestoneSchema } from './planner.service'

export const plannerRouter: Router = Router()

const converseSchema = z.object({
  capabilityId: z.string().uuid(),
  messages: z.array(chatMessageSchema).min(1).max(40),
  plan: z.array(milestoneSchema).max(12).optional(),
  allowChildren: z.boolean().optional().default(true),
  maxItems: z.coerce.number().int().min(1).max(40).optional(),
})

plannerRouter.post('/converse', validate(converseSchema), async (req, res) => {
  const body = req.body as z.infer<typeof converseSchema>
  const result = await converse(body, req.user!.userId)
  res.json(result)
})

const commitSchema = z.object({
  capabilityId: z.string().uuid(),
  milestones: z.array(milestoneSchema).min(1).max(12),
})

plannerRouter.post('/commit', validate(commitSchema), async (req, res) => {
  const body = req.body as z.infer<typeof commitSchema>
  const result = await commitRoadmap(body, req.user!.userId)
  res.status(201).json(result)
})
