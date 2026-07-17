/**
 * Implementation submissions API — Work Item child resource (spec §7, §11). Mounted on
 * /api/work-items so routes are /api/work-items/:workItemId/submissions... Each submission is an
 * immutable record of one external implementation attempt against the published handoff.
 */
import { Router, type Request } from 'express'
import { validate } from '../../middleware/validate'
import { registerSubmissionSchema } from './submission.schemas'
import {
  listSubmissions,
  getSubmission,
  registerSubmission,
  validateSubmission,
} from './submissions.service'
import { loadAuthorizedWorkItem } from '../work-items/work-items.service'

export const submissionsRouter: Router = Router()

const workItemIdOf = (req: Request) => String(req.params.workItemId)
const submissionIdOf = (req: Request) => String(req.params.submissionId)

submissionsRouter.get('/:workItemId/submissions', async (req, res, next) => {
  try {
    await loadAuthorizedWorkItem(workItemIdOf(req), req.user!.userId)
    res.json(await listSubmissions(workItemIdOf(req)))
  } catch (err) { next(err) }
})

submissionsRouter.post('/:workItemId/submissions', validate(registerSubmissionSchema), async (req, res, next) => {
  try {
    await loadAuthorizedWorkItem(workItemIdOf(req), req.user!.userId, 'submit')
    const result = await registerSubmission(workItemIdOf(req), req.body, req.user!.userId)
    // 200 when the head SHA was already registered (idempotent), 201 for a fresh record.
    res.status(result.alreadyRegistered ? 200 : 201).json(result)
  } catch (err) { next(err) }
})

submissionsRouter.get('/:workItemId/submissions/:submissionId', async (req, res, next) => {
  try {
    await loadAuthorizedWorkItem(workItemIdOf(req), req.user!.userId)
    res.json(await getSubmission(workItemIdOf(req), submissionIdOf(req)))
  } catch (err) { next(err) }
})

submissionsRouter.post('/:workItemId/submissions/:submissionId/validate', async (req, res, next) => {
  try {
    await loadAuthorizedWorkItem(workItemIdOf(req), req.user!.userId)
    res.json(await validateSubmission(workItemIdOf(req), submissionIdOf(req)))
  } catch (err) { next(err) }
})
