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


// ── Waivers (G4) ─────────────────────────────────────────────────────────────

const waiverRequestSchema = z.object({
  workItemId: z.string().optional(),
  workflowInstanceId: z.string().optional(),
  workflowNodeId: z.string().optional(),
  controlKey: z.string().min(1),
  reason: z.string().min(1),
  expiresAt: z.string().datetime().optional(),
})

/**
 * Approved, unexpired waiver controlKeys for a work item — the set the CF
 * enforcement gate treats as "waived" (passed as `governance_waivers` when a
 * stage is driven via execute-governed-stage).
 */
export async function activeWaiverControlKeys(workItemId: string, now: Date = new Date()): Promise<string[]> {
  const rows = await prisma.governanceWaiver.findMany({
    where: { workItemId, status: 'APPROVED', OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    select: { controlKey: true },
  })
  return [...new Set(rows.map(r => r.controlKey))]
}

governanceRouter.post('/waivers', async (req, res, next) => {
  try {
    const parsed = waiverRequestSchema.safeParse(req.body)
    if (!parsed.success) return res.status(422).json({ error: 'invalid waiver payload', details: parsed.error.flatten() })
    const b = parsed.data
    const waiver = await prisma.governanceWaiver.create({
      data: {
        workItemId: b.workItemId ?? null,
        workflowInstanceId: b.workflowInstanceId ?? null,
        workflowNodeId: b.workflowNodeId ?? null,
        controlKey: b.controlKey, reason: b.reason, status: 'REQUESTED',
        requestedBy: (req as { user?: { id?: string } }).user?.id ?? null,
        expiresAt: b.expiresAt ? new Date(b.expiresAt) : null,
      },
    })
    res.status(201).json(waiver)
  } catch (err) { next(err) }
})

// NOTE: waiver approval should be gated to a governing-capability member with the
// allowed role (per the overlay's waiverRules) via the existing ApprovalRequest —
// that role check is a follow-up; this records the approver id.
governanceRouter.post('/waivers/:id/approve', async (req, res, next) => {
  try {
    const waiver = await prisma.governanceWaiver.update({
      where: { id: req.params.id },
      data: { status: 'APPROVED', approvedBy: (req as { user?: { id?: string } }).user?.id ?? null },
    })
    res.json(waiver)
  } catch (err) { next(err) }
})

governanceRouter.post('/waivers/:id/reject', async (req, res, next) => {
  try {
    const waiver = await prisma.governanceWaiver.update({
      where: { id: req.params.id },
      data: { status: 'REJECTED', approvedBy: (req as { user?: { id?: string } }).user?.id ?? null },
    })
    res.json(waiver)
  } catch (err) { next(err) }
})

governanceRouter.get('/waivers', async (req, res, next) => {
  try {
    const where: Prisma.GovernanceWaiverWhereInput = {}
    if (typeof req.query.workItemId === 'string') where.workItemId = req.query.workItemId
    if (typeof req.query.controlKey === 'string') where.controlKey = req.query.controlKey
    if (req.query.active === 'true') {
      where.status = 'APPROVED'
      where.OR = [{ expiresAt: null }, { expiresAt: { gt: new Date() } }]
    }
    const rows = await prisma.governanceWaiver.findMany({ where, orderBy: { createdAt: 'desc' }, take: 100 })
    res.json(rows)
  } catch (err) { next(err) }
})
