/**
 * Capability Governance Model (G2) — workgraph-api governance surface.
 *
 *   POST /api/governance/resolve              → proxy to IAM /governance/resolve
 *   POST /api/governance/resolve-and-snapshot → resolve (IAM) + persist the snapshot
 *   POST /api/governance/snapshot             → persist a caller-provided overlay
 *   GET  /api/governance/snapshots            → list snapshots (by work item / run)
 *
 * The resolved overlay is produced by IAM (the authority on the capability
 * graph). workgraph snapshots it so a run/stage reads the governance that
 * applied at execution time, never live state.
 */
import { Router } from 'express'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { resolveGovernance, type GovernanceResolveContext } from '../../lib/iam/client'

export const governanceRouter: Router = Router()

const resolveSchema = z.object({
  capability_id: z.string().min(1),
  work_item_type: z.string().optional(),
  workflow_type: z.string().optional(),
  workflow_id: z.string().optional(),
  stage_key: z.string().optional(),
  agent_role: z.string().optional(),
  node_id: z.string().optional(),
  risk_level: z.string().optional(),
})

const snapshotSchema = z.object({
  workItemId: z.string().optional(),
  workflowInstanceId: z.string().optional(),
  workflowNodeId: z.string().optional(),
  governedCapabilityId: z.string().min(1),
  overlay: z.record(z.unknown()),  // resolved overlay; must carry overlayHash
})

async function persistSnapshot(args: {
  workItemId?: string; workflowInstanceId?: string; workflowNodeId?: string;
  governedCapabilityId: string; overlay: Record<string, unknown>;
}) {
  const overlayHash = String(args.overlay.overlayHash ?? '')
  if (!overlayHash) throw new ValidationLite('overlay.overlayHash is required')
  // Idempotent on (workItemId, workflowNodeId, overlayHash).
  const existing = await prisma.governanceOverlaySnapshot.findFirst({
    where: { workItemId: args.workItemId ?? null, workflowNodeId: args.workflowNodeId ?? null, overlayHash },
  })
  if (existing) return existing
  return prisma.governanceOverlaySnapshot.create({
    data: {
      workItemId: args.workItemId ?? null,
      workflowInstanceId: args.workflowInstanceId ?? null,
      workflowNodeId: args.workflowNodeId ?? null,
      governedCapabilityId: args.governedCapabilityId,
      overlayHash,
      resolvedOverlayJson: args.overlay as Prisma.InputJsonValue,
    },
  })
}

class ValidationLite extends Error {}

governanceRouter.post('/resolve', async (req, res, next) => {
  try {
    const parsed = resolveSchema.safeParse(req.body)
    if (!parsed.success) return res.status(422).json({ error: 'invalid resolve payload', details: parsed.error.flatten() })
    const overlay = await resolveGovernance(parsed.data as GovernanceResolveContext)
    if (!overlay) return res.status(502).json({ error: 'governance resolve unavailable (IAM)' })
    res.json({ success: true, data: overlay })
  } catch (err) { next(err) }
})

governanceRouter.post('/resolve-and-snapshot', async (req, res, next) => {
  try {
    const parsed = resolveSchema.safeParse(req.body)
    if (!parsed.success) return res.status(422).json({ error: 'invalid resolve payload', details: parsed.error.flatten() })
    const ctx = parsed.data as GovernanceResolveContext
    const overlay = await resolveGovernance(ctx)
    if (!overlay) return res.status(502).json({ error: 'governance resolve unavailable (IAM)' })
    const snap = await persistSnapshot({
      workItemId: typeof req.body.workItemId === 'string' ? req.body.workItemId : undefined,
      workflowInstanceId: typeof req.body.workflowInstanceId === 'string' ? req.body.workflowInstanceId : undefined,
      workflowNodeId: ctx.node_id,
      governedCapabilityId: ctx.capability_id,
      overlay,
    })
    res.json({ success: true, data: { overlay, snapshotId: snap.id } })
  } catch (err) {
    if (err instanceof ValidationLite) return res.status(422).json({ error: err.message })
    next(err)
  }
})

governanceRouter.post('/snapshot', async (req, res, next) => {
  try {
    const parsed = snapshotSchema.safeParse(req.body)
    if (!parsed.success) return res.status(422).json({ error: 'invalid snapshot payload', details: parsed.error.flatten() })
    const snap = await persistSnapshot({ ...parsed.data, overlay: parsed.data.overlay as Record<string, unknown> })
    res.status(201).json(snap)
  } catch (err) {
    if (err instanceof ValidationLite) return res.status(422).json({ error: err.message })
    next(err)
  }
})

governanceRouter.get('/snapshots', async (req, res, next) => {
  try {
    const where: Prisma.GovernanceOverlaySnapshotWhereInput = {}
    if (typeof req.query.workItemId === 'string') where.workItemId = req.query.workItemId
    if (typeof req.query.workflowInstanceId === 'string') where.workflowInstanceId = req.query.workflowInstanceId
    const rows = await prisma.governanceOverlaySnapshot.findMany({
      where, orderBy: { resolvedAt: 'desc' }, take: 50,
    })
    res.json(rows)
  } catch (err) { next(err) }
})
