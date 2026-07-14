/**
 * Studio Projects API — mounted at /api/studio. Powers the top-level /studio front door:
 * a Portfolio of Specification Projects plus the standalone (unprojected) work items, and the
 * attach/detach that lets a solo Work Item opt into a project's shared upstream.
 */
import { Router, type Request } from 'express'
import { z } from 'zod'
import { validate } from '../../middleware/validate'
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
import { getProjectSpec, patchProjectSpecSection } from './studio-spec.service'
import { getProjectReconciliation } from './studio-recon.service'
import { recordPresence, readPresence } from './studio-presence.service'
import { syncCoedit } from './studio-coedit.service'

export const studioProjectsRouter: Router = Router()

export const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(200),
  mission: z.string().trim().max(2000).optional(),
})
export const updateProjectSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  mission: z.string().trim().max(2000).nullable().optional(),
})
export const archiveProjectSchema = z.object({ archived: z.boolean().default(true) })
export const patchProjectSpecSchema = z.object({
  section: z.enum(['analysis', 'requirements', 'decisions']),
  value: z.unknown(),
  expectedRevision: z.number().int().min(1),
})

const projectIdOf = (req: Request) => String(req.params.projectId)
const userIdOf = (req: Request) => req.user!.userId

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
    res.status(201).json(await createProject(req.body, userIdOf(req)))
  } catch (err) { next(err) }
})

studioProjectsRouter.get('/projects/:projectId', async (req, res, next) => {
  try {
    res.json(await getProject(projectIdOf(req)))
  } catch (err) { next(err) }
})

studioProjectsRouter.patch('/projects/:projectId', validate(updateProjectSchema), async (req, res, next) => {
  try {
    res.json(await updateProject(projectIdOf(req), req.body, userIdOf(req)))
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
