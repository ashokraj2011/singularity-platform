/**
 * Runtime inbox — single endpoint that aggregates the work surfaced to an
 * end-user across Tasks, Approvals, and Consumables.
 *
 *   GET /api/runtime/inbox
 *     → { mine: InboxItem[], available: InboxItem[], done: InboxItem[] }
 *
 * Eligibility resolution:
 *
 *   Mine       — assignedToId === me OR (Task) any TaskAssignment.assignedToId === me.
 *   Available  — claimable, unclaimed queue items the caller matches:
 *                  TEAM_QUEUE   → me.teamId  === item.teamId
 *                  SKILL_BASED  → item.skillKey IN local UserSkill keys
 *                  ROLE_BASED   → IAM authzCheck against item.capabilityId
 *                                 (only when AUTH_PROVIDER=iam, capped to N items
 *                                  per request to bound the IAM RTT cost).
 *   Done       — completed in the last 30 days, where the caller was the
 *                assignee, claimer, or decider.
 */

import { Router } from 'express'
import { prisma } from '../../lib/prisma'
import { config } from '../../config'
import { authzCheck } from '../../lib/iam/client'
import { loadCallerContext, ROLE_LOOKUP_BUDGET } from '../../lib/iam/callerContext'
import { requireTenantFromRequest, resolveTenantFromRequest, tenantIsolationStrict } from '../../lib/tenant-isolation'
import { withTenantDbTransaction } from '../../lib/tenant-db-context'

export const runtimeRouter: Router = Router()

// ── Types (echoed in the web app) ────────────────────────────────────────────

type InboxKind = 'task' | 'approval' | 'consumable' | 'workitem'

type InboxItem = {
  kind:               InboxKind
  id:                 string
  title:              string
  workflowInstanceId: string | null
  workflowName?:      string | null
  nodeId:             string | null
  nodeLabel?:         string | null
  status:             string
  assignmentMode:     string | null
  dueAt:              string | null
  priority?:          number | null
  workCode?:          string | null
  originType?:        string | null
  urgency?:           string | null
  createdAt:          string
  updatedAt:          string
  claimable:          boolean       // can this user claim it (Available bucket)
  targetId?:          string | null
  targetCapabilityId?: string | null
}

// ROLE_LOOKUP_BUDGET and loadCallerContext are shared with the approvals inbox
// via ../../lib/iam/callerContext.

// ── Helpers to coerce DB rows into the unified InboxItem shape ───────────────

type InstanceLite = { id: string; name: string }
type NodeLite     = { id: string; label: string }

function buildTaskItem(t: {
  id: string; title: string; status: string;
  instanceId: string | null; nodeId: string | null;
  assignmentMode: string | null; dueAt: Date | null;
  priority: number | null; createdAt: Date; updatedAt: Date;
}, instance: InstanceLite | null, node: NodeLite | null, claimable: boolean): InboxItem {
  return {
    kind:               'task',
    id:                 t.id,
    title:              t.title,
    workflowInstanceId: t.instanceId,
    workflowName:       instance?.name ?? null,
    nodeId:             t.nodeId,
    nodeLabel:          node?.label ?? null,
    status:             t.status,
    assignmentMode:     t.assignmentMode ?? null,
    dueAt:              t.dueAt?.toISOString() ?? null,
    priority:           t.priority,
    createdAt:          t.createdAt.toISOString(),
    updatedAt:          t.updatedAt.toISOString(),
    claimable,
  }
}

function buildApprovalItem(a: {
  id: string; status: string; subjectType: string;
  instanceId: string | null; nodeId: string | null;
  assignmentMode: string | null; dueAt: Date | null;
  createdAt: Date; updatedAt: Date;
}, instance: InstanceLite | null, node: NodeLite | null, claimable: boolean): InboxItem {
  return {
    kind:               'approval',
    id:                 a.id,
    title:              `Approval · ${a.subjectType}`,
    workflowInstanceId: a.instanceId,
    workflowName:       instance?.name ?? null,
    nodeId:             a.nodeId,
    nodeLabel:          node?.label ?? null,
    status:             a.status,
    assignmentMode:     a.assignmentMode ?? null,
    dueAt:              a.dueAt?.toISOString() ?? null,
    createdAt:          a.createdAt.toISOString(),
    updatedAt:          a.updatedAt.toISOString(),
    claimable,
  }
}

function buildConsumableItem(c: {
  id: string; name: string; status: string;
  instanceId: string | null; nodeId: string | null;
  assignmentMode: string | null;
  createdAt: Date; updatedAt: Date;
}, instance: InstanceLite | null, node: NodeLite | null, claimable: boolean): InboxItem {
  return {
    kind:               'consumable',
    id:                 c.id,
    title:              c.name,
    workflowInstanceId: c.instanceId,
    workflowName:       instance?.name ?? null,
    nodeId:             c.nodeId,
    nodeLabel:          node?.label ?? null,
    status:             c.status,
    assignmentMode:     c.assignmentMode ?? null,
    dueAt:              null,
    createdAt:          c.createdAt.toISOString(),
    updatedAt:          c.updatedAt.toISOString(),
    claimable,
  }
}

function buildWorkItemItem(target: {
  id: string; targetCapabilityId: string; status: string; claimedById: string | null;
  createdAt: Date; updatedAt: Date;
  workItem: {
    id: string; workCode?: string | null; originType?: string | null; title: string;
    sourceWorkflowInstanceId: string | null; sourceWorkflowNodeId: string | null;
    priority: number | null; dueAt: Date | null; urgency?: string | null
  }
}, instance: InstanceLite | null, node: NodeLite | null, claimable: boolean): InboxItem {
  return {
    kind:               'workitem',
    id:                 target.workItem.id,
    workCode:           target.workItem.workCode ?? null,
    originType:         target.workItem.originType ?? null,
    targetId:           target.id,
    targetCapabilityId: target.targetCapabilityId,
    title:              target.workItem.workCode ? `${target.workItem.workCode} · ${target.workItem.title}` : target.workItem.title,
    workflowInstanceId: target.workItem.sourceWorkflowInstanceId,
    workflowName:       instance?.name ?? null,
    nodeId:             target.workItem.sourceWorkflowNodeId,
    nodeLabel:          node?.label ?? null,
    status:             target.status,
    assignmentMode:     'ROLE_BASED',
    dueAt:              target.workItem.dueAt?.toISOString() ?? null,
    priority:           target.workItem.priority,
    urgency:            target.workItem.urgency ?? null,
    createdAt:          target.createdAt.toISOString(),
    updatedAt:          target.updatedAt.toISOString(),
    claimable,
  }
}

// ── Endpoint ─────────────────────────────────────────────────────────────────

runtimeRouter.get('/inbox', async (req, res, next) => {
  try {
    const ctx = await loadCallerContext(req.user!.userId)

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    const tenantId = tenantIsolationStrict()
      ? requireTenantFromRequest(req, 'runtime inbox')
      : resolveTenantFromRequest(req)

    const {
      directTasks,
      assignedTasks,
      directApprovals,
      directConsumables,
      workItemTargets,
      queueItems,
      doneTasks,
      doneApprovals,
      instanceById,
      nodeById,
    } = await withTenantDbTransaction(prisma, async () => {
      // ── Fetch base data in parallel ─────────────────────────────────────
      const [
        directTasks,
        assignedTasks,
        directApprovals,
        directConsumables,
        workItemTargets,
        queueItems,
        doneTasks,
        doneApprovals,
      ] = await Promise.all([
        // Tasks where the caller is the direct assignee (assignmentMode = DIRECT_USER)
        prisma.task.findMany({
          where: {
            status: { in: ['OPEN', 'IN_PROGRESS', 'PENDING_REVIEW'] },
            OR: [
              { assignments: { some: { assignedToId: ctx.userId } } },
            ],
          },
          orderBy: { createdAt: 'desc' },
          take: 100,
        }),
        // Tasks the caller has already claimed from a queue (assignedToId on TaskAssignment after claim)
        prisma.task.findMany({
          where: {
            status: 'IN_PROGRESS',
            queueItems: { some: { claimedById: ctx.userId } },
          },
          orderBy: { updatedAt: 'desc' },
          take: 100,
        }),
        // Approvals directly assigned to the caller
        prisma.approvalRequest.findMany({
          where: {
            assignedToId: ctx.userId,
            status: 'PENDING',
          },
          orderBy: { createdAt: 'desc' },
          take: 100,
        }),
        // Consumables directly assigned to the caller
        prisma.consumable.findMany({
          where: {
            assignedToId: ctx.userId,
            status: { in: ['DRAFT', 'UNDER_REVIEW'] },
          },
          orderBy: { createdAt: 'desc' },
          take: 100,
        }),
        prisma.workItemTarget.findMany({
          where: {
            status: { in: ['QUEUED', 'REWORK_REQUESTED', 'CLAIMED', 'IN_PROGRESS', 'SUBMITTED'] },
            workItem: { status: { not: 'ARCHIVED' } },
            OR: [
              { claimedById: ctx.userId },
              { claimedById: null },
            ],
          },
          include: { workItem: true },
          orderBy: { updatedAt: 'desc' },
          take: 200,
        }),
        // Unclaimed queue items the caller might be eligible for.  We pull a
        // generous batch and filter in app code (the routing-field indexes keep
        // this fast).
        prisma.teamQueueItem.findMany({
          where: {
            claimedById: null,
            OR: [
              ...(ctx.teamIds.length   > 0 ? [{ teamId:   { in: ctx.teamIds   } }] : []),
              ...(ctx.skillKeys.length > 0 ? [{ skillKey: { in: ctx.skillKeys } }] : []),
              // ROLE_BASED: pull all and filter via IAM below
              { roleKey: { not: null }, capabilityId: { not: null } },
            ],
          },
          orderBy: { enqueuedAt: 'desc' },
          take: 200,
          include: { task: true },
        }),
        // Done — recent completed tasks (caller was claimer or assignee)
        prisma.task.findMany({
          where: {
            status: 'COMPLETED',
            updatedAt: { gte: thirtyDaysAgo },
            OR: [
              { assignments: { some: { assignedToId: ctx.userId } } },
              { queueItems:  { some: { claimedById: ctx.userId } } },
            ],
          },
          orderBy: { updatedAt: 'desc' },
          take: 50,
        }),
        // Done — recent decided approvals
        prisma.approvalRequest.findMany({
          where: {
            status: { in: ['APPROVED', 'REJECTED', 'APPROVED_WITH_CONDITIONS'] },
            updatedAt: { gte: thirtyDaysAgo },
            OR: [
              { assignedToId: ctx.userId },
              { decisions: { some: { decidedById: ctx.userId } } },
            ],
          },
          orderBy: { updatedAt: 'desc' },
          take: 50,
        }),
      ])

      // ── Enrich with instance + node names (single batched fetch) ────────
      const allInstanceIds = new Set<string>()
      const allNodeIds     = new Set<string>()
      const collectIds = (rows: Array<{ instanceId: string | null; nodeId: string | null }>) => {
        for (const r of rows) {
          if (r.instanceId) allInstanceIds.add(r.instanceId)
          if (r.nodeId)     allNodeIds.add(r.nodeId)
        }
      }
      collectIds(directTasks); collectIds(assignedTasks)
      collectIds(directApprovals); collectIds(directConsumables)
      collectIds(workItemTargets.map(t => ({
        instanceId: t.workItem.sourceWorkflowInstanceId,
        nodeId: t.workItem.sourceWorkflowNodeId,
      })))
      collectIds(doneTasks); collectIds(doneApprovals)
      for (const q of queueItems) {
        if (q.task.instanceId) allInstanceIds.add(q.task.instanceId)
        if (q.task.nodeId)     allNodeIds.add(q.task.nodeId)
      }

      const [instancesRaw, nodesRaw] = await Promise.all([
        prisma.workflowInstance.findMany({
          where: { id: { in: Array.from(allInstanceIds) } },
          select: { id: true, name: true },
        }),
        prisma.workflowNode.findMany({
          where: { id: { in: Array.from(allNodeIds) } },
          select: { id: true, label: true },
        }),
      ])
      const instanceById: Record<string, InstanceLite> = Object.fromEntries(instancesRaw.map(x => [x.id, x]))
      const nodeById:     Record<string, NodeLite>     = Object.fromEntries(nodesRaw.map(x => [x.id, x]))

      return {
        directTasks,
        assignedTasks,
        directApprovals,
        directConsumables,
        workItemTargets,
        queueItems,
        doneTasks,
        doneApprovals,
        instanceById,
        nodeById,
      }
    }, tenantId)

    // ── ROLE_BASED filtering via IAM (when configured) ────────────────────
    let roleEligibility: Map<string, boolean> = new Map()
    let workItemEligibility: Map<string, boolean> = new Map()
    if (config.AUTH_PROVIDER === 'iam' && ctx.iamUserId) {
      const roleQueue = queueItems.filter(q => q.roleKey && q.capabilityId).slice(0, ROLE_LOOKUP_BUDGET)
      const checks = await Promise.all(
        roleQueue.map(q =>
          authzCheck(ctx.iamUserId!, q.capabilityId!, 'workflow:assign', {
            resourceType: 'TeamQueueItem',
            resourceId: q.id,
            tenantId,
          })
            .then(r => [q.id, r.allowed] as const)
            .catch(() => [q.id, false] as const),
        ),
      )
      roleEligibility = new Map(checks)

      const unclaimedWorkItems = workItemTargets
        .filter(t => !t.claimedById && ['QUEUED', 'REWORK_REQUESTED'].includes(t.status))
        .slice(0, ROLE_LOOKUP_BUDGET)
      const workItemChecks = await Promise.all(
        unclaimedWorkItems.map(t =>
          authzCheck(ctx.iamUserId!, t.targetCapabilityId, 'workflow:assign', {
            resourceType: 'WorkItemTarget',
            resourceId: t.id,
            tenantId,
          })
            .then(r => [t.id, r.allowed] as const)
            .catch(() => [t.id, false] as const),
        ),
      )
      workItemEligibility = new Map(workItemChecks)
    }

    // ── Build output ──────────────────────────────────────────────────────
    const mine: InboxItem[] = []
    const available: InboxItem[] = []
    const done: InboxItem[] = []

    for (const t of directTasks) {
      mine.push(buildTaskItem(t, t.instanceId ? instanceById[t.instanceId] ?? null : null,
                                 t.nodeId     ? nodeById[t.nodeId]         ?? null : null, false))
    }
    for (const t of assignedTasks) {
      mine.push(buildTaskItem(t, t.instanceId ? instanceById[t.instanceId] ?? null : null,
                                 t.nodeId     ? nodeById[t.nodeId]         ?? null : null, false))
    }
    for (const a of directApprovals) {
      mine.push(buildApprovalItem(a, a.instanceId ? instanceById[a.instanceId] ?? null : null,
                                     a.nodeId     ? nodeById[a.nodeId]         ?? null : null, false))
    }
    for (const c of directConsumables) {
      mine.push(buildConsumableItem(c, c.instanceId ? instanceById[c.instanceId] ?? null : null,
                                       c.nodeId     ? nodeById[c.nodeId]         ?? null : null, false))
    }

    for (const t of workItemTargets) {
      const item = buildWorkItemItem(
        t,
        t.workItem.sourceWorkflowInstanceId ? instanceById[t.workItem.sourceWorkflowInstanceId] ?? null : null,
        t.workItem.sourceWorkflowNodeId ? nodeById[t.workItem.sourceWorkflowNodeId] ?? null : null,
        !t.claimedById && ['QUEUED', 'REWORK_REQUESTED'].includes(t.status),
      )
      if (t.claimedById === ctx.userId) {
        mine.push(item)
      } else if (!t.claimedById && ['QUEUED', 'REWORK_REQUESTED'].includes(t.status)) {
        const eligible = config.AUTH_PROVIDER === 'iam' && ctx.iamUserId
          ? workItemEligibility.get(t.id) === true
          : true
        if (eligible) available.push(item)
      }
    }

    for (const q of queueItems) {
      let eligible = false
      if (q.teamId && ctx.teamIds.includes(q.teamId)) eligible = true
      else if (q.skillKey && ctx.skillKeys.includes(q.skillKey)) eligible = true
      else if (q.roleKey && q.capabilityId && roleEligibility.get(q.id)) eligible = true
      if (!eligible) continue

      const t = q.task
      available.push(buildTaskItem(t, t.instanceId ? instanceById[t.instanceId] ?? null : null,
                                      t.nodeId     ? nodeById[t.nodeId]         ?? null : null, true))
    }

    for (const t of doneTasks) {
      done.push(buildTaskItem(t, t.instanceId ? instanceById[t.instanceId] ?? null : null,
                                 t.nodeId     ? nodeById[t.nodeId]         ?? null : null, false))
    }
    for (const a of doneApprovals) {
      done.push(buildApprovalItem(a, a.instanceId ? instanceById[a.instanceId] ?? null : null,
                                     a.nodeId     ? nodeById[a.nodeId]         ?? null : null, false))
    }

    res.json({
      counts: { mine: mine.length, available: available.length, done: done.length },
      mine, available, done,
    })
  } catch (err) {
    next(err)
  }
})
