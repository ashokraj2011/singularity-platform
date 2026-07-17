/**
 * Project-specification schemas — the shape of a Specification Project's shared upstream. Two
 * sections for now: `analysis` (problem framing) and `decisions` (architecture decisions / ADRs),
 * mirroring the studio walkthrough's Analysis and Design surfaces. Stored as JSON on
 * ProjectSpecification.package and validated on every write.
 */
import { z } from 'zod'

export const projectGoalSchema = z.object({
  text: z.string().trim().min(1).max(400),
  metric: z.string().trim().max(200).optional(),
})

export const projectStakeholderSchema = z.object({
  name: z.string().trim().min(1).max(120),
  role: z.string().trim().max(120).optional(),
  concern: z.string().trim().max(400).optional(),
})

export const projectAnalysisSchema = z.object({
  problem: z.string().trim().max(4000).default(''),
  goals: z.array(projectGoalSchema).max(50).default([]),
  stakeholders: z.array(projectStakeholderSchema).max(50).default([]),
  assumptions: z.array(z.string().trim().min(1).max(600)).max(50).default([]),
  constraints: z.array(z.string().trim().min(1).max(600)).max(50).default([]),
})

export const projectDecisionStatus = z.enum(['PROPOSED', 'ACCEPTED', 'SUPERSEDED', 'REJECTED'])

export const projectDecisionSchema = z.object({
  id: z.string().trim().min(1).max(60),
  title: z.string().trim().min(1).max(300),
  status: projectDecisionStatus.default('PROPOSED'),
  context: z.string().trim().max(4000).optional(),
  decision: z.string().trim().max(4000).default(''),
  consequences: z.string().trim().max(4000).optional(),
  claimRefs: z.array(z.string().uuid()).default([]),
  optionRefs: z.array(z.string().uuid()).default([]),
  resolvesTensions: z.array(z.string().trim().min(1).max(600)).default([]),
})

export const projectRequirementPriority = z.enum(['MUST', 'SHOULD', 'MAY'])

export const projectRequirementSchema = z.object({
  id: z.string().trim().min(1).max(60),
  statement: z.string().trim().min(1).max(2000),
  priority: projectRequirementPriority.default('SHOULD'),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(1000)).max(50).default([]),
  rationale: z.string().trim().max(2000).optional(),
  claimRefs: z.array(z.string().uuid()).default([]),
  decisionRefs: z.array(z.string().uuid()).default([]),
})

/** The full project-spec package. Every section has a default so an empty `{}` parses cleanly. */
export const projectSpecPackageSchema = z.object({
  analysis: projectAnalysisSchema.default({}),
  requirements: z.array(projectRequirementSchema).max(300).default([]),
  decisions: z.array(projectDecisionSchema).max(200).default([]),
})

export type ProjectSpecPackage = z.infer<typeof projectSpecPackageSchema>

/** Editable sections and the schema each PATCH value must satisfy. */
export const projectSpecSectionSchemas = {
  analysis: projectAnalysisSchema,
  requirements: z.array(projectRequirementSchema).max(300),
  decisions: z.array(projectDecisionSchema).max(200),
} as const

export type ProjectSpecSection = keyof typeof projectSpecSectionSchemas
