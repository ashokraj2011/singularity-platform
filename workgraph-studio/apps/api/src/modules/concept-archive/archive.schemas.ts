import { z } from 'zod'

export const archiveAxisSchema = z.object({
  key: z.string().trim().regex(/^[a-z][a-z0-9_]{1,39}$/),
  label: z.string().trim().min(1).max(120).optional(),
  bins: z.array(z.string().trim().min(1).max(80)).min(2).max(12),
}).superRefine((axis, ctx) => {
  if (new Set(axis.bins).size !== axis.bins.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['bins'], message: 'Axis bins must be unique.' })
  }
})

export const archiveAxesSchema = z.array(archiveAxisSchema).min(2).max(3).superRefine((axes, ctx) => {
  if (new Set(axes.map(axis => axis.key)).size !== axes.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Axis keys must be unique.' })
  }
  const cells = axes.reduce((total, axis) => total * axis.bins.length, 1)
  if (cells > 216) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Archive axes may define at most 216 cells.' })
  }
})

export const conceptCardBodySchema = z.object({
  problem: z.string().trim().max(4000).optional(),
  insight: z.string().trim().max(4000).optional(),
  mechanism: z.string().trim().max(4000).optional(),
  evidence: z.array(z.string().trim().min(1).max(1000)).max(50).default([]),
  assumptions: z.array(z.string().trim().min(1).max(1000)).max(50).default([]),
  risks: z.array(z.string().trim().min(1).max(1000)).max(50).default([]),
  links: z.array(z.string().url().max(600)).max(50).default([]),
}).passthrough()

export const coordsSchema = z.record(z.string().trim().min(1).max(80))

export const fitnessSchema = z.record(z.number().finite().min(-1_000_000).max(1_000_000))

export const createArchiveSchema = z.object({
  name: z.string().trim().min(1).max(200),
  axes: archiveAxesSchema,
  fitnessConfig: z.record(z.number().finite().min(-100).max(100)).default({}),
  budgetConfig: z.object({
    maxCards: z.number().int().min(1).max(100_000).default(500),
    maxProposals: z.number().int().min(1).max(100_000).default(100),
    maxEmbeddingCalls: z.number().int().min(0).max(1_000_000).default(1000),
    maxSearchExpansions: z.number().int().min(1).max(1_000_000).default(200),
  }).default({}),
})

export const stageCardSchema = z.object({
  title: z.string().trim().min(1).max(240),
  summary: z.string().trim().min(1).max(2000),
  body: conceptCardBodySchema.default({}),
  declaredCoords: coordsSchema,
  fitness: fitnessSchema.default({}),
  authorType: z.enum(['HUMAN', 'AGENT']).default('HUMAN'),
  agentRole: z.string().trim().max(120).optional(),
  traceId: z.string().trim().max(200).optional(),
  parentCardIds: z.array(z.string().uuid()).max(20).default([]),
  operator: z.enum(['SEED', 'MUTATE', 'CROSSOVER', 'REPAIR']).default('SEED'),
  operatorNote: z.string().trim().max(1000).optional(),
  allowDuplicate: z.boolean().default(false),
})

export const confirmCoordsSchema = z.object({
  coords: coordsSchema,
  replaceExisting: z.boolean().default(false),
  note: z.string().trim().max(1000).optional(),
})

export const voteSchema = z.object({ direction: z.union([z.literal(-1), z.literal(0), z.literal(1)]) })
export const pinSchema = z.object({ note: z.string().trim().max(1000).optional() })
export const killCellSchema = z.object({ reason: z.string().trim().min(20).max(2000) })
export const promoteSchema = z.object({ promotedRef: z.record(z.unknown()).default({}), note: z.string().trim().max(1000).optional() })
export const freezeSchema = z.object({ cardIds: z.array(z.string().uuid()).min(2).max(50), note: z.string().trim().max(2000).optional() })
export const recutAxesSchema = z.object({ axes: archiveAxesSchema, note: z.string().trim().min(1).max(2000) })
export const pathfinderSchema = z.object({
  query: z.string().trim().min(2).max(2000),
  maxResults: z.number().int().min(1).max(50).default(10),
  maxExpansions: z.number().int().min(1).max(1000).optional(),
})

export const createProposalSchema = z.object({
  scopeType: z.enum(['CONCEPT_CARD', 'ARCHIVE_CELL', 'ARCHIVE']),
  scopeRef: z.record(z.unknown()),
  kind: z.enum(['CREATE', 'UPDATE', 'SWAP', 'MUTATE', 'PROMOTE']),
  payload: z.record(z.unknown()),
  baseRevision: z.number().int().positive().optional(),
  authorType: z.enum(['HUMAN', 'AGENT']).default('AGENT'),
  agentRole: z.string().trim().max(120).optional(),
  traceId: z.string().trim().max(200).optional(),
  expiresAt: z.string().datetime().optional(),
})

export type ArchiveAxis = z.infer<typeof archiveAxisSchema>
export type ArchiveAxes = z.infer<typeof archiveAxesSchema>
export type ConceptCardBody = z.infer<typeof conceptCardBodySchema>
export type StageCardInput = z.infer<typeof stageCardSchema>
