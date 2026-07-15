import { Router, type Request } from 'express'
import { z } from 'zod'
import { validate } from '../../middleware/validate'
import {
  createArchive,
  createOrGetStudio,
  listStudios,
  listArchives,
  getArchive,
  stageCard,
  confirmCardCoords,
  voteCard,
  pinCard,
  killCell,
  promoteCard,
  freezeArchive,
  recutArchive,
  pathfinder,
  listProposals,
  createProposal,
  decideProposal,
  rebaseProposal,
} from './archive.service'
import { confirmCoordsSchema, createArchiveSchema, createProposalSchema, freezeSchema, killCellSchema, pathfinderSchema, pinSchema, promoteSchema, recutAxesSchema, stageCardSchema, voteSchema } from './archive.schemas'

export const conceptArchiveRouter: Router = Router()

const userId = (req: Request) => req.user!.userId
const id = (req: Request, key: string) => String(req.params[key])

conceptArchiveRouter.get('/studios', async (req, res, next) => {
  try { res.json(await listStudios(typeof req.query.projectId === 'string' ? req.query.projectId : undefined)) } catch (error) { next(error) }
})

conceptArchiveRouter.post('/studios', validate(z.object({ projectId: z.string().uuid(), name: z.string().trim().max(200).optional() })), async (req, res, next) => {
  try { res.status(201).json(await createOrGetStudio(req.body.projectId, req.body, userId(req))) } catch (error) { next(error) }
})

conceptArchiveRouter.get('/studios/:studioId/archives', async (req, res, next) => {
  try { res.json(await listArchives(id(req, 'studioId'))) } catch (error) { next(error) }
})

conceptArchiveRouter.post('/studios/:studioId/archives', validate(createArchiveSchema), async (req, res, next) => {
  try { res.status(201).json(await createArchive(id(req, 'studioId'), req.body, userId(req))) } catch (error) { next(error) }
})

conceptArchiveRouter.get('/archives/:archiveId', async (req, res, next) => {
  try { res.json(await getArchive(id(req, 'archiveId'))) } catch (error) { next(error) }
})

conceptArchiveRouter.post('/archives/:archiveId/cards', validate(stageCardSchema), async (req, res, next) => {
  try { res.status(201).json(await stageCard(id(req, 'archiveId'), req.body, userId(req))) } catch (error) { next(error) }
})

conceptArchiveRouter.post('/cards/:cardId/confirm-coords', validate(confirmCoordsSchema), async (req, res, next) => {
  try { res.json(await confirmCardCoords(id(req, 'cardId'), req.body, userId(req))) } catch (error) { next(error) }
})

conceptArchiveRouter.post('/cards/:cardId/vote', validate(voteSchema), async (req, res, next) => {
  try { res.json(await voteCard(id(req, 'cardId'), req.body.direction, userId(req))) } catch (error) { next(error) }
})

conceptArchiveRouter.post('/cards/:cardId/pin', validate(pinSchema), async (req, res, next) => {
  try { res.json(await pinCard(id(req, 'cardId'), true, userId(req), req.body.note)) } catch (error) { next(error) }
})

conceptArchiveRouter.post('/cards/:cardId/unpin', validate(pinSchema), async (req, res, next) => {
  try { res.json(await pinCard(id(req, 'cardId'), false, userId(req), req.body.note)) } catch (error) { next(error) }
})

conceptArchiveRouter.post('/cards/:cardId/promote', validate(promoteSchema), async (req, res, next) => {
  try { res.json(await promoteCard(id(req, 'cardId'), req.body.promotedRef, userId(req), req.body.note)) } catch (error) { next(error) }
})

conceptArchiveRouter.post('/archives/:archiveId/cells/kill', validate(killCellSchema.extend({ cellKey: z.string().trim().min(1).max(400) })), async (req, res, next) => {
  try { res.json(await killCell(id(req, 'archiveId'), req.body.cellKey, req.body.reason, userId(req))) } catch (error) { next(error) }
})

conceptArchiveRouter.post('/archives/:archiveId/freeze', validate(freezeSchema), async (req, res, next) => {
  try { res.json(await freezeArchive(id(req, 'archiveId'), req.body.cardIds, userId(req), req.body.note)) } catch (error) { next(error) }
})

conceptArchiveRouter.post('/archives/:archiveId/recut', validate(recutAxesSchema), async (req, res, next) => {
  try { res.json(await recutArchive(id(req, 'archiveId'), req.body, userId(req))) } catch (error) { next(error) }
})

conceptArchiveRouter.post('/archives/:archiveId/pathfinder', validate(pathfinderSchema), async (req, res, next) => {
  try { res.json(await pathfinder(id(req, 'archiveId'), req.body, userId(req))) } catch (error) { next(error) }
})

conceptArchiveRouter.get('/studios/:studioId/proposals', async (req, res, next) => {
  try { res.json(await listProposals(id(req, 'studioId'), typeof req.query.status === 'string' ? req.query.status : undefined)) } catch (error) { next(error) }
})

conceptArchiveRouter.post('/studios/:studioId/proposals', validate(createProposalSchema), async (req, res, next) => {
  try { res.status(201).json(await createProposal(id(req, 'studioId'), req.body, userId(req))) } catch (error) { next(error) }
})

conceptArchiveRouter.post('/proposals/:proposalId/accept', validate(z.object({ editedPayload: z.record(z.unknown()).optional(), note: z.string().trim().max(2000).optional() })), async (req, res, next) => {
  try { res.json(await decideProposal(id(req, 'proposalId'), 'ACCEPTED', userId(req), req.body.editedPayload, req.body.note)) } catch (error) { next(error) }
})

conceptArchiveRouter.post('/proposals/:proposalId/reject', validate(z.object({ note: z.string().trim().max(2000).optional() })), async (req, res, next) => {
  try { res.json(await decideProposal(id(req, 'proposalId'), 'REJECTED', userId(req), undefined, req.body.note)) } catch (error) { next(error) }
})

conceptArchiveRouter.post('/proposals/:proposalId/rebase', validate(z.object({ payload: z.record(z.unknown()) })), async (req, res, next) => {
  try { res.status(201).json(await rebaseProposal(id(req, 'proposalId'), req.body.payload, userId(req))) } catch (error) { next(error) }
})
