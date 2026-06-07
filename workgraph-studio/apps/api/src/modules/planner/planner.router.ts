/**
 * Planner endpoints.
 *   POST /api/planner/breakdown — preview: agent decomposes a goal into work
 *                                 items + an independent critic reviews. Creates nothing.
 *   POST /api/planner/commit    — create the (user-edited) work items; each lands
 *                                 in its target capability's inbox.
 */
import { Router } from 'express'
import { z } from 'zod'
import { validate } from '../../middleware/validate'
import { breakdownGoal, commitBreakdown, plannerItemSchema } from './planner.service'

export const plannerRouter: Router = Router()

const breakdownSchema = z.object({
  description: z.string().trim().min(8).max(8000),
  capabilityId: z.string().uuid(),
  allowChildren: z.boolean().optional().default(true),
  maxItems: z.coerce.number().int().min(1).max(40).optional(),
})

plannerRouter.post('/breakdown', validate(breakdownSchema), async (req, res) => {
  const body = req.body as z.infer<typeof breakdownSchema>
  const result = await breakdownGoal(body, req.user!.userId)
  res.json(result)
})

const commitSchema = z.object({
  capabilityId: z.string().uuid(),
  items: z.array(plannerItemSchema).min(1).max(40),
})

plannerRouter.post('/commit', validate(commitSchema), async (req, res) => {
  const body = req.body as z.infer<typeof commitSchema>
  const result = await commitBreakdown(body, req.user!.userId)
  res.status(201).json(result)
})
