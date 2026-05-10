import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../lib/prisma'
import { validate } from '../../middleware/validate'
import { parsePagination, toPageResponse } from '../../lib/pagination'
import { NotFoundError, ValidationError } from '../../lib/errors'
import { logEvent, createReceipt, publishOutbox } from '../../lib/audit'

export const tasksRouter: Router = Router()

const createTaskSchema = z.object({
  instanceId: z.string().uuid().optional(),
  nodeId: z.string().uuid().optional(),
  title: z.string().min(1),
  description: z.string().optional(),
  assignmentMode: z.enum(['DIRECT_USER', 'TEAM_QUEUE', 'ROLE_BASED', 'SKILL_BASED', 'AGENT']).default('DIRECT_USER'),
  priority: z.number().int().default(50),
  dueAt: z.string().datetime().optional(),
  assignedToId: z.string().uuid().optional(),
  teamId: z.string().uuid().optional(),
})

tasksRouter.post('/', validate(createTaskSchema), async (req, res, next) => {
  try {
    const { assignedToId, teamId, ...taskData } = req.body as z.infer<typeof createTaskSchema>
    const task = await prisma.task.create({
      data: {
        ...taskData,
        createdById: req.user!.userId,
        dueAt: taskData.dueAt ? new Date(taskData.dueAt) : undefined,
        ...(assignedToId && { assignments: { create: { assignedToId } } }),
        ...(teamId && { queueItems: { create: { teamId } } }),
      },
      include: { assignments: true, queueItems: true },
    })
    await logEvent('TaskCreated', 'Task', task.id, req.user!.userId)
    res.status(201).json(task)
  } catch (err) {
    next(err)
  }
})

tasksRouter.get('/', async (req, res, next) => {
  try {
    const pg = parsePagination(req.query as Record<string, unknown>)
    const { status, instanceId, nodeId } = req.query
    const where: Record<string, unknown> = {}
    if (status)     where.status     = status
    if (instanceId) where.instanceId = instanceId
    if (nodeId)     where.nodeId     = nodeId

    const [tasks, total] = await Promise.all([
      prisma.task.findMany({
        where, skip: pg.skip, take: pg.take,
        include: { assignments: true, queueItems: true, attachments: true },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.task.count({ where }),
    ])
    res.json(toPageResponse(tasks, total, pg))
  } catch (err) {
    next(err)
  }
})

tasksRouter.get('/my-work', async (req, res, next) => {
  try {
    const pg = parsePagination(req.query as Record<string, unknown>)
    const userId = req.user!.userId

    const [tasks, total] = await Promise.all([
      prisma.task.findMany({
        where: {
          status: { in: ['OPEN', 'IN_PROGRESS', 'PENDING_REVIEW'] },
          assignments: { some: { assignedToId: userId } },
        },
        skip: pg.skip, take: pg.take,
        include: { assignments: true },
        orderBy: { priority: 'desc' },
      }),
      prisma.task.count({
        where: {
          status: { in: ['OPEN', 'IN_PROGRESS', 'PENDING_REVIEW'] },
          assignments: { some: { assignedToId: userId } },
        },
      }),
    ])
    res.json(toPageResponse(tasks, total, pg))
  } catch (err) {
    next(err)
  }
})

tasksRouter.get('/team-queue/:teamId', async (req, res, next) => {
  try {
    const pg = parsePagination(req.query as Record<string, unknown>)
    const [items, total] = await Promise.all([
      prisma.teamQueueItem.findMany({
        where: { teamId: req.params.teamId, claimedById: null },
        include: { task: true },
        skip: pg.skip, take: pg.take,
        orderBy: { enqueuedAt: 'asc' },
      }),
      prisma.teamQueueItem.count({ where: { teamId: req.params.teamId, claimedById: null } }),
    ])
    res.json(toPageResponse(items, total, pg))
  } catch (err) {
    next(err)
  }
})

tasksRouter.get('/:id', async (req, res, next) => {
  try {
    const task = await prisma.task.findUnique({
      where: { id: req.params.id },
      include: { assignments: true, queueItems: true, comments: true, statusHistory: true },
    })
    if (!task) throw new NotFoundError('Task', req.params.id)
    res.json(task)
  } catch (err) {
    next(err)
  }
})

tasksRouter.post('/:id/claim', async (req, res, next) => {
  try {
    const userId = req.user!.userId
    const queueItem = await prisma.teamQueueItem.findFirst({
      where: { taskId: req.params.id, claimedById: null },
    })
    if (!queueItem) {
      throw new ValidationError('Task is not available to claim or already claimed')
    }

    const [updatedItem, task] = await prisma.$transaction([
      prisma.teamQueueItem.update({
        where: { id: queueItem.id },
        data: { claimedById: userId, claimedAt: new Date() },
      }),
      prisma.task.update({
        where: { id: req.params.id },
        data: { status: 'IN_PROGRESS' },
        include: { assignments: true, queueItems: true },
      }),
    ])

    await prisma.taskStatusHistory.create({
      data: { taskId: req.params.id, previousStatus: 'OPEN', newStatus: 'IN_PROGRESS', changedById: userId },
    })
    await logEvent('TaskClaimed', 'Task', req.params.id, userId)
    await publishOutbox('Task', req.params.id, 'TaskClaimed', { taskId: req.params.id, claimedById: userId })
    void updatedItem
    res.json(task)
  } catch (err) {
    next(err)
  }
})

tasksRouter.post('/:id/complete', async (req, res, next) => {
  try {
    const userId = req.user!.userId
    const task = await prisma.task.findUnique({ where: { id: req.params.id } })
    if (!task) throw new NotFoundError('Task', req.params.id)

    const updated = await prisma.task.update({
      where: { id: req.params.id },
      data: { status: 'COMPLETED' },
      include: { assignments: true },
    })
    await prisma.taskStatusHistory.create({
      data: {
        taskId: req.params.id,
        previousStatus: task.status,
        newStatus: 'COMPLETED',
        changedById: userId,
      },
    })

    const eventId = await logEvent('TaskCompleted', 'Task', req.params.id, userId)
    await createReceipt('TASK_COMPLETED', 'Task', req.params.id, {
      taskId: req.params.id,
      completedBy: userId,
      instanceId: task.instanceId,
    }, eventId)
    await publishOutbox('Task', req.params.id, 'TaskCompleted', { taskId: req.params.id })

    // Advance workflow if task is linked to a node
    if (task.nodeId && task.instanceId) {
      const output = (req.body as Record<string, unknown>).output as Record<string, unknown> | undefined
      try {
        const { advance } = await import('../workflow/runtime/WorkflowRuntime')
        await advance(task.instanceId, task.nodeId, output ?? {}, userId)
      } catch (advanceErr) {
        console.error('Workflow advance failed after task completion:', advanceErr)
      }
    }

    res.json(updated)
  } catch (err) {
    next(err)
  }
})

tasksRouter.post('/:id/assign', async (req, res, next) => {
  try {
    const { assignedToId, teamId } = z.object({
      assignedToId: z.string().uuid().optional(),
      teamId: z.string().uuid().optional(),
    }).parse(req.body)

    if (assignedToId) {
      await prisma.taskAssignment.create({ data: { taskId: req.params.id, assignedToId } })
    }
    if (teamId) {
      await prisma.teamQueueItem.create({ data: { taskId: req.params.id, teamId } })
    }

    const task = await prisma.task.findUnique({
      where: { id: req.params.id },
      include: { assignments: true, queueItems: true },
    })
    res.json(task)
  } catch (err) {
    next(err)
  }
})

tasksRouter.post('/:id/comments', async (req, res, next) => {
  try {
    const { content } = z.object({ content: z.string().min(1) }).parse(req.body)
    const comment = await prisma.taskComment.create({
      data: { taskId: req.params.id, authorId: req.user!.userId, content },
    })
    res.status(201).json(comment)
  } catch (err) {
    next(err)
  }
})

// ─── Human Task Form Submission (Gap #21) ─────────────────────────────────────

const formSubmissionSchema = z.object({
  // Arbitrary form data conforming to the node's formSchema
  data: z.record(z.unknown()),
  // Document IDs already uploaded via /api/documents/upload — linked to this task on submit
  attachmentIds: z.array(z.string().uuid()).optional(),
  // If true, also marks the task COMPLETED and advances the workflow node
  complete: z.boolean().default(false),
})

tasksRouter.post('/:id/form-submission', validate(formSubmissionSchema), async (req, res, next) => {
  try {
    const id = req.params.id as string
    const { data, attachmentIds, complete } = req.body as z.infer<typeof formSubmissionSchema>

    const task = await prisma.task.findUnique({ where: { id } })
    if (!task) {
      res.status(404).json({ error: 'Task not found' })
      return
    }

    // Persist form data
    const updated = await prisma.task.update({
      where: { id },
      data: { formData: data as unknown as import('@prisma/client').Prisma.InputJsonValue },
    })

    // Finalize attachment links (caller may have uploaded with taskId already set;
    // this guarantees linkage for any docs uploaded before the task existed).
    if (attachmentIds && attachmentIds.length > 0) {
      await prisma.document.updateMany({
        where: { id: { in: attachmentIds } },
        data: {
          taskId:     id,
          nodeId:     task.nodeId,
          instanceId: task.instanceId,
        },
      })
    }

    await logEvent('TaskFormSubmitted', 'Task', id, req.user!.userId, {
      instanceId: task.instanceId,
      nodeId: task.nodeId,
      attachmentCount: attachmentIds?.length ?? 0,
      complete,
    })

    if (complete) {
      // Reuse the complete flow: mark IN_PROGRESS → COMPLETED and advance workflow
      await prisma.task.update({
        where: { id },
        data: {
          status: 'COMPLETED',
          statusHistory: {
            create: {
              previousStatus: task.status,
              newStatus: 'COMPLETED',
              changedById: req.user!.userId,
              reason: 'form_submitted',
            },
          },
        },
      })

      await publishOutbox('Task', id, 'TaskCompleted', { taskId: id })

      if (task.nodeId && task.instanceId) {
        try {
          const { advance } = await import('../workflow/runtime/WorkflowRuntime')
          await advance(
            task.instanceId,
            task.nodeId,
            { form: data, attachments: attachmentIds ?? [] },
            req.user!.userId,
          )
        } catch (advanceErr) {
          console.error('Workflow advance failed after form submission:', advanceErr)
        }
      }
    }

    res.json({ task: updated, formData: data, attachmentIds: attachmentIds ?? [], completed: complete })
  } catch (err) {
    next(err)
  }
})
