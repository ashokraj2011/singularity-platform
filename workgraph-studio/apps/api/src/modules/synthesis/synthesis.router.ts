/**
 * Synthesis Studio API (R1A Foundations) — mounted at /api/synthesis behind
 * authMiddleware + studioAuthz. Persistent Working Sessions: workspaces, linear threads,
 * and fenced messages. Documents, context references, proposals, and agents land in
 * later phases on top of this backbone.
 */
import { Router, type Request, type Response, type NextFunction } from 'express'
import { z } from 'zod'
import { validate } from '../../middleware/validate'
import { createWorkspace, getWorkspace, listWorkspaces, createThread, listThreads } from './workspace.service'
import { appendMessage, listMessages } from './message.service'
import { addContextRef, listContextRefs, removeContextRef } from './context-reference.service'
import { buildManifest, getManifest } from './context-manifest.service'

export const synthesisRouter: Router = Router()

const userIdOf = (req: Request) => req.user!.userId
const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => { void fn(req, res).catch(next) }

const createWorkspaceSchema = z.object({
  specificationProjectId: z.string().trim().min(1),
  workItemId: z.string().trim().min(1).nullable().optional(),
  title: z.string().trim().min(1).max(300),
  purpose: z.string().trim().max(2000).optional(),
})
const createThreadSchema = z.object({
  kind: z.enum(['WORKING_SESSION', 'ASK_SIDECAR']).optional(),
  agentRole: z.string().trim().max(100).optional(),
  title: z.string().trim().max(300).optional(),
  contextScope: z.record(z.unknown()).optional(),
})
const appendMessageSchema = z.object({
  role: z.enum(['USER', 'ASSISTANT', 'SYSTEM']),
  authorType: z.enum(['HUMAN', 'AGENT', 'SYSTEM']),
  authorId: z.string().trim().min(1).nullable().optional(),
  agentRole: z.string().trim().max(100).nullable().optional(),
  content: z.record(z.unknown()).default({}),
  contextManifestId: z.string().trim().min(1).nullable().optional(),
  proposalId: z.string().trim().min(1).nullable().optional(),
  correlation: z.record(z.unknown()).optional(),
  tokens: z.record(z.unknown()).optional(),
  receipts: z.array(z.unknown()).optional(),
  coalesceKey: z.string().trim().min(1).max(200).optional(),
  expectedHeadSeq: z.number().int().min(0).optional(),
})

// ── Workspaces ────────────────────────────────────────────────────────────────
synthesisRouter.post('/workspaces', validate(createWorkspaceSchema), wrap(async (req, res) => {
  res.status(201).json(await createWorkspace(req.body, userIdOf(req)))
}))
synthesisRouter.get('/workspaces', wrap(async (req, res) => {
  const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : ''
  if (!projectId) { res.status(400).json({ code: 'BAD_REQUEST', message: 'projectId query param is required' }); return }
  res.json(await listWorkspaces(projectId))
}))
synthesisRouter.get('/workspaces/:workspaceId', wrap(async (req, res) => {
  res.json(await getWorkspace(String(req.params.workspaceId)))
}))

// ── Threads ───────────────────────────────────────────────────────────────────
synthesisRouter.post('/workspaces/:workspaceId/threads', validate(createThreadSchema), wrap(async (req, res) => {
  res.status(201).json(await createThread(String(req.params.workspaceId), req.body, userIdOf(req)))
}))
synthesisRouter.get('/workspaces/:workspaceId/threads', wrap(async (req, res) => {
  res.json(await listThreads(String(req.params.workspaceId)))
}))

// ── Messages (fenced append) ────────────────────────────────────────────────────
synthesisRouter.post('/workspaces/:workspaceId/threads/:threadId/messages', validate(appendMessageSchema), wrap(async (req, res) => {
  const r = await appendMessage(String(req.params.workspaceId), String(req.params.threadId), req.body)
  res.status(r.deduped ? 200 : 201).json(r)
}))
synthesisRouter.get('/workspaces/:workspaceId/threads/:threadId/messages', wrap(async (req, res) => {
  const raw = typeof req.query.afterSeq === 'string' ? Number(req.query.afterSeq) : undefined
  const afterSeq = raw !== undefined && Number.isFinite(raw) ? raw : undefined
  res.json(await listMessages(String(req.params.workspaceId), String(req.params.threadId), { afterSeq }))
}))

// ── Context references (typed @-refs) ────────────────────────────────────────────
const ENTITY_TYPES = ['SOURCE', 'CLAIM', 'DECISION', 'REQUIREMENT', 'SPECIFICATION', 'METRIC', 'WORKITEM', 'OUTCOME', 'PERSON'] as const
const addContextRefSchema = z.object({
  entityType: z.enum(ENTITY_TYPES),
  entityId: z.string().trim().min(1),
  referenceMode: z.enum(['FOLLOW_LATEST', 'PINNED']).optional(),
  versionId: z.string().trim().min(1).nullable().optional(),
  contentHash: z.string().trim().min(1).nullable().optional(),
  threadId: z.string().trim().min(1).nullable().optional(),
  specificationProjectId: z.string().trim().min(1).nullable().optional(),
  workItemId: z.string().trim().min(1).nullable().optional(),
  span: z.record(z.unknown()).optional(),
  label: z.string().trim().max(500).optional(),
})

synthesisRouter.post('/workspaces/:workspaceId/context-refs', validate(addContextRefSchema), wrap(async (req, res) => {
  res.status(201).json(await addContextRef(String(req.params.workspaceId), req.body, userIdOf(req), req))
}))
synthesisRouter.get('/workspaces/:workspaceId/context-refs', wrap(async (req, res) => {
  const threadId = typeof req.query.threadId === 'string' ? req.query.threadId : undefined
  res.json(await listContextRefs(String(req.params.workspaceId), { threadId }))
}))
synthesisRouter.delete('/workspaces/:workspaceId/context-refs/:refId', wrap(async (req, res) => {
  res.json(await removeContextRef(String(req.params.workspaceId), String(req.params.refId)))
}))

// ── Context manifest (immutable per-run "what the agent will read") ──────────────
synthesisRouter.post('/workspaces/:workspaceId/threads/:threadId/manifest', wrap(async (req, res) => {
  res.status(201).json(await buildManifest(String(req.params.workspaceId), String(req.params.threadId), req))
}))
synthesisRouter.get('/workspaces/:workspaceId/manifests/:manifestId', wrap(async (req, res) => {
  res.json(await getManifest(String(req.params.workspaceId), String(req.params.manifestId)))
}))
