/**
 * Developer handoff API — Work Item child resource (spec §5, §11). Mounted on /api/work-items so
 * routes are /api/work-items/:workItemId/development-target... The Work Item stays the root; the
 * handoff is a single child record derived from its approved specification.
 */
import { Router, type Request } from 'express'
import { validate } from '../../middleware/validate'
import { putDevelopmentTargetSchema } from './development-target.schemas'
import {
  getDevelopmentTarget,
  putDevelopmentTarget,
  publishDevelopmentTarget,
  getDeveloperPackage,
} from './development-targets.service'
import { loadAuthorizedWorkItem } from '../work-items/work-items.service'

export const developmentTargetsRouter: Router = Router()

const workItemIdOf = (req: Request) => String(req.params.workItemId)

developmentTargetsRouter.get('/:workItemId/development-target', async (req, res, next) => {
  try {
    await loadAuthorizedWorkItem(workItemIdOf(req), req.user!.userId)
    res.json(await getDevelopmentTarget(workItemIdOf(req)))
  } catch (err) { next(err) }
})

developmentTargetsRouter.put('/:workItemId/development-target', validate(putDevelopmentTargetSchema), async (req, res, next) => {
  try {
    await loadAuthorizedWorkItem(workItemIdOf(req), req.user!.userId, 'edit')
    res.json(await putDevelopmentTarget(workItemIdOf(req), req.body, req.user!.userId))
  } catch (err) { next(err) }
})

developmentTargetsRouter.post('/:workItemId/development-target/publish', async (req, res, next) => {
  try {
    await loadAuthorizedWorkItem(workItemIdOf(req), req.user!.userId, 'submit')
    res.json(await publishDevelopmentTarget(workItemIdOf(req), req.user!.userId))
  } catch (err) { next(err) }
})

developmentTargetsRouter.get('/:workItemId/developer-package', async (req, res, next) => {
  try {
    await loadAuthorizedWorkItem(workItemIdOf(req), req.user!.userId)
    res.json(await getDeveloperPackage(workItemIdOf(req)))
  } catch (err) { next(err) }
})
