/**
 * Studio Board API — mounted at /api/studio (same front door as projects/rooms).
 * PR-1 exposes the event-sourcing backbone: create/list boards, append an event
 * (server allocates the fenced seq + coalesces), and the time-travel read path
 * (state at a cursor + replay stream). Moments / fork / diff / merge / ingestion /
 * verdicts arrive in later PRs.
 */
import { Router, type Request } from 'express'
import { z } from 'zod'
import multer from 'multer'
import path from 'node:path'
import { validate } from '../../middleware/validate'
import { createBoard, listBoards, appendEvent, readState, listEvents, forkBranch, listBranches, abandonBranch } from './board.service'
import { detectAndNarrate, listMoments, editMoment, rejectMoment } from './board-moments.service'
import { ingest, listArtifacts, getArtifactClaims, acceptExtractedClaim, rejectExtractedClaim, markArtifactReviewed, MAX_INGEST_BYTES } from './board-ingestion.service'
import { diffBranches, mergeBranch, applyMergeItems, completeMerge } from './board-merge.service'
import { synthesizeBoardObjects } from './board-synthesis'

export const studioBoardRouter: Router = Router()

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_INGEST_BYTES } })
const UPLOAD_KIND_BY_EXTENSION: Record<string, string> = {
  '.txt': 'TEXT',
  '.md': 'MARKDOWN',
  '.markdown': 'MARKDOWN',
  '.pdf': 'PDF',
  '.docx': 'DOCX',
  '.pptx': 'PPTX',
  '.xlsx': 'XLSX',
}

function uploadKind(filename: string): string | null {
  return UPLOAD_KIND_BY_EXTENSION[path.extname(filename).toLowerCase()] ?? null
}

function uploadFilename(filename: string): string {
  const safe = path.basename(filename).replace(/[^a-zA-Z0-9._ -]/g, '_').trim()
  return (safe || 'uploaded-source').slice(0, 300)
}

function uploadMiddleware(req: Request, res: import('express').Response, next: import('express').NextFunction) {
  upload.single('file')(req, res, (error: unknown) => {
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ code: 'PAYLOAD_TOO_LARGE', message: 'Source file exceeds the 500 KB ingestion limit.' })
      return
    }
    if (error) { next(error); return }
    next()
  })
}

const createBoardSchema = z.object({
  name: z.string().trim().min(1).max(200),
})
const appendEventSchema = z.object({
  branch: z.string().trim().min(1).max(120).default('main'),
  eventType: z.string().trim().min(1).max(64),
  objectIds: z.array(z.string().max(200)).max(500).default([]),
  payload: z.record(z.unknown()).default({}),
  causedBy: z.array(z.unknown()).max(50).default([]),
  coalesceKey: z.string().trim().max(200).nullable().optional(),
  agentRole: z.string().trim().max(64).nullable().optional(),
  expectedHeadSeq: z.number().int().min(0).optional(),
})

const forkSchema = z.object({
  name: z.string().trim().min(1).max(120),
  fromBranch: z.string().trim().min(1).max(120).default('main'),
  atEventSeq: z.number().int().min(0).optional(),
  atMomentId: z.string().uuid().optional(),
  mode: z.enum(['HUMAN', 'AGENT_EXPLORATION']).default('HUMAN'),
  purpose: z.string().trim().max(500).optional(),
  maxEvents: z.number().int().min(1).max(100_000).optional(),
  maxTurns: z.number().int().min(1).max(10_000).optional(),
})
const ingestSchema = z.object({
  branch: z.string().trim().min(1).max(120).default('main'),
  kind: z.string().trim().min(1).max(24),
  filename: z.string().trim().min(1).max(300),
  content: z.string().max(500_000).optional(),
  url: z.string().url().max(2000).optional(),
  storageRef: z.string().max(500).optional(),
}).superRefine((value, ctx) => {
  const sources = [value.content !== undefined, value.url !== undefined, value.storageRef !== undefined].filter(Boolean).length
  if (sources !== 1) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Provide exactly one ingestion source: content, url, or storageRef.', path: ['content'] })
})
const synthesizeSchema = z.object({
  objectIds: z.array(z.string().trim().min(1).max(200)).max(500).optional(),
  maxThemes: z.number().int().min(1).max(12).default(6),
  includeTensions: z.boolean().default(true),
  includeOpportunities: z.boolean().default(true),
})

const mergeSchema = z.object({
  fromBranch: z.string().trim().min(1).max(120),
  toBranch: z.string().trim().min(1).max(120).default('main'),
})
const mergeApplySchema = mergeSchema.extend({ objectIds: z.array(z.string().max(200)).min(1).max(1000) })
const mergeCompleteSchema = z.object({ fromBranch: z.string().trim().min(1).max(120) })

const detectMomentsSchema = z.object({
  branch: z.string().trim().min(1).max(120).default('main'),
  burstMinCount: z.number().int().min(2).max(100).optional(),
  stallFactor: z.number().min(1).max(20).optional(),
})
const editMomentSchema = z.object({
  title: z.string().trim().min(1).max(80).optional(),
  narrative: z.string().trim().min(1).max(1200).optional(),
})

const projectIdOf = (req: Request) => String(req.params.projectId)
const boardIdOf = (req: Request) => String(req.params.boardId)
const userIdOf = (req: Request) => req.user!.userId
const branchOf = (req: Request) => (typeof req.query.branch === 'string' && req.query.branch ? req.query.branch : 'main')

studioBoardRouter.post('/projects/:projectId/boards', validate(createBoardSchema), async (req, res, next) => {
  try {
    res.status(201).json(await createBoard(projectIdOf(req), req.body.name, userIdOf(req)))
  } catch (err) { next(err) }
})

studioBoardRouter.get('/projects/:projectId/boards', async (req, res, next) => {
  try {
    res.json(await listBoards(projectIdOf(req)))
  } catch (err) { next(err) }
})

studioBoardRouter.post('/boards/:boardId/events', validate(appendEventSchema), async (req, res, next) => {
  try {
    const { branch, ...input } = req.body
    res.status(201).json(await appendEvent(boardIdOf(req), branch, input, { actorType: 'HUMAN', actorId: userIdOf(req), agentRole: input.agentRole ?? null }))
  } catch (err) { next(err) }
})

studioBoardRouter.get('/boards/:boardId/state', async (req, res, next) => {
  try {
    const at = typeof req.query.at === 'string' ? req.query.at : undefined
    res.json(await readState(boardIdOf(req), branchOf(req), at))
  } catch (err) { next(err) }
})

studioBoardRouter.get('/boards/:boardId/events', async (req, res, next) => {
  try {
    const from = typeof req.query.from === 'string' && req.query.from !== '' ? Number(req.query.from) : undefined
    const to = typeof req.query.to === 'string' && req.query.to !== '' ? Number(req.query.to) : undefined
    res.json(await listEvents(boardIdOf(req), branchOf(req), from, to))
  } catch (err) { next(err) }
})

studioBoardRouter.post('/boards/:boardId/synthesize', validate(synthesizeSchema), async (req, res, next) => {
  try {
    const state = await readState(boardIdOf(req), branchOf(req))
    res.json(synthesizeBoardObjects(state.objects, req.body))
  } catch (err) { next(err) }
})

// ── Branches / fork (PR-3) ────────────────────────────────────────────────────
studioBoardRouter.get('/boards/:boardId/branches', async (req, res, next) => {
  try {
    res.json(await listBranches(boardIdOf(req)))
  } catch (err) { next(err) }
})

studioBoardRouter.post('/boards/:boardId/fork', validate(forkSchema), async (req, res, next) => {
  try {
    res.status(201).json(await forkBranch(boardIdOf(req), req.body, userIdOf(req)))
  } catch (err) { next(err) }
})

studioBoardRouter.post('/boards/:boardId/branches/:name/abandon', async (req, res, next) => {
  try {
    res.json(await abandonBranch(boardIdOf(req), String(req.params.name), userIdOf(req)))
  } catch (err) { next(err) }
})

// ── Ingestion (PR-4) ──────────────────────────────────────────────────────────
const artifactIdOf = (req: Request) => String(req.params.artifactId)
const claimIdOf = (req: Request) => String(req.params.claimId)

studioBoardRouter.post('/boards/:boardId/ingest', validate(ingestSchema), async (req, res, next) => {
  try {
    const { branch, ...input } = req.body
    res.status(201).json(await ingest(boardIdOf(req), branch, input, { actorId: userIdOf(req) }))
  } catch (err) { next(err) }
})

studioBoardRouter.post('/boards/:boardId/ingest-file', uploadMiddleware, async (req, res, next) => {
  try {
    const file = req.file
    if (!file) {
      res.status(400).json({ code: 'BAD_REQUEST', message: 'No file uploaded (expected multipart field "file").' })
      return
    }
    const kind = uploadKind(file.originalname)
    if (!kind) {
      res.status(400).json({ code: 'UNSUPPORTED_FILE_TYPE', message: 'Supported source files are .txt, .md, .pdf, .docx, .pptx, and .xlsx.' })
      return
    }
    const branch = typeof req.body?.branch === 'string' && req.body.branch.trim() ? req.body.branch.trim() : 'main'
    res.status(201).json(await ingest(boardIdOf(req), branch, {
      kind,
      filename: uploadFilename(file.originalname),
      content: file.buffer,
    }, { actorId: userIdOf(req) }))
  } catch (err) { next(err) }
})

studioBoardRouter.get('/boards/:boardId/artifacts', async (req, res, next) => {
  try {
    res.json(await listArtifacts(boardIdOf(req)))
  } catch (err) { next(err) }
})

studioBoardRouter.get('/boards/:boardId/artifacts/:artifactId/claims', async (req, res, next) => {
  try {
    res.json(await getArtifactClaims(boardIdOf(req), artifactIdOf(req)))
  } catch (err) { next(err) }
})

studioBoardRouter.post('/boards/:boardId/artifacts/:artifactId/claims/:claimId/accept', async (req, res, next) => {
  try {
    res.json(await acceptExtractedClaim(boardIdOf(req), artifactIdOf(req), claimIdOf(req), userIdOf(req)))
  } catch (err) { next(err) }
})

studioBoardRouter.post('/boards/:boardId/artifacts/:artifactId/claims/:claimId/reject', async (req, res, next) => {
  try {
    res.json(await rejectExtractedClaim(boardIdOf(req), artifactIdOf(req), claimIdOf(req), userIdOf(req)))
  } catch (err) { next(err) }
})

studioBoardRouter.post('/boards/:boardId/artifacts/:artifactId/review', async (req, res, next) => {
  try {
    res.json(await markArtifactReviewed(boardIdOf(req), artifactIdOf(req), userIdOf(req)))
  } catch (err) { next(err) }
})

// ── Moments (PR-2) ────────────────────────────────────────────────────────────
const momentIdOf = (req: Request) => String(req.params.momentId)

// Run the deterministic detectors over new events, then narrate each via the
// Chronicler. In production this would be triggered from the append path / a
// background sweep; the endpoint makes it drivable and testable.
studioBoardRouter.post('/boards/:boardId/moments/detect', validate(detectMomentsSchema), async (req, res, next) => {
  try {
    const { branch, burstMinCount, stallFactor } = req.body
    res.status(201).json(await detectAndNarrate(boardIdOf(req), branch, userIdOf(req), undefined, { burstMinCount, stallFactor }))
  } catch (err) { next(err) }
})

studioBoardRouter.get('/boards/:boardId/moments', async (req, res, next) => {
  try {
    res.json(await listMoments(boardIdOf(req), branchOf(req)))
  } catch (err) { next(err) }
})

studioBoardRouter.post('/boards/:boardId/moments/:momentId/edit', validate(editMomentSchema), async (req, res, next) => {
  try {
    res.json(await editMoment(boardIdOf(req), momentIdOf(req), req.body, userIdOf(req)))
  } catch (err) { next(err) }
})

studioBoardRouter.post('/boards/:boardId/moments/:momentId/reject', async (req, res, next) => {
  try {
    res.json(await rejectMoment(boardIdOf(req), momentIdOf(req), userIdOf(req)))
  } catch (err) { next(err) }
})

// ── Merge (PR-6): semantic diff → proposal batch ──────────────────────────────
studioBoardRouter.get('/boards/:boardId/diff', async (req, res, next) => {
  try {
    const from = typeof req.query.from === 'string' && req.query.from ? req.query.from : 'main'
    const to = typeof req.query.to === 'string' && req.query.to ? req.query.to : 'main'
    res.json(await diffBranches(boardIdOf(req), from, to))
  } catch (err) { next(err) }
})

studioBoardRouter.post('/boards/:boardId/merge', validate(mergeSchema), async (req, res, next) => {
  try {
    res.json(await mergeBranch(boardIdOf(req), req.body.fromBranch, req.body.toBranch, userIdOf(req)))
  } catch (err) { next(err) }
})

studioBoardRouter.post('/boards/:boardId/merge/apply', validate(mergeApplySchema), async (req, res, next) => {
  try {
    res.json(await applyMergeItems(boardIdOf(req), req.body.fromBranch, req.body.objectIds, req.body.toBranch, userIdOf(req)))
  } catch (err) { next(err) }
})

studioBoardRouter.post('/boards/:boardId/merge/complete', validate(mergeCompleteSchema), async (req, res, next) => {
  try {
    res.json(await completeMerge(boardIdOf(req), req.body.fromBranch, userIdOf(req)))
  } catch (err) { next(err) }
})
