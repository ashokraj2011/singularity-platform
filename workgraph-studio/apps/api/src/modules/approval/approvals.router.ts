import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../lib/prisma'
import { validate } from '../../middleware/validate'
import { parsePagination, toPageResponse } from '../../lib/pagination'
import { NotFoundError } from '../../lib/errors'
import { logEvent, createReceipt, publishOutbox } from '../../lib/audit'
import { advance } from '../workflow/runtime/WorkflowRuntime'
import { approveBudgetIncreaseFromApproval } from '../workflow/runtime/budget'
import { activateAgentTask } from '../workflow/runtime/executors/AgentTaskExecutor'
import { approveWorkItem, requestWorkItemRework } from '../work-items/work-items.service'

export const approvalsRouter: Router = Router()

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
    const request = await prisma.approvalRequest.create({
      data: { ...req.body, requestedById: req.user!.userId, dueAt: req.body.dueAt ? new Date(req.body.dueAt) : undefined },
    })
    await logEvent('ApprovalRequested', 'ApprovalRequest', request.id, req.user!.userId)
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
    const where: Record<string, unknown> = {}
    if (status)     where.status     = status
    if (instanceId) where.instanceId = instanceId
    if (nodeId)     where.nodeId     = nodeId

    const [requests, total] = await Promise.all([
      prisma.approvalRequest.findMany({
        where, skip: pg.skip, take: pg.take,
        include: { decisions: true },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.approvalRequest.count({ where }),
    ])
    res.json(toPageResponse(requests, total, pg))
  } catch (err) {
    next(err)
  }
})

approvalsRouter.get('/my-approvals', async (req, res, next) => {
  try {
    const pg = parsePagination(req.query as Record<string, unknown>)
    const userId = req.user!.userId
    const statusFilter = req.query.status as string | undefined

    const where: Record<string, unknown> = { assignedToId: userId }
    if (statusFilter) where.status = statusFilter

    const [requests, total] = await Promise.all([
      prisma.approvalRequest.findMany({
        where, skip: pg.skip, take: pg.take,
        include: { decisions: true },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.approvalRequest.count({ where }),
    ])
    res.json(toPageResponse(requests, total, pg))
  } catch (err) {
    next(err)
  }
})

approvalsRouter.get('/:id', async (req, res, next) => {
  try {
    const request = await prisma.approvalRequest.findUnique({
      where: { id: req.params.id },
      include: { decisions: true },
    })
    if (!request) throw new NotFoundError('ApprovalRequest', req.params.id)
    res.json(request)
  } catch (err) {
    next(err)
  }
})

approvalsRouter.get('/:id/decisions', async (req, res, next) => {
  try {
    const decisions = await prisma.approvalDecision.findMany({
      where: { requestId: req.params.id },
      orderBy: { decidedAt: 'desc' },
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

    const approvalRequest = await prisma.approvalRequest.findUnique({ where: { id } })
    if (!approvalRequest) throw new NotFoundError('ApprovalRequest', id)

    const [approvalDecision] = await prisma.$transaction([
      prisma.approvalDecision.create({
        data: { requestId: id, decidedById: userId, decision, conditions, notes },
      }),
      prisma.approvalRequest.update({
        where: { id },
        data: { status: decision },
      }),
    ])

    const eventId = await logEvent('ApprovalDecided', 'ApprovalRequest', id, userId, { decision })
    await createReceipt('APPROVAL_DECISION', 'ApprovalRequest', id, {
      requestId: id,
      decision,
      decidedBy: userId,
      conditions,
    }, eventId)
    await publishOutbox('ApprovalRequest', id, 'ApprovalDecided', { requestId: id, decision })

    if (
      approvalRequest.subjectType === 'WorkflowRunBudget' &&
      (decision === 'APPROVED' || decision === 'APPROVED_WITH_CONDITIONS')
    ) {
      const handled = await approveBudgetIncreaseFromApproval(id, userId)
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

    // Handle escalation — create new request for supervisor
    if (decision === 'ESCALATED' && escalateToId) {
      await prisma.approvalRequest.create({
        data: {
          instanceId: approvalRequest.instanceId ?? undefined,
          nodeId: approvalRequest.nodeId ?? undefined,
          subjectType: approvalRequest.subjectType,
          subjectId: approvalRequest.subjectId,
          requestedById: userId,
          assignedToId: escalateToId,
        },
      })
    }

    // Advance workflow if approved and linked to a node
    if (
      (decision === 'APPROVED' || decision === 'APPROVED_WITH_CONDITIONS') &&
      approvalRequest.nodeId &&
      approvalRequest.instanceId
    ) {
      try {
        await advance(approvalRequest.instanceId, approvalRequest.nodeId, { approvalDecision: decision }, userId)
      } catch (advanceErr) {
        console.error('Workflow advance failed after approval:', advanceErr)
      }
    }

    // Mark node FAILED if rejected and linked
    if (decision === 'REJECTED' && approvalRequest.nodeId) {
      await prisma.workflowNode.update({
        where: { id: approvalRequest.nodeId },
        data: { status: 'FAILED', completedAt: new Date() },
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

    const approvalRequest = await prisma.approvalRequest.findUnique({ where: { id } })
    if (!approvalRequest) throw new NotFoundError('ApprovalRequest', id)

    const updated = await prisma.approvalRequest.update({
      where: { id },
      data: { formData: data as unknown as import('@prisma/client').Prisma.InputJsonValue },
    })

    if (attachmentIds && attachmentIds.length > 0) {
      await prisma.document.updateMany({
        where: { id: { in: attachmentIds } },
        data: {
          nodeId:     approvalRequest.nodeId,
          instanceId: approvalRequest.instanceId,
        },
      })
    }

    await logEvent('ApprovalFormSubmitted', 'ApprovalRequest', id, req.user!.userId, {
      instanceId: approvalRequest.instanceId,
      nodeId: approvalRequest.nodeId,
      attachmentCount: attachmentIds?.length ?? 0,
    })

    res.json({ approvalRequest: updated, formData: data, attachmentIds: attachmentIds ?? [] })
  } catch (err) {
    next(err)
  }
})
