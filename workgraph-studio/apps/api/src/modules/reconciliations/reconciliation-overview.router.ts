/**
 * Reconciliation overview API — a cross-Work-Item operator view (spec §10). Mounted at
 * /api/reconciliation-overview (top-level, not under a single Work Item) since it spans them all.
 */
import { Router, type Request } from 'express'
import { getReconciliationOverview } from './reconciliation-overview.service'

export const reconciliationOverviewRouter: Router = Router()

reconciliationOverviewRouter.get('/', async (req: Request, res, next) => {
  try {
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined
    res.json(await getReconciliationOverview(req.user!.userId, Number.isFinite(limit) ? (limit as number) : undefined))
  } catch (err) { next(err) }
})
