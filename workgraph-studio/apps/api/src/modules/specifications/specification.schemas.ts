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

/**
 * Requirement obligations — the checkable grammar beside the prose.
 *
 * A requirement's `statement` is prose, so "does this diff implement REQ-3" is only decidable by a
 * judge. An obligation is a small TYPED assertion attached to that requirement which a machine can
 * decide on its own. Prose stays authoritative for humans; obligations move individual, mechanical
 * facts out of the judgement column so coverage becomes measurable rather than binary.
 *
 * Deliberately narrow — two kinds, both backed by machinery that already exists:
 *   SYMBOL   — a named symbol of a given kind lives at a given path (tree-sitter AST index).
 *   CONTRACT — a contract declared in `contracts[]` is well-formed, declares the named
 *              operations/fields, and its artifact is delivered by the submission.
 *
 * HASH SAFETY: `obligations` is `.optional()` on the requirement, NOT `.default([])`. Zod omits an
 * absent optional key entirely, so a requirement that declares no obligations parses to exactly the
 * object it parsed to before this field existed, and `specificationContentHash` (which canonicalizes
 * over present keys) is unchanged. A `.default([])` would inject `obligations: []` into every
 * requirement and re-hash every frozen SpecificationVersion. See test/specification-obligations.test.ts.
 */
export const OBLIGATION_KINDS = ['SYMBOL', 'CONTRACT'] as const

/**
 * Symbol kinds the AST index actually classifies (mcp-server `kindOf`). Intentionally NOT including
 * an `exported` assertion: the index stores no export flag — it is only recoverable by regexing the
 * stored `signature` text, which misses `export { x }` re-export lists and is meaningless for Go
 * (capitalisation) and Java (modifiers). Asserting exported-ness would be a check we cannot honour.
 */
export const SYMBOL_KINDS = ['function', 'class', 'method', 'interface', 'type', 'enum', 'const'] as const

export const symbolObligationSchema = z.object({
  id: idString,
  kind: z.literal('SYMBOL'),
  /** Repository-relative path the symbol is expected to live in. */
  path: z.string().trim().min(1).max(600),
  /** Symbol name, matched exactly. */
  symbol: z.string().trim().min(1).max(200),
  /** Optional expected symbol kind; omitted means "any kind". */
  symbolKind: z.enum(SYMBOL_KINDS).optional(),
})

export const contractObligationSchema = z.object({
  id: idString,
  kind: z.literal('CONTRACT'),
  /** id of an entry in the package's `contracts[]`. */
  contractId: idString,
  /** Optional repository path of the artifact carrying this contract; checked against the manifest. */
  path: z.string().trim().max(600).optional(),
  /** OPENAPI: `METHOD /path` operations that must be declared by the contract. */
  operations: z.array(z.string().trim().min(1).max(300)).optional(),
  /** JSON_SCHEMA: top-level property names that must be declared by the contract. */
  fields: z.array(z.string().trim().min(1).max(200)).optional(),
})

export const requirementObligationSchema = z.discriminatedUnion('kind', [
  symbolObligationSchema,
  contractObligationSchema,
])

export const specificationRequirementSchema = z.object({
  id: idString,
  type: z.enum(REQUIREMENT_TYPES).catch('FUNCTIONAL').default('FUNCTIONAL'),
  statement: z.string().trim().min(1).max(4000),
  rationale: z.string().trim().max(2000).optional(),
  priority: z.enum(REQUIREMENT_PRIORITIES).catch('SHOULD').default('SHOULD'),
  risk: z.enum(REQUIREMENT_RISKS).catch('MEDIUM').default('MEDIUM'),
  sourceIds: z.array(idString).default([]),
  objectiveRefs: z.array(z.string().uuid()).default([]),
  acceptanceCriterionIds: z.array(idString).default([]),
  testObligationIds: z.array(idString).default([]),
  // Optional by design — see HASH SAFETY above. Never give this a default.
  obligations: z.array(requirementObligationSchema).optional(),
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

// Spec Studio — diagrams authored as structured node/edge graphs (rendered with reactflow; an
// optional free-form `source`, e.g. mermaid, can ride along). Architects sketch flows, context,
// and architecture; the graph is versioned + hashed with the rest of the spec.
export const DIAGRAM_KINDS = ['FLOW', 'ARCHITECTURE', 'SEQUENCE', 'STATE', 'ERD', 'CONTEXT'] as const

export const specificationDiagramNodeSchema = z.object({
  id: idString,
  label: z.string().trim().max(400).default(''),
  kind: z.string().trim().max(60).optional(),
}).passthrough()

export const specificationDiagramEdgeSchema = z.object({
  id: idString,
  source: idString,
  target: idString,
  label: z.string().trim().max(200).optional(),
}).passthrough()

export const specificationDiagramSchema = z.object({
  id: idString,
  title: z.string().trim().max(400).default(''),
  kind: z.enum(DIAGRAM_KINDS).catch('FLOW').default('FLOW'),
  description: z.string().trim().max(4000).optional(),
  nodes: z.array(specificationDiagramNodeSchema).default([]),
  edges: z.array(specificationDiagramEdgeSchema).default([]),
  source: z.string().max(20_000).optional(),
}).passthrough()

// Spec Studio — pseudo-code / reference implementations, per module, optionally linked to the
// requirements they realize. Content is markdown-with-fences so the existing MarkdownView renders
// it; `generated` marks LLM-authored modules.
export const pseudocodeModuleSchema = z.object({
  id: idString,
  title: z.string().trim().max(400).default(''),
  language: z.string().trim().max(40).default('pseudocode'),
  requirementIds: z.array(idString).default([]),
  content: z.string().max(200_000).default(''),
  generated: z.boolean().default(false),
}).passthrough()

// Analysis (the "why", before requirements) — problem, goals, stakeholders, assumptions,
// constraints. The product owner / analyst captures this upstream; requirements trace back to it.
export const specificationStakeholderSchema = z.object({
  role: z.string().trim().min(1).max(120),
  name: z.string().trim().max(200).optional(),
  interest: z.string().trim().max(600).optional(),
}).passthrough()

export const specificationAnalysisSchema = z.object({
  problem: z.string().trim().max(8000).default(''),
  goals: z.array(z.string().trim().min(1).max(600)).default([]),
  stakeholders: z.array(specificationStakeholderSchema).default([]),
  assumptions: z.array(z.string().trim().min(1).max(600)).default([]),
  constraints: z.array(z.string().trim().min(1).max(600)).default([]),
}).passthrough()

// Design decisions (ADRs) — the architect's record of what was decided and why. Diagrams +
// contracts (above) are the rest of the Design surface.
export const DECISION_STATUSES = ['PROPOSED', 'ACCEPTED', 'SUPERSEDED', 'REJECTED'] as const
export const specificationDecisionSchema = z.object({
  id: idString,
  title: z.string().trim().max(400).default(''),
  status: z.enum(DECISION_STATUSES).catch('PROPOSED').default('PROPOSED'),
  context: z.string().trim().max(4000).optional(),
  decision: z.string().trim().max(4000).default(''),
  consequences: z.string().trim().max(4000).optional(),
  alternatives: z.array(z.string().trim().min(1).max(600)).default([]),
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
  diagrams: z.array(specificationDiagramSchema).default([]),
  pseudocode: z.array(pseudocodeModuleSchema).default([]),
  analysis: specificationAnalysisSchema.default({}),
  decisions: z.array(specificationDecisionSchema).default([]),
})

export type SymbolObligation = z.infer<typeof symbolObligationSchema>
export type ContractObligation = z.infer<typeof contractObligationSchema>
export type RequirementObligation = z.infer<typeof requirementObligationSchema>
export type SpecificationContract = z.infer<typeof specificationContractSchema>
export type SpecificationRequirement = z.infer<typeof specificationRequirementSchema>
export type AcceptanceCriterion = z.infer<typeof acceptanceCriterionSchema>
export type TestObligation = z.infer<typeof testObligationSchema>
export type SpecificationDiagram = z.infer<typeof specificationDiagramSchema>
export type PseudocodeModule = z.infer<typeof pseudocodeModuleSchema>
export type SpecificationAnalysis = z.infer<typeof specificationAnalysisSchema>
export type SpecificationDecision = z.infer<typeof specificationDecisionSchema>
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
