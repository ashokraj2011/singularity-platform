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
import { NotFoundError, ValidationError } from '../../lib/errors'
import { resolveGovernance, type GovernanceResolveContext } from '../../lib/iam/client'
import {
  assertCanDecideApproval,
  approvalPermission,
  approvalRequestRouting,
} from '../../lib/permissions/approval'
import {
  assertWorkflowInstanceTenant,
  requireTenantFromRequest,
  resolveTenantFromRequest,
  tenantIsolationStrict,
} from '../../lib/tenant-isolation'
import { withTenantDbTransaction } from '../../lib/tenant-db-context'
import { failNode } from '../workflow/runtime/WorkflowRuntime'

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
export async function activeWaiverControlKeys(workItemId: string, now: Date = new Date(), tenantId?: string): Promise<string[]> {
  const rows = await withTenantDbTransaction(prisma, tx => tx.governanceWaiver.findMany({
    where: { workItemId, status: 'APPROVED', OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    select: { controlKey: true },
  }), tenantId)
  return [...new Set(rows.map(r => r.controlKey))]
}

governanceRouter.post('/waivers', async (req, res, next) => {
  try {
    const parsed = waiverRequestSchema.safeParse(req.body)
    if (!parsed.success) return res.status(422).json({ error: 'invalid waiver payload', details: parsed.error.flatten() })
    const b = parsed.data
    if (tenantIsolationStrict() && !b.workItemId && !b.workflowInstanceId) {
      throw new ValidationError('Strict tenant isolation requires workItemId or workflowInstanceId for a governance waiver')
    }
    const tenantId = tenantIsolationStrict()
      ? requireTenantFromRequest(req, 'governance waiver creation')
      : resolveTenantFromRequest(req)
    const waiver = await withTenantDbTransaction(prisma, async (tx) => {
      if (b.workflowInstanceId) {
        await assertWorkflowInstanceTenant(req, b.workflowInstanceId)
        if (b.workflowNodeId) {
          const node = await tx.workflowNode.findFirst({ where: { id: b.workflowNodeId, instanceId: b.workflowInstanceId }, select: { id: true } })
          if (!node) throw new ValidationError('workflowNodeId does not belong to workflowInstanceId')
        }
      }
      if (b.workItemId) {
        const item = await tx.workItem.findUnique({ where: { id: b.workItemId }, select: { id: true, tenantId: true } })
        if (!item || (tenantIsolationStrict() && item.tenantId !== tenantId)) throw new NotFoundError('WorkItem', b.workItemId)
      }
      return tx.governanceWaiver.create({
        data: {
          workItemId: b.workItemId ?? null,
          workflowInstanceId: b.workflowInstanceId ?? null,
          workflowNodeId: b.workflowNodeId ?? null,
          controlKey: b.controlKey,
          reason: b.reason,
          status: 'REQUESTED',
          requestedBy: req.user?.userId ?? null,
          expiresAt: b.expiresAt ? new Date(b.expiresAt) : null,
        },
      })
    }, tenantId)
    res.status(201).json(waiver)
  } catch (err) { next(err) }
})

async function waiverCapabilityId(waiver: {
  workItemId: string | null
  workflowInstanceId: string | null
}, tenantId?: string): Promise<string | null> {
  return withTenantDbTransaction(prisma, async (tx) => {
    if (waiver.workItemId) {
      const workItem = await tx.workItem.findUnique({
        where: { id: waiver.workItemId },
        select: { parentCapabilityId: true },
      })
      if (workItem?.parentCapabilityId) return workItem.parentCapabilityId
    }
    if (waiver.workflowInstanceId) {
      const instance = await tx.workflowInstance.findUnique({
        where: { id: waiver.workflowInstanceId },
        select: { template: { select: { capabilityId: true } } },
      })
      return instance?.template?.capabilityId ?? null
    }
    return null
  }, tenantId)
}

/** Load a waiver through its linked tenant-owned resource before any action. */
async function loadWaiverForRequest(req: Parameters<typeof resolveTenantFromRequest>[0], id: string) {
  const tenantId = tenantIsolationStrict()
    ? requireTenantFromRequest(req, 'governance waiver access')
    : resolveTenantFromRequest(req)
  return withTenantDbTransaction(prisma, async (tx) => {
    const waiver = await tx.governanceWaiver.findUnique({ where: { id } })
    if (!waiver) return null
    if (tenantIsolationStrict()) {
      if (!waiver.workflowInstanceId && !waiver.workItemId) {
        throw new ValidationError('Strict tenant isolation requires a governance waiver to link a WorkItem or workflow instance')
      }
      if (waiver.workflowInstanceId) {
        const instance = await tx.workflowInstance.findUnique({ where: { id: waiver.workflowInstanceId }, select: { tenantId: true } })
        if (!instance || (instance.tenantId ?? tenantId) !== tenantId) throw new NotFoundError('GovernanceWaiver', id)
      }
      if (waiver.workItemId) {
        const workItem = await tx.workItem.findUnique({ where: { id: waiver.workItemId }, select: { tenantId: true } })
        if (!workItem || (workItem.tenantId ?? tenantId) !== tenantId) throw new NotFoundError('GovernanceWaiver', id)
      }
    }
    return waiver
  }, tenantId)
}

governanceRouter.post('/waivers/:id/approve', async (req, res, next) => {
  try {
    const actorId = req.user!.userId
    const tenantId = tenantIsolationStrict() ? requireTenantFromRequest(req, 'governance waiver approval') : resolveTenantFromRequest(req)
    const existing = await loadWaiverForRequest(req, req.params.id)
    if (!existing) throw new NotFoundError('GovernanceWaiver', req.params.id)
    if (existing.status !== 'REQUESTED') {
      throw new ValidationError(`Governance waiver cannot be approved from status ${existing.status}`)
    }
    if (existing.expiresAt && existing.expiresAt.getTime() <= Date.now()) {
      throw new ValidationError('Governance waiver has already expired')
    }
    const pendingApproval = existing.workflowInstanceId && existing.workflowNodeId
      ? await withTenantDbTransaction(prisma, (tx) => tx.approvalRequest.findFirst({
          where: {
            instanceId: existing.workflowInstanceId,
            nodeId: existing.workflowNodeId,
            subjectType: 'WorkflowNode',
            subjectId: existing.workflowNodeId!,
            status: 'PENDING',
          },
        }), tenantId)
      : null
    const pendingDecisions = pendingApproval
      ? await withTenantDbTransaction(prisma, (tx) => tx.approvalDecision.findMany({ where: { requestId: pendingApproval.id } }), tenantId)
      : []
    const eligibility = await assertCanDecideApproval(
      actorId,
      pendingApproval
        ? approvalRequestRouting(pendingApproval)
        : { assignmentMode: 'ROLE_BASED', roleKey: 'governance', capabilityId: await waiverCapabilityId(existing, tenantId) },
      { permissionKey: approvalPermission('governance'), resourceType: 'GovernanceWaiver', resourceId: existing.id },
    )
    if (pendingApproval) {
      if (pendingDecisions.some(decision => decision.decidedById === actorId)) {
        throw new ValidationError('This approver has already voted on the governance waiver')
      }
      const approvalCount = pendingDecisions.filter(decision => decision.decision === 'APPROVED' || decision.decision === 'APPROVED_WITH_CONDITIONS').length + 1
      const quorumRequired = Math.max(1, pendingApproval.quorumRequired || 1)
      const final = Boolean(eligibility.isAdmin && pendingApproval.adminOverride) || approvalCount >= quorumRequired
      await withTenantDbTransaction(prisma, (tx) => tx.approvalDecision.create({ data: { requestId: pendingApproval.id, decidedById: actorId, decision: 'APPROVED' } }), tenantId)
      if (!final) {
        res.status(202).json({ pending: true, approvalRequestId: pendingApproval.id, approvalsReceived: approvalCount, quorumRequired })
        return
      }
      await withTenantDbTransaction(prisma, (tx) => tx.approvalRequest.update({ where: { id: pendingApproval.id }, data: { status: 'APPROVED', quorumMetAt: new Date() } }), tenantId)
    }
    const waiver = await withTenantDbTransaction(prisma, (tx) => tx.governanceWaiver.update({
      where: { id: req.params.id },
      data: { status: 'APPROVED', approvedBy: actorId },
    }), tenantId)
    // Auto-resume the GOVERNANCE_GATE that opened this waiver: restartNode re-runs
    // the gate, which now sees the control as waived and proceeds. Best-effort +
    // dynamic import to avoid a runtime↔governance import cycle. If it fails, the
    // node stays BLOCKED (manually restartable) — never stuck.
    if (waiver.workflowInstanceId && waiver.workflowNodeId) {
      try {
        const { restartNode } = await import('../workflow/runtime/WorkflowRuntime')
        await restartNode(waiver.workflowInstanceId, waiver.workflowNodeId, actorId, tenantId)
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`[governance] waiver-approve auto-resume failed (node stays restartable): ${(e as Error).message}`)
      }
    }
    res.json(waiver)
  } catch (err) { next(err) }
})

governanceRouter.post('/waivers/:id/reject', async (req, res, next) => {
  try {
    const actorId = req.user!.userId
    const tenantId = tenantIsolationStrict() ? requireTenantFromRequest(req, 'governance waiver rejection') : resolveTenantFromRequest(req)
    const existing = await loadWaiverForRequest(req, req.params.id)
    if (!existing) throw new NotFoundError('GovernanceWaiver', req.params.id)
    if (existing.status !== 'REQUESTED') {
      throw new ValidationError(`Governance waiver cannot be rejected from status ${existing.status}`)
    }
    const pendingApproval = existing.workflowInstanceId && existing.workflowNodeId
      ? await withTenantDbTransaction(prisma, (tx) => tx.approvalRequest.findFirst({
          where: {
            instanceId: existing.workflowInstanceId,
            nodeId: existing.workflowNodeId,
            subjectType: 'WorkflowNode',
            subjectId: existing.workflowNodeId!,
            status: 'PENDING',
          },
        }), tenantId)
      : null
    const pendingDecisions = pendingApproval
      ? await withTenantDbTransaction(prisma, (tx) => tx.approvalDecision.findMany({ where: { requestId: pendingApproval.id } }), tenantId)
      : []
    await assertCanDecideApproval(
      actorId,
      pendingApproval
        ? approvalRequestRouting(pendingApproval)
        : { assignmentMode: 'ROLE_BASED', roleKey: 'governance', capabilityId: await waiverCapabilityId(existing, tenantId) },
      { permissionKey: approvalPermission('governance'), resourceType: 'GovernanceWaiver', resourceId: existing.id },
    )
    if (pendingDecisions.some(decision => decision.decidedById === actorId)) {
      throw new ValidationError('This approver has already voted on the governance waiver')
    }
    if (pendingApproval) {
      await withTenantDbTransaction(prisma, async (tx) => {
        await tx.approvalDecision.create({ data: { requestId: pendingApproval.id, decidedById: actorId, decision: 'REJECTED' } })
        await tx.approvalRequest.updateMany({ where: { id: pendingApproval.id, status: 'PENDING' }, data: { status: 'REJECTED' } })
      }, tenantId)
    }
    const waiver = await withTenantDbTransaction(prisma, (tx) => tx.governanceWaiver.update({
      where: { id: req.params.id },
      data: { status: 'REJECTED', approvedBy: actorId },
    }), tenantId)
    if (waiver.workflowInstanceId && waiver.workflowNodeId) {
      await failNode(waiver.workflowInstanceId, waiver.workflowNodeId, {
        code: 'GOVERNANCE_WAIVER_REJECTED',
        retryable: false,
        message: 'The governance waiver was rejected by an authorized approver.',
        details: { waiverId: waiver.id, controlKey: waiver.controlKey, rejectedBy: actorId },
      }, actorId, tenantId)
    }
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
    const tenantId = tenantIsolationStrict() ? requireTenantFromRequest(req, 'governance waiver listing') : resolveTenantFromRequest(req)
    const rows = await withTenantDbTransaction(prisma, async tx => {
      if (tenantIsolationStrict()) {
        const [instances, workItems] = await Promise.all([
          tx.workflowInstance.findMany({ where: { tenantId }, select: { id: true }, take: 5000 }),
          tx.workItem.findMany({ where: { tenantId }, select: { id: true }, take: 5000 }),
        ])
        const allowedInstanceIds = instances.map(row => row.id)
        const allowedWorkItemIds = workItems.map(row => row.id)
        const existingOr = where.OR
        const existingAnd = where.AND ? (Array.isArray(where.AND) ? where.AND : [where.AND]) : []
        where.AND = [
          ...existingAnd,
          { OR: [{ workflowInstanceId: { in: allowedInstanceIds } }, { workItemId: { in: allowedWorkItemIds } }] },
        ]
        if (existingOr) {
          const existingOrList = Array.isArray(existingOr) ? existingOr : [existingOr]
          ;(where.AND as Prisma.GovernanceWaiverWhereInput[]).push({ OR: existingOrList })
          delete where.OR
        }
      }
      return tx.governanceWaiver.findMany({ where, orderBy: { createdAt: 'desc' }, take: 100 })
    }, tenantId)
    res.json(rows)
  } catch (err) { next(err) }
})
