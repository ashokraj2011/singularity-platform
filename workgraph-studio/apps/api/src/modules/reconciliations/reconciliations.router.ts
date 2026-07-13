/**
 * Reconciliation API — Work Item child resource (spec §11, §15). Mounted on /api/work-items so
 * routes are /api/work-items/:workItemId/... A reconciliation run measures one implementation
 * submission against the approved specification + published handoff and records a per-requirement
 * verdict matrix. The Work Item stays the permanent root.
 */
import { Router, type Request } from 'express'
import {
  startReconciliation,
  listReconciliations,
  getReconciliation,
} from './reconciliations.service'

export const reconciliationsRouter: Router = Router()

const workItemIdOf = (req: Request) => String(req.params.workItemId)

// Kick off a deterministic reconciliation for a specific submission.
reconciliationsRouter.post('/:workItemId/submissions/:submissionId/reconcile', async (req, res, next) => {
  try {
    const result = await startReconciliation(workItemIdOf(req), String(req.params.submissionId), req.user!.userId)
    res.status(201).json(result)
  } catch (err) { next(err) }
})

reconciliationsRouter.get('/:workItemId/reconciliations', async (req, res, next) => {
  try {
    const submissionId = typeof req.query.submissionId === 'string' ? req.query.submissionId : undefined
    res.json(await listReconciliations(workItemIdOf(req), submissionId))
  } catch (err) { next(err) }
})

reconciliationsRouter.get('/:workItemId/reconciliations/:runId', async (req, res, next) => {
  try {
    res.json(await getReconciliation(workItemIdOf(req), String(req.params.runId)))
  } catch (err) { next(err) }
})
