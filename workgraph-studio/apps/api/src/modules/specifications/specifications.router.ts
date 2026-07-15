/**
 * Specification API — Work Item child resource. Mounted on /api/work-items so its routes are
 * /api/work-items/:workItemId/specifications... The Work Item stays the root; specification
 * VERSIONS are child records (spec §11). Kept in its own router (not work-items.router.ts).
 */
import { Router, type Request } from 'express'
import { z } from 'zod'
import { validate } from '../../middleware/validate'
import { specificationPackageBodySchema } from './specification.schemas'
import {
  listSpecificationVersions,
  getSpecificationVersion,
  createSpecificationDraft,
  updateSpecificationDraft,
  validateSpecificationVersion,
  approveSpecificationVersion,
  getInheritedProjectSpec,
} from './specifications.service'
import { generateSpecificationDraft } from './spec-generation.service'
import { generatePseudocode } from './pseudocode-generation.service'
import { converseSpecAgent, applySpecProposal } from './spec-agent.service'

export const specificationsRouter: Router = Router()

const createDraftSchema = z.object({
  basedOnVersionId: z.string().uuid().optional(),
  sourceIds: z.array(z.string().trim().min(1)).optional(),
})

// LLM authoring: a prompt (+ optional attached documents) → a generated DRAFT specification.
const generateSchema = z.object({
  prompt: z.string().trim().min(1).max(20000),
  documents: z.array(z.object({ title: z.string().trim().max(400).optional(), content: z.string().max(200000) })).max(12).optional(),
  basedOnVersionId: z.string().uuid().optional(),
})

// Optimistic-concurrency edit: expectedRevision + any subset of the package body sections.
const updateSchema = specificationPackageBodySchema.partial().extend({
  expectedRevision: z.number().int().min(1),
})

const approveSchema = z.object({ comment: z.string().trim().max(4000).optional() })

// Spec Studio: generate a pseudo-code module for a draft (optionally scoped to some requirements).
const generatePseudocodeSchema = z.object({
  requirementIds: z.array(z.string().trim().min(1)).optional(),
  language: z.string().trim().max(40).optional(),
  title: z.string().trim().max(400).optional(),
  instructions: z.string().trim().max(8000).optional(),
})

// Agent Storm — conversational spec authoring + one-click proposal apply.
const converseSchema = z.object({
  messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(8000) })).min(1).max(40),
  versionId: z.string().uuid().optional(),
})
const applyProposalSchema = z.object({
  proposal: z.object({ kind: z.enum(['requirement', 'acceptance', 'test']), data: z.record(z.string(), z.unknown()), label: z.string().trim().max(400).optional() }),
})

const workItemIdOf = (req: Request) => String(req.params.workItemId)
const versionIdOf = (req: Request) => String(req.params.versionId)

specificationsRouter.get('/:workItemId/specifications', async (req, res, next) => {
  try {
    res.json(await listSpecificationVersions(workItemIdOf(req)))
  } catch (err) { next(err) }
})

// Inheritance: the parent Specification Project's shared baseline (analysis/requirements/decisions),
// surfaced read-only so the item IDE can render it as "inherited from project". null when standalone.
specificationsRouter.get('/:workItemId/inherited-spec', async (req, res, next) => {
  try {
    res.json(await getInheritedProjectSpec(workItemIdOf(req)))
  } catch (err) { next(err) }
})

specificationsRouter.post('/:workItemId/specifications', validate(createDraftSchema), async (req, res, next) => {
  try {
    res.status(201).json(await createSpecificationDraft(workItemIdOf(req), req.body, req.user!.userId))
  } catch (err) { next(err) }
})

// LLM authoring — generate a DRAFT specification from a prompt + optional documents.
specificationsRouter.post('/:workItemId/specifications/generate', validate(generateSchema), async (req, res, next) => {
  try {
    res.status(201).json(await generateSpecificationDraft(workItemIdOf(req), req.body, req.user!.userId))
  } catch (err) { next(err) }
})

// Spec Studio — generate a pseudo-code module and append it to a draft version.
specificationsRouter.post('/:workItemId/specifications/:versionId/pseudocode/generate', validate(generatePseudocodeSchema), async (req, res, next) => {
  try {
    res.status(201).json(await generatePseudocode(workItemIdOf(req), versionIdOf(req), req.body, req.user!.userId))
  } catch (err) { next(err) }
})

// Agent Storm — converse about the spec; returns a reply + applyable proposals.
specificationsRouter.post('/:workItemId/spec-agent/converse', validate(converseSchema), async (req, res, next) => {
  try {
    res.json(await converseSpecAgent(workItemIdOf(req), req.body, req.user!.userId))
  } catch (err) { next(err) }
})

// Agent Storm — apply a proposal (requirement / acceptance / test) to a draft version.
specificationsRouter.post('/:workItemId/specifications/:versionId/apply', validate(applyProposalSchema), async (req, res, next) => {
  try {
    res.json(await applySpecProposal(workItemIdOf(req), versionIdOf(req), req.body.proposal, req.user!.userId))
  } catch (err) { next(err) }
})

specificationsRouter.get('/:workItemId/specifications/:versionId', async (req, res, next) => {
  try {
    res.json(await getSpecificationVersion(workItemIdOf(req), versionIdOf(req)))
  } catch (err) { next(err) }
})

specificationsRouter.patch('/:workItemId/specifications/:versionId', validate(updateSchema), async (req, res, next) => {
  try {
    const { expectedRevision, ...body } = req.body as z.infer<typeof updateSchema>
    res.json(await updateSpecificationDraft(workItemIdOf(req), versionIdOf(req), { expectedRevision, body }, req.user!.userId))
  } catch (err) { next(err) }
})

specificationsRouter.post('/:workItemId/specifications/:versionId/validate', async (req, res, next) => {
  try {
    res.json(await validateSpecificationVersion(workItemIdOf(req), versionIdOf(req)))
  } catch (err) { next(err) }
})

specificationsRouter.post('/:workItemId/specifications/:versionId/approve', validate(approveSchema), async (req, res, next) => {
  try {
    res.status(200).json(await approveSpecificationVersion(workItemIdOf(req), versionIdOf(req), req.body, req.user!.userId))
  } catch (err) { next(err) }
})
