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
import { bearerAuth } from '../lib/bearer.js'
import { specRouter } from './routes/spec.js'
import { generateRouter } from './routes/generate.js'
import { verifyRouter } from './routes/verify.js'
import { llmTasksRouter } from './routes/llmTasks.js'
import { brownfieldRouter } from './routes/brownfield.js'
import { runsRouter } from './routes/runs.js'

export const codegenRouter: Router = Router()

// M42.6 — Bearer auth applied to every codegen route. Pass-through
// when CODEGEN_SERVICE_TOKEN is the dev default OR the caller is on
// localhost, so the local docker-compose flow + the SPA running on
// :5181 against :3005 both keep working without extra configuration.
codegenRouter.use(bearerAuth())

// Master gate.
codegenRouter.use(requireFlag('code_foundry.enabled'))

// Greenfield surface (M42.1 + M42.2 + M42.3 + M42.4). Everything sits
// behind the greenfield sub-flag. The LLM patch routes additionally
// require code_foundry.llm_patch.enabled to prevent gateway calls when
// admins turn that off but still want deterministic generation.
codegenRouter.use(requireFlag('code_foundry.greenfield.enabled'), specRouter)
codegenRouter.use(requireFlag('code_foundry.greenfield.enabled'), generateRouter)
codegenRouter.use(requireFlag('code_foundry.greenfield.enabled'), verifyRouter)
// Read-only list/detail endpoints used by the M42.6 SPA. Gated on the
// master flag only — these are read across both greenfield and brownfield
// runs and the SPA shows runs from both modes side-by-side.
codegenRouter.use(runsRouter)
codegenRouter.use(
  requireFlag('code_foundry.greenfield.enabled'),
  requireFlag('code_foundry.llm_patch.enabled'),
  llmTasksRouter,
)

// Brownfield surface (M42.5) — Patent Chains B + C. Gated on the
// brownfield sub-flag (OFF by default). The recipes themselves do not
// call the LLM directly; the residual UPDATE_SERVICE_MAPPING +
// UPDATE_TEST_EXPECTATION operations build LlmPatchTask rows that go
// through the same llmTasks dispatch path, so llm_patch is enforced
// at the existing apply-patch endpoint.
codegenRouter.use(requireFlag('code_foundry.brownfield.enabled'), brownfieldRouter)
