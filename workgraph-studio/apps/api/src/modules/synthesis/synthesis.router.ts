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
import { createDocument, getDocument, listDocuments, transitionDocument } from './document.service'
import { addBlock, updateBlock, removeBlock, pinBlock } from './block.service'
import { createWorkspaceProposal, listProposals, getProposal, decideProposalItems, rebaseProposalItem } from './proposal.service'

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

// ── Documents ─────────────────────────────────────────────────────────────────
const DOC_TYPES = ['PRD', 'BRD', 'READOUT', 'DIGEST', 'NARRATIVE', 'GENERIC'] as const
const DOC_STATUSES = ['DRAFT', 'IN_REVIEW', 'CHANGES_REQUESTED', 'APPROVED', 'PUBLISHED', 'SUPERSEDED', 'ARCHIVED'] as const
const BLOCK_TYPES = ['NARRATIVE', 'CITATION', 'CLAIM', 'DECISION', 'REQUIREMENT', 'ACCEPTANCE', 'OBJECTIVE', 'METRIC', 'RISK', 'EXPERIMENT', 'DIAGRAM', 'WORKITEM', 'AGENT_INFERENCE'] as const

const createDocumentSchema = z.object({
  specificationProjectId: z.string().trim().min(1),
  docType: z.enum(DOC_TYPES),
  title: z.string().trim().min(1).max(300),
  workItemId: z.string().trim().min(1).nullable().optional(),
  workspaceId: z.string().trim().min(1).nullable().optional(),
  specificationVersionId: z.string().trim().min(1).nullable().optional(),
})
const transitionSchema = z.object({ to: z.enum(DOC_STATUSES) })
const addBlockSchema = z.object({
  blockType: z.enum(BLOCK_TYPES),
  content: z.record(z.unknown()).optional(),
  ordinal: z.number().int().min(0).optional(),
  mode: z.enum(['LIVE', 'PINNED']).optional(),
  sourceRef: z.record(z.unknown()).optional(),
  authorType: z.enum(['HUMAN', 'AGENT', 'SYSTEM']).optional(),
  authorId: z.string().trim().min(1).optional(),
  agentRole: z.string().trim().max(100).optional(),
})
const updateBlockSchema = z.object({ content: z.record(z.unknown()).optional(), ordinal: z.number().int().min(0).optional() })

synthesisRouter.post('/documents', validate(createDocumentSchema), wrap(async (req, res) => {
  res.status(201).json(await createDocument(req.body, userIdOf(req)))
}))
synthesisRouter.get('/documents', wrap(async (req, res) => {
  const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined
  const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : undefined
  res.json(await listDocuments({ projectId, workspaceId }))
}))
synthesisRouter.get('/documents/:documentId', wrap(async (req, res) => {
  res.json(await getDocument(String(req.params.documentId)))
}))
synthesisRouter.post('/documents/:documentId/transition', validate(transitionSchema), wrap(async (req, res) => {
  res.json(await transitionDocument(String(req.params.documentId), req.body.to, userIdOf(req)))
}))

// ── Document blocks (own-content docs only) ──────────────────────────────────────
synthesisRouter.post('/documents/:documentId/blocks', validate(addBlockSchema), wrap(async (req, res) => {
  res.status(201).json(await addBlock(String(req.params.documentId), req.body))
}))
synthesisRouter.patch('/documents/:documentId/blocks/:blockId', validate(updateBlockSchema), wrap(async (req, res) => {
  res.json(await updateBlock(String(req.params.documentId), String(req.params.blockId), req.body))
}))
synthesisRouter.delete('/documents/:documentId/blocks/:blockId', wrap(async (req, res) => {
  res.json(await removeBlock(String(req.params.documentId), String(req.params.blockId)))
}))
synthesisRouter.post('/documents/:documentId/blocks/:blockId/pin', wrap(async (req, res) => {
  res.json(await pinBlock(String(req.params.documentId), String(req.params.blockId)))
}))

// ── Universal (v2) proposals + items ─────────────────────────────────────────────
const proposalItemInputSchema = z.object({
  kind: z.string().trim().min(1).max(80),
  title: z.string().trim().max(300).optional(),
  targetEntityType: z.string().trim().max(80).optional(),
  targetEntityId: z.string().trim().max(200).optional(),
  targetVersionId: z.string().trim().max(200).optional(),
  baseContentHash: z.string().trim().max(200).optional(),
  diff: z.record(z.unknown()).optional(),
  citations: z.array(z.unknown()).optional(),
  evidenceTier: z.string().trim().max(40).optional(),
  uncertainty: z.number().min(0).max(1).optional(),
  reversibility: z.string().trim().max(40).optional(),
  cost: z.record(z.unknown()).optional(),
  requiredApproval: z.string().trim().max(80).optional(),
})
const createProposalSchema = z.object({
  workItemId: z.string().trim().min(1).nullable().optional(),
  agentRole: z.string().trim().max(100).optional(),
  contract: z.record(z.unknown()).optional(),
  items: z.array(proposalItemInputSchema).min(1).max(100),
})
const decideSchema = z.object({
  decisions: z.array(z.object({
    itemId: z.string().trim().min(1),
    decision: z.enum(['ACCEPT', 'REJECT', 'EDIT']),
    editedDiff: z.record(z.unknown()).optional(),
    currentContentHash: z.string().trim().max(200).optional(),
  })).min(1).max(100),
})
const rebaseItemSchema = z.object({ diff: z.record(z.unknown()).optional(), baseContentHash: z.string().trim().max(200).optional() })

synthesisRouter.post('/workspaces/:workspaceId/proposals', validate(createProposalSchema), wrap(async (req, res) => {
  res.status(201).json(await createWorkspaceProposal({ workspaceId: String(req.params.workspaceId), ...req.body }, userIdOf(req)))
}))
synthesisRouter.get('/workspaces/:workspaceId/proposals', wrap(async (req, res) => {
  res.json(await listProposals(String(req.params.workspaceId)))
}))
synthesisRouter.get('/proposals/:proposalId', wrap(async (req, res) => {
  res.json(await getProposal(String(req.params.proposalId)))
}))
synthesisRouter.post('/proposals/:proposalId/decide', validate(decideSchema), wrap(async (req, res) => {
  res.json(await decideProposalItems(String(req.params.proposalId), req.body.decisions, userIdOf(req)))
}))
synthesisRouter.post('/proposals/:proposalId/items/:itemId/rebase', validate(rebaseItemSchema), wrap(async (req, res) => {
  res.json(await rebaseProposalItem(String(req.params.proposalId), String(req.params.itemId), req.body))
}))
