/**
 * M42.1 — Top-level Code Foundry router.
 *
 * Every /api/codegen/* route is gated on `code_foundry.enabled` (master
 * switch). When OFF the entire surface returns 503 with the structured
 * FeatureDisabledError payload — operators see one consistent shape
 * across CLI, REST, and (M42.6) web UI.
 *
 * Greenfield spec routes are additionally gated on
 * `code_foundry.greenfield.enabled`. Brownfield routes (M42.5) will
 * gate on `code_foundry.brownfield.enabled`.
 */
import { Router } from 'express'
import { requireFlag } from '../lib/featureGate.js'
import { specRouter } from './routes/spec.js'

export const codegenRouter: Router = Router()

// Master gate.
codegenRouter.use(requireFlag('code_foundry.enabled'))

// Greenfield spec spine (M42.1).
codegenRouter.use(requireFlag('code_foundry.greenfield.enabled'), specRouter)
