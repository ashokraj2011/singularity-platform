import { z } from 'zod'

/**
 * Implementation submission manifest (spec §6A) — what an external implementer returns to claim
 * their code satisfies the handed-off specification. The manifest is declarative evidence, not
 * trust: reconciliation (later phase) independently verifies every claim. Core fields are
 * structured; evidence/deviation detail is permissive (`.passthrough()`) so implementers can
 * attach richer proof without a schema change.
 */

export const CLAIM_STATUSES = ['IMPLEMENTED', 'PARTIAL', 'SKIPPED', 'NOT_APPLICABLE'] as const
export const EVIDENCE_REF_KINDS = ['TEST', 'FILE', 'COMMIT', 'CHECK', 'LOG', 'ARTIFACT', 'URL'] as const
export const DEVIATION_KINDS = ['SCOPE', 'APPROACH', 'BLOCKED', 'OTHER'] as const
export const SUBMISSION_SOURCES = ['GITHUB_WEBHOOK', 'MANUAL', 'API'] as const

export const evidenceRefSchema = z
  .object({
    kind: z.enum(EVIDENCE_REF_KINDS),
    ref: z.string().trim().min(1).max(2000),
    note: z.string().trim().max(2000).optional(),
  })
  .passthrough()

export const submissionClaimSchema = z.object({
  requirementId: z.string().trim().min(1),
  status: z.enum(CLAIM_STATUSES),
  evidence: z.array(evidenceRefSchema).default([]),
  notes: z.string().trim().max(4000).optional(),
})

export const submissionDeviationSchema = z
  .object({
    requirementId: z.string().trim().min(1).optional(),
    kind: z.enum(DEVIATION_KINDS),
    description: z.string().trim().min(1).max(4000),
  })
  .passthrough()

export const submissionManifestSchema = z
  .object({
    schemaVersion: z.string().trim().max(20).optional(),
    kind: z.literal('singularity.implementation-submission').optional(),
    workItemCode: z.string().trim().max(200).optional(),
    specificationVersion: z.number().int().positive().optional(),
    specificationHash: z.string().trim().min(1).max(200),
    repository: z.string().trim().min(1).max(400),
    component: z.string().trim().max(200).optional(),
    baseCommit: z.string().trim().min(7).max(64),
    headCommit: z.string().trim().min(7).max(64),
    pullRequestNumber: z.number().int().positive().optional(),
    claims: z.array(submissionClaimSchema).default([]),
    deviations: z.array(submissionDeviationSchema).default([]),
    notes: z.string().trim().max(8000).optional(),
  })
  .passthrough()

// API register body = the manifest plus how it arrived (defaults to MANUAL when a person posts it).
export const registerSubmissionSchema = submissionManifestSchema.extend({
  source: z.enum(SUBMISSION_SOURCES).default('MANUAL'),
})

export type EvidenceRef = z.infer<typeof evidenceRefSchema>
export type SubmissionClaim = z.infer<typeof submissionClaimSchema>
export type SubmissionManifest = z.infer<typeof submissionManifestSchema>
export type RegisterSubmissionInput = z.infer<typeof registerSubmissionSchema>
