/**
 * Operator-curation proxy router (task #111, M74 Phase 2C follow-up).
 *
 * Routes the web client's curation actions to audit-gov's
 * /api/v1/engine/* endpoints. The web client doesn't talk directly
 * to audit-gov because:
 *   (a) browser-side CORS would need a separate exception list,
 *   (b) the AUDIT_GOV_SERVICE_TOKEN is a service-to-service secret
 *       and shouldn't ship to browsers, and
 *   (c) the existing auth middleware on workgraph-api already
 *       enforces operator-level access — proxying preserves that
 *       check without a second auth surface to maintain.
 *
 * Exposed paths (mounted at /api/engine in app.ts):
 *
 *   GET    /datasets                           list datasets
 *   GET    /datasets/:id/examples              all examples
 *   GET    /datasets/:id/unreviewed-examples   gate-pending only
 *   PATCH  /dataset-examples/:id               mark reviewed
 *
 * Strict mode (not the fail-soft pattern used elsewhere in the
 * audit-gov client): the operator needs to see exactly what went
 * wrong with a write — "you forgot reviewed_by" (400) vs "audit-gov
 * is down" (502) vs "this example was deleted" (404). Each upstream
 * status is forwarded as-is.
 *
 * Operator identity: reviewed_by is filled from req.user (the
 * authMiddleware sub) when the client omits it, so the audit trail
 * always identifies a real reviewer instead of trusting whatever
 * the browser POSTs.
 */
import { Router, type Router as ExpressRouter, Request, Response } from 'express'

import { getJsonStrict, patchJsonStrict } from '../../lib/audit-gov/client'

// Explicit type annotation: TypeScript can't synthesise the inferred
// type for the Express Router instance without dragging the deep
// .pnpm path into the .d.ts (portability error TS2742). Naming the
// type explicitly keeps the emitted declarations clean.
export const curationRouter: ExpressRouter = Router()

// Exported for unit tests — the precedence logic is the load-bearing
// piece of operator identity for the audit trail and the request
// object is awkward to construct in tests, so we accept a minimal
// shape and let the caller pass it in.
export interface ReviewedBySource {
  bodyReviewedBy?: unknown
  user?: { userId?: string; email?: string } | undefined
}

export function resolveReviewedByFrom(src: ReviewedBySource): string {
  const fromBody = typeof src.bodyReviewedBy === 'string' && src.bodyReviewedBy.trim()
    ? src.bodyReviewedBy.trim()
    : ''
  if (fromBody) return fromBody
  const fromAuth = src.user?.email?.trim() || src.user?.userId?.trim() || ''
  return fromAuth || '(unknown)'
}

function resolveReviewedBy(req: Request): string {
  // Body wins (operator UI might let the user override, e.g. a lead
  // reviewing on behalf of someone else with an explicit note).
  // Otherwise fall back to the authenticated user (req.user is
  // augmented by authMiddleware — JWTUser shape from src/lib/jwt.ts).
  // Final fallback "(unknown)" is just so the audit-gov 400 fires
  // consistently instead of accepting a blank string downstream.
  return resolveReviewedByFrom({
    bodyReviewedBy: req.body?.reviewed_by,
    user: req.user,
  })
}

curationRouter.get('/datasets', async (_req: Request, res: Response) => {
  const r = await getJsonStrict<unknown>('api/v1/engine/datasets')
  res.status(r.ok ? 200 : r.status).json(r.ok ? r.data : { error: r.errorText })
})

curationRouter.get('/datasets/:id/examples', async (req: Request, res: Response) => {
  const limit = typeof req.query.limit === 'string' ? req.query.limit : undefined
  const r = await getJsonStrict<unknown>(
    `api/v1/engine/datasets/${encodeURIComponent(req.params.id)}/examples`,
    { limit },
  )
  res.status(r.ok ? 200 : r.status).json(r.ok ? r.data : { error: r.errorText })
})

curationRouter.get(
  '/datasets/:id/unreviewed-examples',
  async (req: Request, res: Response) => {
    const limit = typeof req.query.limit === 'string' ? req.query.limit : undefined
    const r = await getJsonStrict<unknown>(
      `api/v1/engine/datasets/${encodeURIComponent(req.params.id)}/unreviewed-examples`,
      { limit },
    )
    res.status(r.ok ? 200 : r.status).json(r.ok ? r.data : { error: r.errorText })
  },
)

curationRouter.patch(
  '/dataset-examples/:id',
  async (req: Request, res: Response) => {
    const reviewedBy = resolveReviewedBy(req)
    const body: Record<string, unknown> = {
      reviewed_by: reviewedBy,
    }
    if (typeof req.body?.review_notes === 'string') {
      body.review_notes = req.body.review_notes
    }
    if (req.body?.expected_output !== undefined) {
      body.expected_output = req.body.expected_output
    }
    const r = await patchJsonStrict<unknown>(
      `api/v1/engine/dataset-examples/${encodeURIComponent(req.params.id)}`,
      body,
    )
    res.status(r.ok ? 200 : r.status).json(r.ok ? r.data : { error: r.errorText })
  },
)
