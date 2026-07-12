import { Router } from 'express'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { validate } from '../../middleware/validate'
import { parsePagination, toPageResponse } from '../../lib/pagination'
import { NotFoundError, ValidationError } from '../../lib/errors'
import { logEvent, createReceipt, publishOutbox } from '../../lib/audit'
import { advance, failNode } from '../workflow/runtime/WorkflowRuntime'
import { approveBudgetIncreaseFromApproval } from '../workflow/runtime/budget'
import { activateAgentTask } from '../workflow/runtime/executors/AgentTaskExecutor'
import { activateApproval } from '../workflow/runtime/executors/ApprovalExecutor'
import { approveWorkItem, requestWorkItemRework } from '../work-items/work-items.service'
import { ROLE_LOOKUP_BUDGET } from '../../lib/iam/callerContext'
import {
  approvalRequestRouting,
  approvalPermission,
  assertCanDecideApproval,
  assertCanRequestApproval,
  canDecideApproval,
  validateApprovalRouting,
} from '../../lib/permissions/approval'
import {
  assertApprovalRequestTenant,
  assertWorkflowInstanceTenant,
  assertWorkflowNodeTenant,
  requireTenantFromRequest,
  resolveTenantFromRequest,
  tenantIsolationStrict,
} from '../../lib/tenant-isolation'
import { withTenantDbTransaction } from '../../lib/tenant-db-context'
import { evaluateApprovalQuorum } from '../../lib/permissions/approval-quorum'
import { createNotification } from '../notifications/notifications.service'

export const approvalsRouter: Router = Router()

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function permissionForApprovalSubject(subjectType: string): string {
  if (subjectType === 'DirectLlmTask' || subjectType === 'AgentRun') return approvalPermission('agent')
  if (subjectType === 'ToolRun') return approvalPermission('tool')
  if (subjectType === 'GovernanceWaiver') return approvalPermission('governance')
  if (subjectType === 'Consumable') return approvalPermission('consumable')
  return approvalPermission('workflow')
}

async function tenantScopedInstanceIds(tenantId: string, db: Prisma.TransactionClient | typeof prisma = prisma): Promise<string[]> {
  const rows = await db.workflowInstance.findMany({
    where: { tenantId },
    select: { id: true },
    take: 5000,
  })
  return rows.map(row => row.id)
}

const createApprovalSchema = z.object({
  instanceId: z.string().uuid().optional(),
  nodeId: z.string().uuid().optional(),
  subjectType: z.string().min(1),
  subjectId: z.string().uuid(),
  assignedToId: z.string().uuid().optional(),
  assignmentMode: z.enum(['DIRECT_USER', 'TEAM_QUEUE', 'ROLE_BASED', 'SKILL_BASED']).optional(),
  teamId: z.string().uuid().optional(),
  roleKey: z.string().trim().max(120).optional(),
  skillKey: z.string().trim().max(120).optional(),
  capabilityId: z.string().uuid().optional(),
  dueAt: z.string().datetime().optional(),
  quorumRequired: z.coerce.number().int().min(1).max(100).optional(),
  adminOverride: z.boolean().optional(),
  escalationPolicy: z.record(z.unknown()).optional(),
})

const decisionSchema = z.object({
  decision: z.enum(['APPROVED', 'REJECTED', 'APPROVED_WITH_CONDITIONS', 'NEEDS_MORE_INFORMATION', 'DEFERRED', 'ESCALATED']),
  conditions: z.string().optional(),
  notes: z.string().optional(),
  escalateToId: z.string().uuid().optional(),
})

approvalsRouter.post('/', validate(createApprovalSchema), async (req, res, next) => {
  try {
    if (tenantIsolationStrict() && !req.body.instanceId) {
      throw new ValidationError('TENANT_ISOLATION_MODE=strict requires instanceId when creating an approval request')
    }
    // Runtime executors own WorkItem/agent/tool/budget approval creation. The
    // public route may only create a request for an actual workflow approval
    // node; otherwise a caller could manufacture a WorkItem approval around an
    // arbitrary subject and then approve it through the normal decision path.
    if (
      req.body.subjectType !== 'WorkflowNode'
      || !req.body.instanceId
      || !req.body.nodeId
      || req.body.subjectId !== req.body.nodeId
    ) {
      throw new ValidationError('Approval requests must be created by the runtime or linked to a WorkflowNode approval')
    }
    try {
      validateApprovalRouting(req.body)
    } catch (error) {
      throw new ValidationError(error instanceof Error ? error.message : 'invalid approval routing')
    }
    const tenantId = resolveTenantFromRequest(req) ?? 'default'
    const request = await withTenantDbTransaction(prisma, async (tx) => {
      if (req.body.instanceId) await assertWorkflowInstanceTenant(req, req.body.instanceId)
      const node = await tx.workflowNode.findFirst({ where: { id: req.body.nodeId, instanceId: req.body.instanceId }, select: { nodeType: true, status: true } })
      if (!node || node.nodeType !== 'APPROVAL') throw new ValidationError('Approval request must target an existing APPROVAL workflow node')
      if (node.status !== 'ACTIVE') throw new ValidationError('Approval request can only be created for an ACTIVE approval node')
      let capabilityId = req.body.capabilityId ?? null
      if (!capabilityId && req.body.instanceId) {
        const instance = await tx.workflowInstance.findUnique({
          where: { id: req.body.instanceId },
          select: { template: { select: { capabilityId: true } } },
        })
        capabilityId = instance?.template?.capabilityId ?? null
      }
      if (!capabilityId && req.body.subjectType === 'WorkItem') {
        const workItem = await tx.workItem.findUnique({ where: { id: req.body.subjectId }, select: { parentCapabilityId: true } })
        capabilityId = workItem?.parentCapabilityId ?? null
      }
      await assertCanRequestApproval(
        req.user!.userId,
        capabilityId,
        permissionForApprovalSubject(req.body.subjectType),
      )
      const created = await tx.approvalRequest.create({
        data: {
          ...req.body,
          tenantId,
          requestedById: req.user!.userId,
          dueAt: req.body.dueAt ? new Date(req.body.dueAt) : undefined,
        },
      })
      await logEvent('ApprovalRequested', 'ApprovalRequest', created.id, req.user!.userId)
      return created
    }, tenantId)
    res.status(201).json(request)
  } catch (err) {
    next(err)
  }
})

// List with filters (instanceId, nodeId, status). Used by NodeInspector to find
// the runtime ApprovalRequest associated with the selected workflow node.
approvalsRouter.get('/', async (req, res, next) => {
  try {
    const pg = parsePagination(req.query as Record<string, unknown>)
    const { status, instanceId, nodeId } = req.query as Record<string, string | undefined>
    const tenantId = requireTenantFromRequest(req, 'approval request listing')
    const where: Record<string, unknown> = {}
    if (status)     where.status     = status
    if (instanceId) where.instanceId = instanceId
    if (nodeId)     where.nodeId     = nodeId
    const [requests, total] = await withTenantDbTransaction(prisma, async (tx) => {
      if (tenantIsolationStrict()) {
        if (instanceId) {
          await assertWorkflowInstanceTenant(req, instanceId)
        } else {
          where.instanceId = { in: await tenantScopedInstanceIds(tenantId!, tx) }
        }
      }

      return Promise.all([
        tx.approvalRequest.findMany({
          where, skip: pg.skip, take: pg.take,
          include: { decisions: true },
          orderBy: { createdAt: 'desc' },
        }),
        tx.approvalRequest.count({ where }),
      ])
    }, tenantId)
    res.json(toPageResponse(requests, total, pg))
  } catch (err) {
    next(err)
  }
})

/**
 * Resolve PENDING approval requests the caller can act on by *delegated*
 * routing rather than a direct `assignedToId`.  The same authorization gate
 * used by POST /:id/decision is applied here so the inbox cannot advertise
 * requests that the caller will be denied when they click Approve.
 *
 * These rows carry no `assignedToId`, so without read-time resolution they are
 * invisible in every inbox. The work-item parent-approval gate
 * (work-items.service.ts maybeRequestParentApproval) creates exactly this shape
 * — `roleKey:'owner'` + `capabilityId`, no assignee — when a work item has no
 * creator, which is why a successful workflow's escalated work item could never
 * be approved and therefore never reached COMPLETED. Mirrors the runtime inbox
 * (runtime.router.ts).
 */
async function resolveDelegatedApprovalIds(userId: string, tenantId?: string, db: Prisma.TransactionClient | typeof prisma = prisma): Promise<string[]> {
  const candidates = await db.approvalRequest.findMany({
    where: {
      status: 'PENDING',
      ...(tenantId ? { tenantId } : {}),
      assignedToId: null,
      OR: [
        { roleKey: { not: null }, capabilityId: { not: null } },
        { teamId: { not: null } },
        { skillKey: { not: null } },
        { capabilityId: { not: null } },
      ],
    },
    select: {
      id: true,
      assignedToId: true,
      assignmentMode: true,
      teamId: true,
      roleKey: true,
      skillKey: true,
      capabilityId: true,
      dueAt: true,
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
  })

  const capped = candidates.slice(0, ROLE_LOOKUP_BUDGET)
  const checks = await Promise.all(capped.map(async (candidate) => {
    const result = await canDecideApproval(
      userId,
      approvalRequestRouting(candidate),
      { resourceType: 'ApprovalRequest', resourceId: candidate.id },
    ).catch(() => ({ allowed: false }))
    return result.allowed ? candidate.id : null
  }))
  return checks.filter((id): id is string => Boolean(id))
}

approvalsRouter.get('/my-approvals', async (req, res, next) => {
  try {
    const pg = parsePagination(req.query as Record<string, unknown>)
    const userId = req.user!.userId
    const statusFilter = req.query.status as string | undefined
    const tenantId = requireTenantFromRequest(req, 'my approvals')

    // Direct assignments PLUS delegated (role/team) PENDING approvals resolved
    // at read time — otherwise role-based work-item approvals never surface.
    const [requests, total] = await withTenantDbTransaction(prisma, async (tx) => {
      const delegatedIds = await resolveDelegatedApprovalIds(userId, tenantId, tx)
      const where: Record<string, unknown> = delegatedIds.length > 0
        ? { OR: [{ assignedToId: userId }, { id: { in: delegatedIds } }] }
        : { assignedToId: userId }
      if (statusFilter) where.status = statusFilter
      if (tenantIsolationStrict()) {
        where.instanceId = { in: await tenantScopedInstanceIds(tenantId!, tx) }
      }

      return Promise.all([
        tx.approvalRequest.findMany({
          where, skip: pg.skip, take: pg.take,
          include: { decisions: true },
          orderBy: { createdAt: 'desc' },
        }),
        tx.approvalRequest.count({ where }),
      ])
    }, tenantId)
    res.json(toPageResponse(requests, total, pg))
  } catch (err) {
    next(err)
  }
})

approvalsRouter.post('/workflow-node/:nodeId/ensure', async (req, res, next) => {
  try {
    const { request, requestWithDecisions } = await withTenantDbTransaction(prisma, async (tx) => {
      await assertWorkflowNodeTenant(req, req.params.nodeId)
      const node = await tx.workflowNode.findUnique({ where: { id: req.params.nodeId } })
      if (!node) throw new NotFoundError('WorkflowNode', req.params.nodeId)
      if (node.nodeType !== 'APPROVAL') {
        throw new ValidationError('Only APPROVAL workflow nodes can create approval requests')
      }
      if (node.status !== 'ACTIVE') {
        throw new ValidationError('Approval request can only be ensured for an ACTIVE approval node')
      }

      const instance = node.instanceId
        ? await tx.workflowInstance.findUnique({ where: { id: node.instanceId } })
        : null
      if (!instance) throw new NotFoundError('WorkflowInstance', node.instanceId ?? undefined)

      const created = await activateApproval(node, instance, req.user!.userId)
      const withDecisions = await tx.approvalRequest.findUnique({
        where: { id: created.id },
        include: { decisions: true },
      })
      return { request: created, requestWithDecisions: withDecisions }
    })
    res.status(201).json(requestWithDecisions ?? request)
  } catch (err) {
    next(err)
  }
})

approvalsRouter.get('/:id', async (req, res, next) => {
  try {
    const request = await withTenantDbTransaction(prisma, async (tx) => {
      await assertApprovalRequestTenant(req, req.params.id)
      return tx.approvalRequest.findUnique({
        where: { id: req.params.id },
        include: { decisions: true },
      })
    })
    if (!request) throw new NotFoundError('ApprovalRequest', req.params.id)
    res.json(request)
  } catch (err) {
    next(err)
  }
})

approvalsRouter.get('/:id/decisions', async (req, res, next) => {
  try {
    const decisions = await withTenantDbTransaction(prisma, async (tx) => {
      await assertApprovalRequestTenant(req, req.params.id)
      return tx.approvalDecision.findMany({
        where: { requestId: req.params.id },
        orderBy: { decidedAt: 'desc' },
      })
    })
    res.json(decisions)
  } catch (err) {
    next(err)
  }
})

approvalsRouter.post('/:id/decision', validate(decisionSchema), async (req, res, next) => {
  try {
    const { decision, conditions, notes, escalateToId } = req.body as z.infer<typeof decisionSchema>
    const userId = req.user!.userId
    const id = req.params.id as string

    const decisionResult = await withTenantDbTransaction(prisma, async (tx) => {
      const found = await tx.approvalRequest.findUnique({ where: { id } })
      if (!found) throw new NotFoundError('ApprovalRequest', id)
      await assertApprovalRequestTenant(req, id)
      if (found.status !== 'PENDING') {
        throw new ValidationError(`ApprovalRequest cannot be decided from status ${found.status}`)
      }
      const eligibility = await assertCanDecideApproval(
        userId,
        approvalRequestRouting(found),
        { resourceType: 'ApprovalRequest', resourceId: id },
      )

      const duplicate = await tx.approvalDecision.findFirst({
        where: { requestId: id, decidedById: userId },
        select: { id: true },
      })
      if (duplicate) throw new ValidationError('Each approver may cast only one vote on an approval request')

      let created
      try {
        created = await tx.approvalDecision.create({
          data: { requestId: id, decidedById: userId, decision, conditions, notes },
        })
      } catch (err) {
        if (typeof err === 'object' && err && 'code' in err && (err as { code?: string }).code === 'P2002') {
          throw new ValidationError('Each approver may cast only one vote on an approval request')
        }
        throw err
      }
      const allDecisions = await tx.approvalDecision.findMany({
        where: { requestId: id },
        select: { decidedById: true, decision: true },
      })
      const existingPositiveVotes = new Set(
        allDecisions.filter(row => row.decision === 'APPROVED' || row.decision === 'APPROVED_WITH_CONDITIONS').map(row => row.decidedById),
      ).size - (decision === 'APPROVED' || decision === 'APPROVED_WITH_CONDITIONS' ? 1 : 0)
      const quorum = evaluateApprovalQuorum({ decision, existingPositiveVotes, quorumRequired: found.quorumRequired, isAdmin: eligibility.isAdmin, adminOverride: found.adminOverride })
      const { approvalsReceived, quorumRequired, decisionFinal } = quorum
      const positive = decision === 'APPROVED' || decision === 'APPROVED_WITH_CONDITIONS'
      const transitioned = decisionFinal
        ? await tx.approvalRequest.updateMany({
            where: { id, status: 'PENDING' },
            data: {
              status: decision,
              ...(positive && approvalsReceived >= quorumRequired ? { quorumMetAt: new Date() } : {}),
            },
          })
        : { count: 1 }
      if (decisionFinal && transitioned.count !== 1) {
        throw new ValidationError('ApprovalRequest was decided by another user; refresh and try again')
      }

      const eventId = await logEvent(
        decisionFinal ? 'ApprovalDecided' : 'ApprovalVoteRecorded',
        'ApprovalRequest',
        id,
        userId,
        { decision, decisionFinal, approvalsReceived, quorumRequired },
      )
      await createReceipt('APPROVAL_DECISION', 'ApprovalRequest', id, {
        requestId: id,
        decision,
        decidedBy: userId,
        conditions,
        decisionFinal,
        approvalsReceived,
        quorumRequired,
      }, eventId)
      await publishOutbox('ApprovalRequest', id, decisionFinal ? 'ApprovalDecided' : 'ApprovalVoteRecorded', {
        requestId: id, decision, decisionFinal, approvalsReceived, quorumRequired,
      })
      return {
        approvalRequest: { ...found, status: decisionFinal ? decision : 'PENDING' },
        approvalDecision: created,
        decisionFinal,
        approvalsReceived,
        quorumRequired,
      }
    })

    const { approvalRequest, approvalDecision, decisionFinal, approvalsReceived, quorumRequired } = decisionResult
    const decisionTenantId = approvalRequest.tenantId ?? resolveTenantFromRequest(req) ?? 'default'
    if (!decisionFinal) {
      await createNotification({
        tenantId: approvalRequest.tenantId ?? resolveTenantFromRequest(req) ?? 'default',
        userId: approvalRequest.assignedToId ?? undefined,
        teamId: approvalRequest.teamId ?? undefined,
        kind: 'APPROVAL_VOTE_REMAINING',
        title: 'More approvals required',
        message: `${approvalsReceived} of ${quorumRequired} approvals have been recorded.`,
        severity: 'warning',
        entityType: 'ApprovalRequest',
        entityId: id,
        href: `/approvals/${id}`,
        payload: { approvalsReceived, quorumRequired },
      }).catch(() => undefined)
      res.status(201).json({ approvalDecision, approvalRequest, pending: true, approvalsReceived, quorumRequired })
      return
    }

    if (
      approvalRequest.subjectType === 'WorkflowRunBudget' &&
      (decision === 'APPROVED' || decision === 'APPROVED_WITH_CONDITIONS')
    ) {
      const handled = await approveBudgetIncreaseFromApproval(id, userId, resolveTenantFromRequest(req))
      if (handled && approvalRequest.instanceId && approvalRequest.nodeId) {
        const [node, instance] = await withTenantDbTransaction(prisma, tx => Promise.all([
          tx.workflowNode.findUnique({ where: { id: approvalRequest.nodeId! } }),
          tx.workflowInstance.findUnique({ where: { id: approvalRequest.instanceId! } }),
        ]), decisionTenantId)
        if (node?.nodeType === 'AGENT_TASK' && instance) {
          await activateAgentTask(node, instance)
        }
      }
      res.status(201).json(approvalDecision)
      return
    }

    if (approvalRequest.subjectType === 'WorkItem') {
      if (decision === 'APPROVED' || decision === 'APPROVED_WITH_CONDITIONS') {
        await approveWorkItem(approvalRequest.subjectId, userId, decision)
      } else if (decision === 'REJECTED' || decision === 'NEEDS_MORE_INFORMATION') {
        await requestWorkItemRework(approvalRequest.subjectId, userId, undefined, notes ?? conditions)
      }
      res.status(201).json(approvalDecision)
      return
    }

    if (approvalRequest.subjectType === 'DirectLlmTask') {
      const form = isRecord(approvalRequest.formData) ? approvalRequest.formData : {}
      const directLlmOutput = isRecord(form.directLlmOutput) ? form.directLlmOutput : {}
      const directLlm = isRecord(directLlmOutput.directLlm) ? directLlmOutput.directLlm : {}
      const workEvent = isRecord(directLlm.workEvent) ? directLlm.workEvent : undefined
      const agentRunId = typeof form.agentRunId === 'string' ? form.agentRunId : null
      const eventPayload = {
        approvalRequestId: id,
        decision,
        agentRunId,
        instanceId: approvalRequest.instanceId,
        nodeId: approvalRequest.nodeId,
        ...(workEvent ? { workEvent } : {}),
        ...(workEvent && typeof workEvent.workId === 'string' ? { workId: workEvent.workId } : {}),
        ...(workEvent && typeof workEvent.capabilityName === 'string' ? { capabilityName: workEvent.capabilityName } : {}),
        notes,
        conditions,
      }
      if (agentRunId) {
        await withTenantDbTransaction(prisma, tx => tx.agentRun.updateMany({
          where: { id: agentRunId },
          data: { status: decision === 'APPROVED' || decision === 'APPROVED_WITH_CONDITIONS' ? 'APPROVED' : 'REJECTED' },
        }), decisionTenantId)
      }
      if (
        (decision === 'APPROVED' || decision === 'APPROVED_WITH_CONDITIONS') &&
        approvalRequest.nodeId &&
        approvalRequest.instanceId
      ) {
        await publishOutbox('AgentRun', agentRunId ?? id, 'DirectLlmReviewApproved', eventPayload)
        await advance(approvalRequest.instanceId, approvalRequest.nodeId, {
          ...directLlmOutput,
          directLlmReview: {
            approvalRequestId: id,
            decision,
            notes,
            conditions,
            decidedBy: userId,
          },
        }, userId, undefined, resolveTenantFromRequest(req))
      } else if (
        (decision === 'REJECTED' || decision === 'NEEDS_MORE_INFORMATION') &&
        approvalRequest.nodeId &&
        approvalRequest.instanceId
      ) {
        await publishOutbox('AgentRun', agentRunId ?? id, 'DirectLlmReviewRejected', eventPayload)
        await failNode(approvalRequest.instanceId, approvalRequest.nodeId, {
          message: decision === 'NEEDS_MORE_INFORMATION'
            ? 'Direct LLM output was sent back for more information.'
            : 'Direct LLM output was rejected by human review.',
          code: decision === 'NEEDS_MORE_INFORMATION' ? 'DIRECT_LLM_REVIEW_SEND_BACK' : 'DIRECT_LLM_REVIEW_REJECTED',
          retryable: false,
          details: {
            ...eventPayload,
            directLlmOutput,
          },
        }, userId, resolveTenantFromRequest(req))
      }
      res.status(201).json(approvalDecision)
      return
    }

    // Handle escalation — create new request for supervisor
    if (decision === 'ESCALATED' && escalateToId) {
      await withTenantDbTransaction(prisma, async (tx) => {
        await assertApprovalRequestTenant(req, id)
        await tx.approvalRequest.create({
          data: {
            instanceId: approvalRequest.instanceId ?? undefined,
            tenantId: approvalRequest.tenantId ?? resolveTenantFromRequest(req) ?? 'default',
            nodeId: approvalRequest.nodeId ?? undefined,
            subjectType: approvalRequest.subjectType,
            subjectId: approvalRequest.subjectId,
            requestedById: userId,
            assignedToId: escalateToId,
            assignmentMode: 'DIRECT_USER',
            teamId: approvalRequest.teamId ?? undefined,
            roleKey: approvalRequest.roleKey ?? undefined,
            skillKey: approvalRequest.skillKey ?? undefined,
            capabilityId: approvalRequest.capabilityId ?? undefined,
            dueAt: approvalRequest.dueAt ?? undefined,
            quorumRequired: approvalRequest.quorumRequired,
            adminOverride: approvalRequest.adminOverride,
            escalationPolicy: approvalRequest.escalationPolicy as Prisma.InputJsonValue,
          },
        })
      }, decisionTenantId)
    }

    // Advance workflow if approved and linked to a node
    if (
      (decision === 'APPROVED' || decision === 'APPROVED_WITH_CONDITIONS') &&
      approvalRequest.nodeId &&
      approvalRequest.instanceId
    ) {
      try {
        await advance(approvalRequest.instanceId, approvalRequest.nodeId, { approvalDecision: decision }, userId, undefined, resolveTenantFromRequest(req))
      } catch (advanceErr) {
        console.error('Workflow advance failed after approval:', advanceErr)
      }
    }

    // Rejections and send-backs must close the blocked node through the runtime
    // failure path, so the run, node, audit, and downstream state agree.
    if ((decision === 'REJECTED' || decision === 'NEEDS_MORE_INFORMATION') && approvalRequest.nodeId && approvalRequest.instanceId) {
      await failNode(approvalRequest.instanceId, approvalRequest.nodeId, {
        code: decision === 'NEEDS_MORE_INFORMATION' ? 'HUMAN_APPROVAL_SEND_BACK' : 'HUMAN_APPROVAL_REJECTED',
        retryable: false,
        message: decision === 'NEEDS_MORE_INFORMATION'
          ? 'The approval was sent back for more information.'
          : 'The approval was rejected by an authorized approver.',
        details: { approvalRequestId: id, decidedBy: userId, notes, conditions },
      }, userId, decisionTenantId)
    }

    res.status(201).json(approvalDecision)
  } catch (err) {
    next(err)
  }
})

// ─── Approval Form Submission ─────────────────────────────────────────────────

const approvalFormSubmissionSchema = z.object({
  data: z.record(z.unknown()),
  attachmentIds: z.array(z.string().uuid()).optional(),
})

approvalsRouter.post('/:id/form-submission', validate(approvalFormSubmissionSchema), async (req, res, next) => {
  try {
    const id = req.params.id as string
    const { data, attachmentIds } = req.body as z.infer<typeof approvalFormSubmissionSchema>

    const tenantId = resolveTenantFromRequest(req) ?? 'default'
    const updated = await withTenantDbTransaction(prisma, async (tx) => {
      const found = await tx.approvalRequest.findUnique({ where: { id } })
      if (!found) throw new NotFoundError('ApprovalRequest', id)
      await assertApprovalRequestTenant(req, id)
      if (found.status !== 'PENDING') {
        throw new ValidationError(`ApprovalRequest form cannot be changed from status ${found.status}`)
      }
      await assertCanDecideApproval(
        req.user!.userId,
        approvalRequestRouting(found),
        { resourceType: 'ApprovalRequest', resourceId: id },
      )

      const saved = await tx.approvalRequest.update({
        where: { id },
        data: { formData: data as unknown as import('@prisma/client').Prisma.InputJsonValue },
      })

      if (attachmentIds && attachmentIds.length > 0) {
        await tx.document.updateMany({
          where: { id: { in: attachmentIds }, ...(found.instanceId ? { instanceId: found.instanceId } : {}) },
          data: {
            nodeId:     found.nodeId,
            instanceId: found.instanceId,
          },
        })
      }

      await logEvent('ApprovalFormSubmitted', 'ApprovalRequest', id, req.user!.userId, {
        instanceId: found.instanceId,
        nodeId: found.nodeId,
        attachmentCount: attachmentIds?.length ?? 0,
      })
      return saved
    }, tenantId)

    res.json({ approvalRequest: updated, formData: data, attachmentIds: attachmentIds ?? [] })
  } catch (err) {
    next(err)
  }
})
