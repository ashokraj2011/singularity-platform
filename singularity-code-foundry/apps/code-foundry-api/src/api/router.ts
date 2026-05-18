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
import { generateRouter } from './routes/generate.js'
import { verifyRouter } from './routes/verify.js'
import { llmTasksRouter } from './routes/llmTasks.js'

export const codegenRouter: Router = Router()

// Master gate.
codegenRouter.use(requireFlag('code_foundry.enabled'))

// Greenfield surface (M42.1 + M42.2 + M42.3 + M42.4). Everything sits
// behind the greenfield sub-flag. The LLM patch routes additionally
// require code_foundry.llm_patch.enabled to prevent gateway calls when
// admins turn that off but still want deterministic generation.
codegenRouter.use(requireFlag('code_foundry.greenfield.enabled'), specRouter)
codegenRouter.use(requireFlag('code_foundry.greenfield.enabled'), generateRouter)
codegenRouter.use(requireFlag('code_foundry.greenfield.enabled'), verifyRouter)
codegenRouter.use(
  requireFlag('code_foundry.greenfield.enabled'),
  requireFlag('code_foundry.llm_patch.enabled'),
  llmTasksRouter,
)
