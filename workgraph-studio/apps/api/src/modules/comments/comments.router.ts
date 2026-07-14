/**
 * Comments API — Work Item child resource (collaboration). Mounted on /api/work-items so routes are
 * /api/work-items/:workItemId/comments... Comments can anchor to a spec artifact (a requirement,
 * diagram, decision) and thread via parentId.
 */
import { Router, type Request } from 'express'
import { z } from 'zod'
import { validate } from '../../middleware/validate'
import { listComments, createComment, resolveComment, deleteComment } from './comments.service'

export const commentsRouter: Router = Router()

const createSchema = z.object({
  body: z.string().trim().min(1).max(8000),
  anchorKind: z.string().trim().max(60).optional(),
  anchorId: z.string().trim().max(200).optional(),
  parentId: z.string().uuid().optional(),
})
const resolveSchema = z.object({ resolved: z.boolean().default(true) })

const workItemIdOf = (req: Request) => String(req.params.workItemId)

commentsRouter.get('/:workItemId/comments', async (req, res, next) => {
  try {
    const anchorKind = typeof req.query.anchorKind === 'string' ? req.query.anchorKind : undefined
    const anchorId = typeof req.query.anchorId === 'string' ? req.query.anchorId : undefined
    res.json(await listComments(workItemIdOf(req), { anchorKind, anchorId }))
  } catch (err) { next(err) }
})

commentsRouter.post('/:workItemId/comments', validate(createSchema), async (req, res, next) => {
  try {
    res.status(201).json(await createComment(workItemIdOf(req), req.body, req.user!.userId))
  } catch (err) { next(err) }
})

commentsRouter.post('/:workItemId/comments/:commentId/resolve', validate(resolveSchema), async (req, res, next) => {
  try {
    res.json(await resolveComment(workItemIdOf(req), String(req.params.commentId), req.body.resolved, req.user!.userId))
  } catch (err) { next(err) }
})

commentsRouter.delete('/:workItemId/comments/:commentId', async (req, res, next) => {
  try {
    res.json(await deleteComment(workItemIdOf(req), String(req.params.commentId), req.user!.userId))
  } catch (err) { next(err) }
})
