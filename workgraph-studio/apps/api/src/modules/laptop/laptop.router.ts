import { Router } from 'express'
import { z } from 'zod'
import { validate } from '../../middleware/validate'
import {
  answerLaptopQuestion,
  completeLaptopInvocation,
  createLaptopQuestion,
  listLaptopInvocationsForWorkItem,
  recordLaptopHeartbeat,
  startLaptopInvocation,
  streamQuestions,
  waitForLaptopQuestion,
} from './laptop.service'

export const workItemLaptopRouter: Router = Router()
export const laptopInvocationsRouter: Router = Router()
export const laptopQuestionsRouter: Router = Router()

const startSchema = z.object({
  client: z.string().min(1).optional(),
  mode: z.enum(['direct-copilot', 'server-runtime']).optional(),
  capabilityId: z.string().optional(),
  agentTemplateId: z.string().optional(),
  repoUrl: z.string().optional(),
  branch: z.string().optional(),
  baseCommitSha: z.string().optional(),
  task: z.string().optional(),
  agentSpec: z.record(z.unknown()).optional(),
  data: z.record(z.unknown()).optional(),
}).default({})

const heartbeatSchema = z.object({
  data: z.record(z.unknown()).optional(),
}).default({})

const completeSchema = z.object({
  status: z.enum(['COMPLETED', 'FAILED', 'CANCELLED']).default('COMPLETED'),
  payload: z.record(z.unknown()).optional(),
}).default({})

const questionSchema = z.object({
  question: z.string().min(1),
  context: z.record(z.unknown()).optional(),
})

const answerSchema = z.object({
  answer: z.string().min(1),
})

workItemLaptopRouter.get('/:workItemId/laptop-invocations', async (req, res, next) => {
  try {
    const items = await listLaptopInvocationsForWorkItem(String(req.params.workItemId), req.user!.userId)
    res.json({ items })
  } catch (err) {
    next(err)
  }
})

workItemLaptopRouter.post('/:workItemId/laptop-invocations', validate(startSchema), async (req, res, next) => {
  try {
    const result = await startLaptopInvocation(String(req.params.workItemId), req.user!.userId, req.body)
    res.status(201).json(result)
  } catch (err) {
    next(err)
  }
})

laptopInvocationsRouter.post('/:invocationId/heartbeat', validate(heartbeatSchema), async (req, res, next) => {
  try {
    const invocation = await recordLaptopHeartbeat(
      String(req.params.invocationId),
      req.user!.userId,
      req.body.data ?? {},
    )
    res.json(invocation)
  } catch (err) {
    next(err)
  }
})

laptopInvocationsRouter.post('/:invocationId/complete', validate(completeSchema), async (req, res, next) => {
  try {
    const invocation = await completeLaptopInvocation(
      String(req.params.invocationId),
      req.user!.userId,
      req.body.status,
      req.body.payload ?? {},
    )
    res.json(invocation)
  } catch (err) {
    next(err)
  }
})

laptopInvocationsRouter.post('/:invocationId/questions', validate(questionSchema), async (req, res, next) => {
  try {
    const question = await createLaptopQuestion(String(req.params.invocationId), req.user!.userId, req.body)
    res.status(201).json(question)
  } catch (err) {
    next(err)
  }
})

laptopInvocationsRouter.get('/:invocationId/questions/stream', async (req, res, next) => {
  const ac = new AbortController()
  try {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    req.on('close', () => ac.abort())
    res.write('event: ready\ndata: {"ok":true}\n\n')
    await streamQuestions(String(req.params.invocationId), req.user!.userId, (payload) => {
      res.write(`event: question\ndata: ${JSON.stringify(payload)}\n\n`)
    }, ac.signal)
  } catch (err) {
    if (!ac.signal.aborted) next(err)
  }
})

laptopQuestionsRouter.get('/:questionId/wait', async (req, res, next) => {
  try {
    const timeoutMs = Math.min(Math.max(Number(req.query.timeoutMs ?? 120_000) || 120_000, 1_000), 10 * 60_000)
    const question = await waitForLaptopQuestion(String(req.params.questionId), req.user!.userId, timeoutMs)
    res.json(question)
  } catch (err) {
    next(err)
  }
})

laptopQuestionsRouter.post('/:questionId/answer', validate(answerSchema), async (req, res, next) => {
  try {
    const question = await answerLaptopQuestion(String(req.params.questionId), req.user!.userId, req.body.answer)
    res.json(question)
  } catch (err) {
    next(err)
  }
})
