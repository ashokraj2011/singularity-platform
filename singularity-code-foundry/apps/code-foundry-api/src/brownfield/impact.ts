/**
 * M42.5 — Impact Analyzer (§25.6).
 *
 * Given an EnhancementSpec + a RepoModel, classify what the change
 * actually does to the repo. The output drives the Change Planner
 * (which operations to emit) and the human-approval gate (whether
 * the change rewrites a public contract, which forces an approval
 * step even when the recipe is fully deterministic).
 *
 * V1 supports a single enhancement type (`ADD_RESPONSE_FIELD`), so the
 * branching is small. The shape is built to fan out cleanly as
 * additional recipes land.
 */
import type { EnhancementSpec, ImpactReport, RepoModel } from './types.js'

export interface ImpactInput {
  enhancementSpec: EnhancementSpec
  repoModel: RepoModel
}

export class ImpactAnalysisError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message)
    this.name = 'ImpactAnalysisError'
  }
}

export function analyseImpact(input: ImpactInput): ImpactReport {
  const { enhancementSpec, repoModel } = input
  const type = enhancementSpec.enhancement.type

  // V1 only knows about ADD_RESPONSE_FIELD; anything else is reported as
  // an unknown pattern so the dispatcher hands off to the LLM-proposed-
  // plan branch (Chain C).
  if (type !== 'ADD_RESPONSE_FIELD') {
    return {
      enhancementType: type,
      knownPattern: false,
      riskLevel: 'high',
      affectedFiles: [],
      publicContractChange: true,
      requiresHumanApproval: true,
      llmNeeded: true,
      llmReason: `Enhancement type '${type}' has no deterministic recipe in V1.`,
    }
  }

  // For ADD_RESPONSE_FIELD we need to find the target model + the
  // endpoint that returns it. Anything missing is fatal at analysis
  // time — the planner can't make sensible decisions otherwise.
  const targetModel = repoModel.models.find(m => m.name === enhancementSpec.enhancement.targetModel)
  if (!targetModel) {
    throw new ImpactAnalysisError(
      `Target model '${enhancementSpec.enhancement.targetModel}' not found in repo model.`,
      'TARGET_MODEL_MISSING',
    )
  }
  const allEndpoints = repoModel.controllers.flatMap(c => c.endpoints)
  const targetEndpoint = allEndpoints.find(e => e.operationId === enhancementSpec.enhancement.targetEndpoint)
  if (!targetEndpoint) {
    throw new ImpactAnalysisError(
      `Target endpoint operationId '${enhancementSpec.enhancement.targetEndpoint}' not found in repo model.`,
      'TARGET_ENDPOINT_MISSING',
    )
  }

  // Reject duplicate field names early — adding the same field name as
  // an existing one is almost always a spec bug, not a real change.
  if (targetModel.fields.some(f => f.name === enhancementSpec.field.name)) {
    throw new ImpactAnalysisError(
      `Field '${enhancementSpec.field.name}' already exists on model '${targetModel.name}'.`,
      'FIELD_ALREADY_EXISTS',
    )
  }

  const affectedFiles: string[] = []
  affectedFiles.push(targetModel.file)

  // OpenAPI contract update — we look for any contract entry. The
  // recipe will patch it; if no contract exists we still mark the
  // change as a public-contract change because the wire format is
  // changing.
  for (const c of repoModel.contracts) {
    if (!affectedFiles.includes(c.file)) affectedFiles.push(c.file)
  }

  // Service implementation — heuristic: the service whose file lives
  // closest to the controller's package, or the first matching
  // *Service. Real recipe resolves this; the impact view just needs
  // the affected-files list.
  const svc = pickServiceImpl(repoModel, targetEndpoint.controllerClass)
  if (svc) affectedFiles.push(svc.file)

  // Test impact — every test that names the target model, the target
  // endpoint's operationId, or the controller that owns the endpoint.
  // The controller-stem fall-through catches the canonical
  // `XxxControllerTest` naming the templates emit.
  const ctrlStem = targetEndpoint.controllerClass
    ? targetEndpoint.controllerClass.replace(/Controller$/, '').toLowerCase()
    : ''
  for (const t of repoModel.tests) {
    const lc = t.className.toLowerCase()
    if (lc.includes(targetModel.name.toLowerCase())
        || lc.includes(targetEndpoint.operationId.toLowerCase())
        || (ctrlStem && lc.includes(ctrlStem))) {
      affectedFiles.push(t.file)
    }
  }

  const publicContractChange = true        // adding a response field IS a contract change
  const requiresHumanApproval = publicContractChange
  // LLM is needed for the mapping logic + test assertion update — both
  // are bounded to a single editable region per file (Chain D).
  const llmNeeded = enhancementSpec.update?.serviceMapping !== false
    || enhancementSpec.update?.tests !== false

  return {
    enhancementType: type,
    knownPattern: true,
    riskLevel: 'medium',
    affectedFiles: dedupe(affectedFiles),
    publicContractChange,
    requiresHumanApproval,
    llmNeeded,
    llmReason: llmNeeded
      ? 'Service mapping body and/or test assertions need bounded LLM completion inside llm-editable regions.'
      : undefined,
  }
}

function pickServiceImpl(model: RepoModel, controllerClass?: string): { file: string } | undefined {
  if (model.services.length === 0) return undefined
  if (controllerClass) {
    // Try to match by prefix: EligibilityController → EligibilityService.
    const stem = controllerClass.replace(/Controller$/, '')
    const byPrefix = model.services.find(s => s.className.startsWith(stem))
    if (byPrefix) return byPrefix
  }
  return model.services[0]
}

function dedupe<T>(arr: T[]): T[] {
  return Array.from(new Set(arr))
}
