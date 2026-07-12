import { Router } from 'express'
import { z } from 'zod'
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
  assertCanDecideApproval,
  canDecideApproval,
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

export const approvalsRouter: Router = Router()

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

async function tenantScopedInstanceIds(tenantId: string): Promise<string[]> {
  const rows = await prisma.workflowInstance.findMany({
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
  dueAt: z.string().datetime().optional(),
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
    const request = await withTenantDbTransaction(prisma, async () => {
      if (req.body.instanceId) await assertWorkflowInstanceTenant(req, req.body.instanceId)
      const created = await prisma.approvalRequest.create({
        data: { ...req.body, requestedById: req.user!.userId, dueAt: req.body.dueAt ? new Date(req.body.dueAt) : undefined },
      })
      await logEvent('ApprovalRequested', 'ApprovalRequest', created.id, req.user!.userId)
      return created
    })
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
    const [requests, total] = await withTenantDbTransaction(prisma, async () => {
      if (tenantIsolationStrict()) {
        if (instanceId) {
          await assertWorkflowInstanceTenant(req, instanceId)
        } else {
          where.instanceId = { in: await tenantScopedInstanceIds(tenantId!) }
        }
      }

      return Promise.all([
        prisma.approvalRequest.findMany({
          where, skip: pg.skip, take: pg.take,
          include: { decisions: true },
          orderBy: { createdAt: 'desc' },
        }),
        prisma.approvalRequest.count({ where }),
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
async function resolveDelegatedApprovalIds(userId: string): Promise<string[]> {
  const candidates = await prisma.approvalRequest.findMany({
    where: {
      status: 'PENDING',
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
    const [requests, total] = await withTenantDbTransaction(prisma, async () => {
      const delegatedIds = await resolveDelegatedApprovalIds(userId)
      const where: Record<string, unknown> = delegatedIds.length > 0
        ? { OR: [{ assignedToId: userId }, { id: { in: delegatedIds } }] }
        : { assignedToId: userId }
      if (statusFilter) where.status = statusFilter
      if (tenantIsolationStrict()) {
        where.instanceId = { in: await tenantScopedInstanceIds(tenantId!) }
      }

      return Promise.all([
        prisma.approvalRequest.findMany({
          where, skip: pg.skip, take: pg.take,
          include: { decisions: true },
          orderBy: { createdAt: 'desc' },
        }),
        prisma.approvalRequest.count({ where }),
      ])
    }, tenantId)
    res.json(toPageResponse(requests, total, pg))
  } catch (err) {
    next(err)
  }
})

approvalsRouter.post('/workflow-node/:nodeId/ensure', async (req, res, next) => {
  try {
    const { request, requestWithDecisions } = await withTenantDbTransaction(prisma, async () => {
      await assertWorkflowNodeTenant(req, req.params.nodeId)
      const node = await prisma.workflowNode.findUnique({ where: { id: req.params.nodeId } })
      if (!node) throw new NotFoundError('WorkflowNode', req.params.nodeId)
      if (node.nodeType !== 'APPROVAL') {
        throw new ValidationError('Only APPROVAL workflow nodes can create approval requests')
      }
      if (node.status !== 'ACTIVE') {
        throw new ValidationError('Approval request can only be ensured for an ACTIVE approval node')
      }

      const instance = node.instanceId
        ? await prisma.workflowInstance.findUnique({ where: { id: node.instanceId } })
        : null
      if (!instance) throw new NotFoundError('WorkflowInstance', node.instanceId ?? undefined)

      const created = await activateApproval(node, instance, req.user!.userId)
      const withDecisions = await prisma.approvalRequest.findUnique({
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
    const request = await withTenantDbTransaction(prisma, async () => {
      await assertApprovalRequestTenant(req, req.params.id)
      return prisma.approvalRequest.findUnique({
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
    const decisions = await withTenantDbTransaction(prisma, async () => {
      await assertApprovalRequestTenant(req, req.params.id)
      return prisma.approvalDecision.findMany({
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

    const { approvalRequest, approvalDecision } = await withTenantDbTransaction(prisma, async () => {
      const found = await prisma.approvalRequest.findUnique({ where: { id } })
      if (!found) throw new NotFoundError('ApprovalRequest', id)
      await assertApprovalRequestTenant(req, id)
      if (found.status !== 'PENDING') {
        throw new ValidationError(`ApprovalRequest cannot be decided from status ${found.status}`)
      }
      await assertCanDecideApproval(
        userId,
        approvalRequestRouting(found),
        { resourceType: 'ApprovalRequest', resourceId: id },
      )

      const created = await prisma.approvalDecision.create({
        data: { requestId: id, decidedById: userId, decision, conditions, notes },
      })
      const transitioned = await prisma.approvalRequest.updateMany({
        where: { id, status: 'PENDING' },
        data: { status: decision },
      })
      if (transitioned.count !== 1) {
        throw new ValidationError('ApprovalRequest was decided by another user; refresh and try again')
      }

      const eventId = await logEvent('ApprovalDecided', 'ApprovalRequest', id, userId, { decision })
      await createReceipt('APPROVAL_DECISION', 'ApprovalRequest', id, {
        requestId: id,
        decision,
        decidedBy: userId,
        conditions,
      }, eventId)
      await publishOutbox('ApprovalRequest', id, 'ApprovalDecided', { requestId: id, decision })
      return { approvalRequest: found, approvalDecision: created }
    })

    if (
      approvalRequest.subjectType === 'WorkflowRunBudget' &&
      (decision === 'APPROVED' || decision === 'APPROVED_WITH_CONDITIONS')
    ) {
      const handled = await approveBudgetIncreaseFromApproval(id, userId, resolveTenantFromRequest(req))
      if (handled && approvalRequest.instanceId && approvalRequest.nodeId) {
        const [node, instance] = await Promise.all([
          prisma.workflowNode.findUnique({ where: { id: approvalRequest.nodeId } }),
          prisma.workflowInstance.findUnique({ where: { id: approvalRequest.instanceId } }),
        ])
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
        await prisma.agentRun.updateMany({
          where: { id: agentRunId },
          data: { status: decision === 'APPROVED' || decision === 'APPROVED_WITH_CONDITIONS' ? 'APPROVED' : 'REJECTED' },
        })
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
      await withTenantDbTransaction(prisma, async () => {
        await assertApprovalRequestTenant(req, id)
        await prisma.approvalRequest.create({
          data: {
            instanceId: approvalRequest.instanceId ?? undefined,
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
          },
        })
      })
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

    // Mark node FAILED if rejected and linked
    if (decision === 'REJECTED' && approvalRequest.nodeId) {
      await withTenantDbTransaction(prisma, async () => {
        await assertApprovalRequestTenant(req, id)
        await prisma.workflowNode.update({
          where: { id: approvalRequest.nodeId! },
          data: { status: 'FAILED', completedAt: new Date() },
        })
      })
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

    const updated = await withTenantDbTransaction(prisma, async () => {
      const found = await prisma.approvalRequest.findUnique({ where: { id } })
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

      const saved = await prisma.approvalRequest.update({
        where: { id },
        data: { formData: data as unknown as import('@prisma/client').Prisma.InputJsonValue },
      })

      if (attachmentIds && attachmentIds.length > 0) {
        await prisma.document.updateMany({
          where: { id: { in: attachmentIds } },
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
    })

    res.json({ approvalRequest: updated, formData: data, attachmentIds: attachmentIds ?? [] })
  } catch (err) {
    next(err)
  }
})
