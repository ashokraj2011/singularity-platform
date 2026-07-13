/**
 * Specification API — Work Item child resource. Mounted on /api/work-items so its routes are
 * /api/work-items/:workItemId/specifications... The Work Item stays the root; specification
 * VERSIONS are child records (spec §11). Kept in its own router (not work-items.router.ts).
 */
import { Router, type Request } from 'express'
import { z } from 'zod'
import { validate } from '../../middleware/validate'
import { specificationPackageBodySchema } from './specification.schemas'
import {
  listSpecificationVersions,
  getSpecificationVersion,
  createSpecificationDraft,
  updateSpecificationDraft,
  validateSpecificationVersion,
  approveSpecificationVersion,
} from './specifications.service'

export const specificationsRouter: Router = Router()

const createDraftSchema = z.object({
  basedOnVersionId: z.string().uuid().optional(),
  sourceIds: z.array(z.string().trim().min(1)).optional(),
})

// Optimistic-concurrency edit: expectedRevision + any subset of the package body sections.
const updateSchema = specificationPackageBodySchema.partial().extend({
  expectedRevision: z.number().int().min(1),
})

const approveSchema = z.object({ comment: z.string().trim().max(4000).optional() })

const workItemIdOf = (req: Request) => String(req.params.workItemId)
const versionIdOf = (req: Request) => String(req.params.versionId)

specificationsRouter.get('/:workItemId/specifications', async (req, res, next) => {
  try {
    res.json(await listSpecificationVersions(workItemIdOf(req)))
  } catch (err) { next(err) }
})

specificationsRouter.post('/:workItemId/specifications', validate(createDraftSchema), async (req, res, next) => {
  try {
    res.status(201).json(await createSpecificationDraft(workItemIdOf(req), req.body, req.user!.userId))
  } catch (err) { next(err) }
})

specificationsRouter.get('/:workItemId/specifications/:versionId', async (req, res, next) => {
  try {
    res.json(await getSpecificationVersion(workItemIdOf(req), versionIdOf(req)))
  } catch (err) { next(err) }
})

specificationsRouter.patch('/:workItemId/specifications/:versionId', validate(updateSchema), async (req, res, next) => {
  try {
    const { expectedRevision, ...body } = req.body as z.infer<typeof updateSchema>
    res.json(await updateSpecificationDraft(workItemIdOf(req), versionIdOf(req), { expectedRevision, body }, req.user!.userId))
  } catch (err) { next(err) }
})

specificationsRouter.post('/:workItemId/specifications/:versionId/validate', async (req, res, next) => {
  try {
    res.json(await validateSpecificationVersion(workItemIdOf(req), versionIdOf(req)))
  } catch (err) { next(err) }
})

specificationsRouter.post('/:workItemId/specifications/:versionId/approve', validate(approveSchema), async (req, res, next) => {
  try {
    res.status(200).json(await approveSpecificationVersion(workItemIdOf(req), versionIdOf(req), req.body, req.user!.userId))
  } catch (err) { next(err) }
})
