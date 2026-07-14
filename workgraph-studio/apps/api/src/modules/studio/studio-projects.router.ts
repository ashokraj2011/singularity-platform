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
