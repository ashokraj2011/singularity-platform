import { z } from 'zod'

/**
 * Structured SpecificationPackage — the versioned JSON stored on SpecificationVersion.package.
 * This is the contract the whole spec→reconciliation flow keys off: requirements carry stable
 * IDs and trace to sources, acceptance criteria + test obligations reference requirements, and
 * (later) reconciliation produces a verdict per requirement id. Kept intentionally structured
 * for the core (requirements / AC / test obligations / sources) and permissive (`passthrough`)
 * for the richer, still-evolving parts (contracts, risks) so authoring isn't blocked.
 */

export const REQUIREMENT_TYPES = ['FUNCTIONAL', 'SECURITY', 'PRIVACY', 'PERFORMANCE', 'RELIABILITY', 'OPERABILITY', 'COMPLIANCE'] as const
export const REQUIREMENT_PRIORITIES = ['MUST', 'SHOULD', 'MAY'] as const
export const REQUIREMENT_RISKS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const
export const CONTRACT_KINDS = ['OPENAPI', 'ASYNCAPI', 'PROTOBUF', 'JSON_SCHEMA', 'DATABASE', 'EVENT', 'STATE_TRANSITION'] as const

const idString = z.string().trim().min(1).max(120)

export const specificationSourceSchema = z.object({
  id: idString,
  kind: z.string().trim().max(60).default('DOCUMENT'),
  label: z.string().trim().max(300).default(''),
  ref: z.string().trim().max(600).optional(),
}).passthrough()

export const glossaryTermSchema = z.object({
  term: z.string().trim().min(1).max(200),
  definition: z.string().trim().max(2000).default(''),
})

export const specificationRequirementSchema = z.object({
  id: idString,
  type: z.enum(REQUIREMENT_TYPES).catch('FUNCTIONAL').default('FUNCTIONAL'),
  statement: z.string().trim().min(1).max(4000),
  rationale: z.string().trim().max(2000).optional(),
  priority: z.enum(REQUIREMENT_PRIORITIES).catch('SHOULD').default('SHOULD'),
  risk: z.enum(REQUIREMENT_RISKS).catch('MEDIUM').default('MEDIUM'),
  sourceIds: z.array(idString).default([]),
  acceptanceCriterionIds: z.array(idString).default([]),
  testObligationIds: z.array(idString).default([]),
})

export const acceptanceCriterionSchema = z.object({
  id: idString,
  requirementIds: z.array(idString).default([]),
  given: z.array(z.string().trim().min(1).max(1000)).default([]),
  when: z.array(z.string().trim().min(1).max(1000)).default([]),
  then: z.array(z.string().trim().min(1).max(1000)).default([]),
})

export const testObligationSchema = z.object({
  id: idString,
  verifies: z.array(idString).default([]),
  kind: z.string().trim().max(60).default('behavior'),
  description: z.string().trim().max(2000).default(''),
  requiredEvidence: z.array(z.string().trim().min(1).max(60)).default([]),
  minimumCases: z.array(z.string().trim().min(1).max(600)).default([]),
})

export const specificationContractSchema = z.object({
  id: idString,
  kind: z.enum(CONTRACT_KINDS).catch('JSON_SCHEMA').default('JSON_SCHEMA'),
  format: z.string().trim().max(40).optional(),
  content: z.string().max(200_000).optional(),
}).passthrough()

export const specificationRiskSchema = z.object({
  id: idString,
  description: z.string().trim().max(2000).default(''),
  severity: z.enum(REQUIREMENT_RISKS).catch('MEDIUM').default('MEDIUM'),
}).passthrough()

export const openQuestionSchema = z.object({
  id: idString,
  question: z.string().trim().min(1).max(2000),
  answered: z.boolean().default(false),
  answer: z.string().trim().max(2000).optional(),
})

export const reconciliationPolicySchema = z.object({
  profile: z.string().trim().max(60).default('STANDARD'),
  requiredEvidence: z.array(z.string().trim().min(1).max(60)).default([]),
  forbiddenPaths: z.array(z.string().trim().min(1).max(600)).default([]),
  requiredPaths: z.array(z.string().trim().min(1).max(600)).default([]),
}).passthrough()

// The parts an author can supply/edit. version/workItem identity is stamped by the service.
export const specificationPackageBodySchema = z.object({
  summary: z.string().trim().max(20_000).default(''),
  glossary: z.array(glossaryTermSchema).default([]),
  sources: z.array(specificationSourceSchema).default([]),
  requirements: z.array(specificationRequirementSchema).default([]),
  acceptanceCriteria: z.array(acceptanceCriterionSchema).default([]),
  testObligations: z.array(testObligationSchema).default([]),
  contracts: z.array(specificationContractSchema).default([]),
  risks: z.array(specificationRiskSchema).default([]),
  outOfScope: z.array(z.string().trim().min(1).max(600)).default([]),
  openQuestions: z.array(openQuestionSchema).default([]),
  reconciliationPolicy: reconciliationPolicySchema.default({}),
})

export type SpecificationRequirement = z.infer<typeof specificationRequirementSchema>
export type AcceptanceCriterion = z.infer<typeof acceptanceCriterionSchema>
export type TestObligation = z.infer<typeof testObligationSchema>
export type SpecificationPackageBody = z.infer<typeof specificationPackageBodySchema>

// The full stored package = author body + stamped identity/version metadata.
export type SpecificationPackage = SpecificationPackageBody & {
  schemaVersion: '1.0'
  workItem: { id: string; workCode: string; title: string }
  version: { id: string; number: number; status: string; revision: number; contentHash?: string }
}

/** An empty, valid package body — the starting point for a new draft. */
export function emptySpecificationPackageBody(): SpecificationPackageBody {
  return specificationPackageBodySchema.parse({})
}
