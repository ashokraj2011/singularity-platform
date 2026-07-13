import { z } from 'zod'

/**
 * Developer handoff config (spec §5). Takes an APPROVED specification version and makes it
 * developer-ready: which repo/base commit to build against, which requirements are in scope,
 * and what evidence reconciliation will require. One target per Work Item (single-repo for now).
 */

export const EVIDENCE_KINDS = ['TEST', 'FILE', 'COMMIT', 'CHECK', 'ARTIFACT', 'DOC'] as const

export const requiredEvidenceSchema = z
  .object({
    requirementId: z.string().trim().min(1),
    kind: z.enum(EVIDENCE_KINDS),
    description: z.string().trim().max(2000).optional(),
  })
  .passthrough()

// The reconciliation policy is intentionally open — it configures later phases (thresholds,
// which checks are mandatory) and evolves independently of this handoff shape.
export const reconciliationPolicySchema = z.record(z.string(), z.unknown())

export const putDevelopmentTargetSchema = z.object({
  // Optional: defaults to the Work Item's active (highest APPROVED) specification version.
  specificationVersionId: z.string().uuid().optional(),
  repository: z.string().trim().min(1).max(400),
  component: z.string().trim().max(200).optional(),
  baseBranch: z.string().trim().min(1).max(200),
  baseCommitSha: z.string().trim().min(7).max(64),
  // Empty ⇒ every requirement in the approved spec is in scope.
  requirementIds: z.array(z.string().trim().min(1)).default([]),
  requiredEvidence: z.array(requiredEvidenceSchema).default([]),
  forbiddenPaths: z.array(z.string().trim().min(1)).default([]),
  reconciliationPolicy: reconciliationPolicySchema.default({}),
  dueAt: z.string().datetime().optional(),
})

export type PutDevelopmentTargetInput = z.infer<typeof putDevelopmentTargetSchema>
