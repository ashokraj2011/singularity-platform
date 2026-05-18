/**
 * M42.1 — Express middleware that asserts a Foundry flag before
 * forwarding the request. Mount it per-route so different routes can
 * gate on different sub-flags (e.g. brownfield routes will check
 * code_foundry.brownfield.enabled in M42.5).
 *
 * Returns 503 + the structured FeatureDisabledError payload so callers
 * (CLI, web UI, downstream services) all see the same shape.
 */
import type { NextFunction, Request, Response } from 'express'
import type { FoundryFlag } from '@singularity-code-foundry/feature-flags'
import { FeatureDisabledError, getFlagsClient } from './featureFlags.js'

export function requireFlag(flag: FoundryFlag) {
  return async function gate(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      await getFlagsClient().assertEnabled(flag)
      next()
    } catch (err) {
      if (err instanceof FeatureDisabledError) {
        res.status(503).json(err.toJSON())
        return
      }
      next(err)
    }
  }
}
