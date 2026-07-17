/**
 * Studio Projects API — mounted at /api/studio. Powers the top-level /studio front door:
 * a Portfolio of Specification Projects plus the standalone (unprojected) work items, and the
 * attach/detach that lets a solo Work Item opt into a project's shared upstream.
 */
import { Router, type Request } from 'express'
import { z } from 'zod'
import { validate } from '../../middleware/validate'
import { ValidationError } from '../../lib/errors'
import { authHeader, resolveOne } from '../lookup/resolver'
import {
  listProjects,
  getProject,
  createProject,
  updateProject,
  setProjectArchived,
  listProjectWorkItems,
  attachWorkItem,
  detachWorkItem,
  getPortfolio,
} from './studio-projects.service'
import type { CapabilityRef } from './studio-projects.service'
import {
  listCapabilityImpactAssessments,
  runCapabilityImpactAssessments,
} from './studio-impact-assessment.service'
import { getProjectSpec, patchProjectSpecSection } from './studio-spec.service'
import { getProjectReconciliation } from './studio-recon.service'
import { recordPresence, readPresence } from './studio-presence.service'
import { syncCoedit } from './studio-coedit.service'

export const studioProjectsRouter: Router = Router()

const score = z.number().int().min(1).max(5)
const projectGovernanceSchema = z.object({
  primaryCapabilityId: z.string().trim().min(1).max(200),
  impactedCapabilityIds: z.array(z.string().trim().min(1).max(200)).max(8).default([]),
  tokenBudget: z.number().int().min(10_000).max(50_000_000).default(250_000),
  costBudgetUsd: z.number().positive().max(1_000_000).optional(),
  businessValue: score.optional(),
  customerImpact: score.optional(),
  strategicAlignment: score.optional(),
  urgency: score.optional(),
  deliveryRisk: score.optional(),
  technicalRisk: score.optional(),
  regulatoryRisk: score.optional(),
  confidence: score.optional(),
  effort: score.optional(),
  targetDate: z.string().datetime().optional(),
  reviewCadenceDays: z.number().int().min(7).max(180).default(30),
  sponsorId: z.string().trim().min(1).max(200).optional(),
  productOwnerId: z.string().trim().min(1).max(200).optional(),
  successMetrics: z.array(z.string().trim().min(1).max(500)).max(12).default([]),
  tags: z.array(z.string().trim().min(1).max(60)).max(16).default([]),
})

export const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(200),
  mission: z.string().trim().max(2000).optional(),
}).merge(projectGovernanceSchema)
export const updateProjectSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  mission: z.string().trim().max(2000).nullable().optional(),
  primaryCapabilityId: z.string().trim().min(1).max(200).optional(),
  impactedCapabilityIds: z.array(z.string().trim().min(1).max(200)).max(8).optional(),
  tokenBudget: z.number().int().min(10_000).max(50_000_000).optional(),
  costBudgetUsd: z.number().positive().max(1_000_000).nullable().optional(),
  businessValue: score.nullable().optional(),
  customerImpact: score.nullable().optional(),
  strategicAlignment: score.nullable().optional(),
  urgency: score.nullable().optional(),
  deliveryRisk: score.nullable().optional(),
  technicalRisk: score.nullable().optional(),
  regulatoryRisk: score.nullable().optional(),
  confidence: score.nullable().optional(),
  effort: score.nullable().optional(),
  targetDate: z.string().datetime().nullable().optional(),
  reviewCadenceDays: z.number().int().min(7).max(180).optional(),
  lastReviewedAt: z.string().datetime().nullable().optional(),
  sponsorId: z.string().trim().min(1).max(200).nullable().optional(),
  productOwnerId: z.string().trim().min(1).max(200).nullable().optional(),
  successMetrics: z.array(z.string().trim().min(1).max(500)).max(12).optional(),
  tags: z.array(z.string().trim().min(1).max(60)).max(16).optional(),
})
export const archiveProjectSchema = z.object({ archived: z.boolean().default(true) })
export const patchProjectSpecSchema = z.object({
  section: z.enum(['analysis', 'requirements', 'decisions']),
  value: z.unknown(),
  expectedRevision: z.number().int().min(1),
})

const projectIdOf = (req: Request) => String(req.params.projectId)
const userIdOf = (req: Request) => req.user!.userId

async function resolveCapabilities(req: Request, primaryId?: string, impactedIds?: string[]) {
  const ids = [...new Set([primaryId, ...(impactedIds ?? [])].filter((id): id is string => Boolean(id)))]
  const hits = await Promise.all(ids.map((id) => resolveOne('capability', id, req)))
  const unresolved = hits.filter((hit) => !hit.exists)
  if (unresolved.length > 0) {
    const details = unresolved.map((hit) => `${hit.id}${hit.error ? ` (${hit.error})` : ''}`).join(', ')
    throw new ValidationError(`The following IAM capabilities are not available: ${details}`)
  }
  const inactive = hits.filter((hit) => {
    if (!hit.raw || typeof hit.raw !== 'object' || Array.isArray(hit.raw)) return false
    const status = String((hit.raw as Record<string, unknown>).status ?? '').trim().toUpperCase()
    return status !== '' && status !== 'ACTIVE'
  })
  if (inactive.length > 0) {
    throw new ValidationError(`Initiatives can only use ACTIVE IAM capabilities: ${inactive.map((hit) => hit.label ?? hit.id).join(', ')}`)
  }
  const byId = new Map(hits.map((hit) => [hit.id, {
    id: hit.id,
    name: hit.label?.trim() || hit.id,
  } satisfies CapabilityRef]))
  return {
    primaryCapability: primaryId ? byId.get(primaryId) : undefined,
    impactedCapabilities: impactedIds?.map((id) => byId.get(id)).filter((item): item is CapabilityRef => Boolean(item)),
  }
}

studioProjectsRouter.get('/portfolio', async (_req, res, next) => {
  try {
    res.json(await getPortfolio())
  } catch (err) { next(err) }
})

studioProjectsRouter.get('/projects', async (req, res, next) => {
  try {
    const raw = typeof req.query.status === 'string' ? req.query.status.toUpperCase() : 'ACTIVE'
    const status = raw === 'ARCHIVED' ? 'ARCHIVED' : raw === 'ALL' ? undefined : 'ACTIVE'
    res.json(await listProjects({ status }))
  } catch (err) { next(err) }
})

studioProjectsRouter.post('/projects', validate(createProjectSchema), async (req, res, next) => {
  try {
    const resolved = await resolveCapabilities(req, req.body.primaryCapabilityId, req.body.impactedCapabilityIds)
    if (!resolved.primaryCapability) throw new ValidationError('A primary capability is required')
    const { primaryCapabilityId: _primaryCapabilityId, impactedCapabilityIds: _impactedCapabilityIds, ...input } = req.body
    const project = await createProject({
      ...input,
      primaryCapability: resolved.primaryCapability,
      impactedCapabilities: resolved.impactedCapabilities,
    }, userIdOf(req))
    res.status(201).json(project)
    // Creation is fast and deterministic; capability-agent review continues in
    // the background and is visible as PENDING/RUNNING on the portfolio card.
    void runCapabilityImpactAssessments(project.id, userIdOf(req), authHeader(req)).catch(() => undefined)
  } catch (err) { next(err) }
})

studioProjectsRouter.get('/projects/:projectId', async (req, res, next) => {
  try {
    res.json(await getProject(projectIdOf(req)))
  } catch (err) { next(err) }
})

studioProjectsRouter.patch('/projects/:projectId', validate(updateProjectSchema), async (req, res, next) => {
  try {
    const shouldResolve = req.body.primaryCapabilityId !== undefined || req.body.impactedCapabilityIds !== undefined
    const resolved: Awaited<ReturnType<typeof resolveCapabilities>> = shouldResolve
      ? await resolveCapabilities(req, req.body.primaryCapabilityId, req.body.impactedCapabilityIds)
      : { primaryCapability: undefined, impactedCapabilities: undefined }
    const { primaryCapabilityId: _primaryCapabilityId, impactedCapabilityIds: _impactedCapabilityIds, ...input } = req.body
    res.json(await updateProject(projectIdOf(req), {
      ...input,
      ...(resolved.primaryCapability ? { primaryCapability: resolved.primaryCapability } : {}),
      ...(req.body.impactedCapabilityIds !== undefined ? { impactedCapabilities: resolved.impactedCapabilities ?? [] } : {}),
    }, userIdOf(req)))
  } catch (err) { next(err) }
})

studioProjectsRouter.get('/projects/:projectId/impact-assessments', async (req, res, next) => {
  try {
    res.json(await listCapabilityImpactAssessments(projectIdOf(req)))
  } catch (err) { next(err) }
})

studioProjectsRouter.post('/projects/:projectId/impact-assessments/run', async (req, res, next) => {
  try {
    res.status(202).json(await runCapabilityImpactAssessments(
      projectIdOf(req),
      userIdOf(req),
      authHeader(req),
    ))
  } catch (err) { next(err) }
})

studioProjectsRouter.post('/projects/:projectId/review', async (req, res, next) => {
  try {
    res.json(await updateProject(projectIdOf(req), { lastReviewedAt: new Date().toISOString() }, userIdOf(req)))
  } catch (err) { next(err) }
})

studioProjectsRouter.post('/projects/:projectId/archive', validate(archiveProjectSchema), async (req, res, next) => {
  try {
    res.json(await setProjectArchived(projectIdOf(req), req.body.archived, userIdOf(req)))
  } catch (err) { next(err) }
})

studioProjectsRouter.get('/projects/:projectId/work-items', async (req, res, next) => {
  try {
    res.json(await listProjectWorkItems(projectIdOf(req)))
  } catch (err) { next(err) }
})

studioProjectsRouter.post('/projects/:projectId/work-items/:workItemId', async (req, res, next) => {
  try {
    res.status(201).json(await attachWorkItem(projectIdOf(req), String(req.params.workItemId), userIdOf(req)))
  } catch (err) { next(err) }
})

studioProjectsRouter.delete('/projects/:projectId/work-items/:workItemId', async (req, res, next) => {
  try {
    res.json(await detachWorkItem(projectIdOf(req), String(req.params.workItemId), userIdOf(req)))
  } catch (err) { next(err) }
})

// The project's shared upstream (analysis + design). Get-or-create on read; section patch on write.
studioProjectsRouter.get('/projects/:projectId/specification', async (req, res, next) => {
  try {
    res.json(await getProjectSpec(projectIdOf(req)))
  } catch (err) { next(err) }
})

studioProjectsRouter.patch('/projects/:projectId/specification', validate(patchProjectSpecSchema), async (req, res, next) => {
  try {
    res.json(await patchProjectSpecSection(projectIdOf(req), req.body, userIdOf(req)))
  } catch (err) { next(err) }
})

// Project-level reconciliation roll-up — latest run per work item + a project total (read-only).
studioProjectsRouter.get('/projects/:projectId/reconciliation', async (req, res, next) => {
  try {
    res.json(await getProjectReconciliation(projectIdOf(req)))
  } catch (err) { next(err) }
})

// Presence — the live "who's here" layer. A heartbeat records the caller and returns the live set.
const heartbeatSchema = z.object({ surface: z.string().trim().max(60).optional() })

studioProjectsRouter.post('/projects/:projectId/presence', validate(heartbeatSchema), async (req, res, next) => {
  try {
    res.json(await recordPresence(projectIdOf(req), { userId: req.user!.userId, displayName: req.user!.displayName, surface: req.body.surface }))
  } catch (err) { next(err) }
})

studioProjectsRouter.get('/projects/:projectId/presence', async (req, res, next) => {
  try {
    res.json(await readPresence(projectIdOf(req)))
  } catch (err) { next(err) }
})

// Live co-edit relay — append the caller's opaque Yjs updates, return the ones it hasn't seen.
const coeditSchema = z.object({
  docKey: z.string().trim().min(1).max(120),
  updates: z.array(z.string().max(200_000)).max(200).default([]),
  sinceSeq: z.number().int().min(0).default(0),
})

studioProjectsRouter.post('/projects/:projectId/coedit', validate(coeditSchema), async (req, res, next) => {
  try {
    res.json(await syncCoedit(projectIdOf(req), req.body))
  } catch (err) { next(err) }
})
