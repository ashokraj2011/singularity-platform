/**
 * M42.5 — Zod schema for the enhancement spec (kind: code_enhancement).
 *
 * Mirrors deterministic_code_layer_spec_v2.md §25.3. Validated by the
 * same /api/codegen/spec/validate route as greenfield specs once
 * mounted via a discriminated union; for M42.5 we expose it as its own
 * route under /api/codegen/enhancements so the brownfield code path is
 * cleanly separable.
 */
import { z } from 'zod'

const stringId = z.string().min(1).max(120).regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/)
const fieldType = z.enum([
  'string', 'integer', 'long', 'number', 'double',
  'boolean', 'datetime', 'date', 'uuid',
])

export const enhancementSpecSchema = z.object({
  specVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  kind: z.literal('code_enhancement'),
  metadata: z.object({
    workItemId: z.string().optional(),
    title: z.string().max(200).optional(),
    ownerTeam: z.string().optional(),
    capability: z.string().optional(),
  }).strict(),
  repo: z.object({
    url: z.string().optional(),
    path: z.string().optional(),
    branch: z.string().optional(),
    baseBranch: z.string().optional(),
  }).strict(),
  application: z.object({
    language: z.enum(['java', 'python', 'typescript']),
    framework: z.enum(['spring-boot', 'fastapi', 'express']),
    buildTool: z.enum(['maven', 'gradle', 'poetry', 'pip', 'npm']).optional(),
  }).strict(),
  enhancement: z.object({
    // V1 supports only ADD_RESPONSE_FIELD; the registry rejects others.
    type: z.enum(['ADD_RESPONSE_FIELD']),
    targetEndpoint: stringId,
    targetModel: stringId,
  }).strict(),
  field: z.object({
    name: stringId,
    type: fieldType,
    required: z.boolean().optional().default(false),
  }).strict(),
  mapping: z.object({
    source: z.string().optional(),
    rules: z.array(z.object({
      when: z.string().min(1),
      value: z.string().min(1),
    }).strict()).optional().default([]),
  }).strict().optional(),
  update: z.object({
    dto: z.boolean().optional().default(true),
    openapi: z.boolean().optional().default(true),
    serviceMapping: z.boolean().optional().default(true),
    tests: z.boolean().optional().default(true),
    audit: z.boolean().optional().default(false),
  }).strict().optional(),
  llm: z.object({
    allowed: z.boolean().optional().default(true),
    allowedTasks: z.array(z.string()).optional().default([]),
    forbiddenChanges: z.array(z.string()).optional().default([]),
  }).strict().optional(),
}).strict()

export type ZEnhancementSpec = z.infer<typeof enhancementSpecSchema>
