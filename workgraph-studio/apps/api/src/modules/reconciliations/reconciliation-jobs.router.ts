/**
 * Reconciliation job queue API (spec §15, "Layer 2") — the runner-facing surface, mounted at
 * /api/reconciliation-jobs. An out-of-process runner polls pending jobs, claims one (getting a
 * fresh claimToken), executes its test plan against the submission's head commit in isolation,
 * then completes or fails the job with that token. Kept OUT of the /api/work-items tree because a
 * runner claims the next available job across Work Items, not a child of one Work Item.
 */
import { Router, type Request } from 'express'
import { z } from 'zod'
import { validate } from '../../middleware/validate'
import {
  listPendingReconciliationJobs,
  getReconciliationJob,
  claimReconciliationJob,
  completeReconciliationJob,
  failReconciliationJob,
} from './reconciliations.service'

export const reconciliationJobsRouter: Router = Router()

const jobIdOf = (req: Request) => String(req.params.jobId)

const testResultSchema = z.object({
  obligationId: z.string().trim().optional(),
  name: z.string().trim().optional(),
  requirementIds: z.array(z.string().trim().min(1)).optional(),
  status: z.string().trim().min(1),
  output: z.string().optional(),
}).passthrough()
const completeSchema = z.object({ claimToken: z.string().trim().min(1), tests: z.array(testResultSchema).default([]) })
const failSchema = z.object({ claimToken: z.string().trim().min(1), error: z.string().trim().min(1).max(8000) })

// Poll the pending queue.
reconciliationJobsRouter.get('/', async (req, res, next) => {
  try {
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined
    res.json(await listPendingReconciliationJobs(Number.isFinite(limit) ? (limit as number) : undefined))
  } catch (err) { next(err) }
})

reconciliationJobsRouter.get('/:jobId', async (req, res, next) => {
  try {
    res.json(await getReconciliationJob(jobIdOf(req)))
  } catch (err) { next(err) }
})

// Atomic claim — mints and returns a claimToken to the single winner (409 to everyone else).
reconciliationJobsRouter.post('/:jobId/claim', async (req, res, next) => {
  try {
    res.json(await claimReconciliationJob(jobIdOf(req), req.user!.userId))
  } catch (err) { next(err) }
})

// Token-gated: fold executed test results into the run's verdicts and finalize it.
reconciliationJobsRouter.post('/:jobId/complete', validate(completeSchema), async (req, res, next) => {
  try {
    const { claimToken, tests } = req.body as z.infer<typeof completeSchema>
    res.json(await completeReconciliationJob(jobIdOf(req), claimToken, tests, req.user!.userId))
  } catch (err) { next(err) }
})

// Token-gated: mark the run errored (the runner could not execute the plan).
reconciliationJobsRouter.post('/:jobId/fail', validate(failSchema), async (req, res, next) => {
  try {
    const { claimToken, error } = req.body as z.infer<typeof failSchema>
    res.json(await failReconciliationJob(jobIdOf(req), claimToken, error, req.user!.userId))
  } catch (err) { next(err) }
})
