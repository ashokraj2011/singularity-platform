import { Router } from 'express'
import { z } from 'zod'
import { validate } from '../../middleware/validate'
import { createWorkProgram, executeWorkProgram, getWorkProgram, getWorkProgramRun, listWorkPrograms, updateWorkProgram } from './work-programs.service'

export const workProgramsRouter: Router = Router()

const stepSchema = z.object({
  stepKey: z.string().trim().min(1).max(80),
  ordinal: z.coerce.number().int().min(0).optional(),
  titleTemplate: z.string().trim().min(3).max(240),
  descriptionTemplate: z.string().max(4000).optional(),
  workItemTypeKey: z.string().trim().max(80).optional(),
  targetCapabilityId: z.string().uuid(),
  workflowTemplateId: z.string().uuid().optional(),
  routingMode: z.enum(['MANUAL', 'AUTO_ATTACH', 'AUTO_START', 'SCHEDULED_START']).optional(),
  inputMapping: z.record(z.unknown()).optional(),
  dependsOnKeys: z.array(z.string()).optional(),
})

const programSchema = z.object({
  name: z.string().trim().min(2).max(200),
  description: z.string().max(4000).optional(),
  capabilityId: z.string().uuid().optional(),
  status: z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']).optional(),
  metadata: z.record(z.unknown()).optional(),
  steps: z.array(stepSchema).min(1).max(100),
})

workProgramsRouter.post('/', validate(programSchema), async (req, res, next) => {
  try {
    res.status(201).json(await createWorkProgram({ ...req.body, createdById: req.user!.userId }))
  } catch (err) { next(err) }
})

workProgramsRouter.get('/', async (req, res, next) => {
  try { res.json(await listWorkPrograms(req.user!.userId)) } catch (err) { next(err) }
})

workProgramsRouter.get('/:id', async (req, res, next) => {
  try {
    const program = await getWorkProgram(req.params.id, req.user!.userId)
    if (!program) return res.status(404).json({ error: 'WorkProgram not found' })
    res.json(program)
  } catch (err) { next(err) }
})

workProgramsRouter.patch('/:id', validate(programSchema.partial()), async (req, res, next) => {
  try { res.json(await updateWorkProgram(req.params.id, req.user!.userId, req.body)) } catch (err) { next(err) }
})

workProgramsRouter.post('/:id/execute', validate(z.object({ input: z.record(z.unknown()).default({}) })), async (req, res, next) => {
  try { res.status(201).json(await executeWorkProgram(req.params.id, req.body.input, req.user!.userId)) } catch (err) { next(err) }
})

workProgramsRouter.get('/:id/runs/:runId', async (req, res, next) => {
  try {
    const run = await getWorkProgramRun(req.params.id, req.params.runId, req.user!.userId)
    if (!run) return res.status(404).json({ error: 'WorkProgram run not found' })
    res.json(run)
  } catch (err) { next(err) }
})
