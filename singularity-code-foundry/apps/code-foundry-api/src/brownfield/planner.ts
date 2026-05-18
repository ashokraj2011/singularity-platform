/**
 * M42.5 — Change Planner (§25.7).
 *
 * Walks an enhancement + impact report and emits typed
 * ChangeOperation entries. Each operation carries:
 *   - `targetFile`           the path the operation modifies
 *   - `deterministic`        true → applied by a recipe; false → an
 *                            LLM patch task is built (Chain D)
 *   - `llmEligible`          set when deterministic = false and the
 *                            change can be bounded to one editable
 *                            region
 *
 * The plan is the input to the dispatcher (Chain C): for each
 * operation, dispatch either the matching recipe or an LLM task.
 */
import { sha256 } from '../spec/hash.js'
import { canonicalize } from '../spec/canonicalize.js'
import type {
  ChangeOperation, ChangeOperationType, ChangePlan, EnhancementSpec,
  ImpactReport, RepoModel,
} from './types.js'

export interface PlanInput {
  enhancementSpec: EnhancementSpec
  repoModel: RepoModel
  impact: ImpactReport
  repoModelHash: string
  enhancementSpecHash: string
}

export class PlannerError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message)
    this.name = 'PlannerError'
  }
}

export function buildChangePlan(input: PlanInput): ChangePlan {
  const { enhancementSpec, repoModel, impact } = input

  if (!impact.knownPattern) {
    // Unknown pattern → emit an empty deterministic plan; dispatcher
    // will route to LLM-proposes-plan branch. We still record the
    // hashes so the receipt chain stays intact.
    return {
      planVersion: '1.0.0',
      changeType: enhancementSpec.enhancement.type,
      knownPattern: false,
      riskLevel: impact.riskLevel,
      publicContractChange: impact.publicContractChange,
      requiresHumanApproval: impact.requiresHumanApproval,
      operations: [],
      enhancementSpecHash: input.enhancementSpecHash,
      repoModelHash: input.repoModelHash,
    }
  }

  const ops: ChangeOperation[] = []
  const targetModel = repoModel.models.find(m => m.name === enhancementSpec.enhancement.targetModel)
  if (!targetModel) {
    throw new PlannerError(
      `Target model '${enhancementSpec.enhancement.targetModel}' missing — re-scan the repo before planning.`,
      'TARGET_MODEL_MISSING',
    )
  }

  // 1. ADD_FIELD on the DTO/model file — fully deterministic.
  if (enhancementSpec.update?.dto !== false) {
    ops.push(opAddField({
      targetFile: targetModel.file,
      targetClass: targetModel.name,
      field: enhancementSpec.field,
    }))
  }

  // 2. UPDATE_OPENAPI_SCHEMA on any detected openapi contract files —
  // deterministic, since YAML edits are mechanical.
  if (enhancementSpec.update?.openapi !== false) {
    for (const c of repoModel.contracts) {
      ops.push({
        operation: 'UPDATE_OPENAPI_SCHEMA' satisfies ChangeOperationType,
        targetFile: c.file,
        schemaName: targetModel.name,
        field: enhancementSpec.field,
        deterministic: true,
        description: `Add property '${enhancementSpec.field.name}' to OpenAPI schema '${targetModel.name}'.`,
      })
    }
  }

  // 3. UPDATE_SERVICE_MAPPING — LLM-eligible. Maps the new field
  // inside the existing service body. The recipe drops in an
  // `<llm-editable>` region scoped to one method.
  if (enhancementSpec.update?.serviceMapping !== false) {
    const svc = pickServiceImpl(repoModel, enhancementSpec.enhancement.targetEndpoint)
    if (svc) {
      ops.push({
        operation: 'UPDATE_SERVICE_MAPPING' satisfies ChangeOperationType,
        targetFile: svc.file,
        targetClass: svc.className,
        targetMethod: enhancementSpec.enhancement.targetEndpoint,
        field: enhancementSpec.field,
        deterministic: false,
        llmEligible: true,
        description: `Map new field '${enhancementSpec.field.name}' inside '${svc.className}.${enhancementSpec.enhancement.targetEndpoint}' (LLM-bounded).`,
      })
    }
  }

  // 4. UPDATE_TEST_EXPECTATION — LLM-eligible. Extends existing test
  // assertions to cover the new field.
  if (enhancementSpec.update?.tests !== false) {
    for (const t of repoModel.tests) {
      const lc = t.className.toLowerCase()
      if (lc.includes(targetModel.name.toLowerCase())
          || lc.includes(enhancementSpec.enhancement.targetEndpoint.toLowerCase())
          || impact.affectedFiles.includes(t.file)) {
        ops.push({
          operation: 'UPDATE_TEST_EXPECTATION' satisfies ChangeOperationType,
          targetFile: t.file,
          targetClass: t.className,
          field: enhancementSpec.field,
          deterministic: false,
          llmEligible: true,
          description: `Extend assertions in '${t.className}' to cover '${enhancementSpec.field.name}' (LLM-bounded).`,
        })
        break // only patch one test file per V1 to keep the change small
      }
    }
  }

  return {
    planVersion: '1.0.0',
    changeType: enhancementSpec.enhancement.type,
    knownPattern: true,
    riskLevel: impact.riskLevel,
    publicContractChange: impact.publicContractChange,
    requiresHumanApproval: impact.requiresHumanApproval,
    operations: ops,
    enhancementSpecHash: input.enhancementSpecHash,
    repoModelHash: input.repoModelHash,
  }
}

function opAddField(args: {
  targetFile: string
  targetClass: string
  field: EnhancementSpec['field']
}): ChangeOperation {
  return {
    operation: 'ADD_FIELD',
    targetFile: args.targetFile,
    targetClass: args.targetClass,
    field: args.field,
    deterministic: true,
    description: `Add field '${args.field.name}: ${args.field.type}' to '${args.targetClass}'.`,
  }
}

function pickServiceImpl(model: RepoModel, operationId: string): { file: string; className: string } | undefined {
  if (model.services.length === 0) return undefined
  const stem = operationId
    .replace(/^(get|post|put|patch|delete)/i, '')
    .replace(/^./, c => c.toUpperCase())
  const byStem = model.services.find(s => s.className.toLowerCase().includes(stem.toLowerCase()))
  return byStem ?? model.services[0]
}

/** Convenience helper used by the route + CLI: derive the plan hash
 *  the receipt + DB row need. Keeps callers from re-hashing manually. */
export function hashPlan(plan: ChangePlan): string {
  return sha256(canonicalize(plan))
}
