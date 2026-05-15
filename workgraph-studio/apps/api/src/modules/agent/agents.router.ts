import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../lib/prisma'
import { validate } from '../../middleware/validate'
import { GatewayProvider } from './llm/GatewayProvider'
import { NotFoundError } from '../../lib/errors'
import { logEvent, createReceipt, publishOutbox } from '../../lib/audit'

export const agentsRouter: Router = Router()

const llmProvider = new GatewayProvider()

// M10 — local Agent CRUD removed. Agents are snapshots of agent-and-tools
// templates created on demand by AgentTaskExecutor. Use the agent-and-tools
// admin UI (or POST /api/v1/agents/templates on agent-runtime) to author new
// templates; pick them via /api/lookup/agent-templates.
agentsRouter.post('/', (_req, res) => {
  res.status(410).json({
    code: 'GONE',
    message:
      'Local agent creation is removed in M10. Author templates in agent-and-tools and pick them with /api/lookup/agent-templates.',
  })
})

agentsRouter.get('/', async (_req, res, next) => {
  try {
    const agents = await prisma.agent.findMany({
      include: { skills: { include: { skill: true } } },
      orderBy: { name: 'asc' },
    })
    res.json(agents)
  } catch (err) {
    next(err)
  }
})

agentsRouter.get('/:id', async (req, res, next) => {
  try {
    const agent = await prisma.agent.findUnique({
      where: { id: req.params.id },
      include: { skills: { include: { skill: true } }, runs: { take: 10, orderBy: { createdAt: 'desc' } } },
    })
    if (!agent) throw new NotFoundError('Agent', req.params.id)
    res.json(agent)
  } catch (err) {
    next(err)
  }
})

const createRunSchema = z.object({
  instanceId: z.string().uuid().optional(),
  nodeId: z.string().uuid().optional(),
  instructions: z.string().min(1),
  inputPayload: z.record(z.unknown()).default({}),
})

agentsRouter.post('/:id/runs', validate(createRunSchema), async (req, res, next) => {
  try {
    const id = req.params.id as string
    const agent = await prisma.agent.findUnique({ where: { id } })
    if (!agent) throw new NotFoundError('Agent', id)

    const { instructions, inputPayload, instanceId, nodeId } = req.body as z.infer<typeof createRunSchema>

    const run = await prisma.agentRun.create({
      data: {
        agentId: id,
        instanceId,
        nodeId,
        status: 'RUNNING',
        initiatedById: req.user!.userId,
        startedAt: new Date(),
        inputs: {
          create: { inputType: 'INSTRUCTIONS', payload: { instructions, ...inputPayload } },
        },
      },
    })

    await logEvent('AgentRunStarted', 'AgentRun', run.id, req.user!.userId)

    // Execute the LLM call (async — don't await in handler for long runs)
    const messages = [{ role: 'user' as const, content: instructions }]
    llmProvider.complete({ model: agent.model, systemPrompt: agent.systemPrompt ?? undefined, messages })
      .then(async (llmResponse) => {
        await prisma.$transaction([
          prisma.agentRunOutput.create({
            data: {
              runId: run.id,
              outputType: 'DRAFT',
              rawContent: llmResponse.content,
              structuredPayload: { content: llmResponse.content },
              tokenCount: llmResponse.inputTokens + llmResponse.outputTokens,
            },
          }),
          // CRITICAL: always AWAITING_REVIEW — never auto-approve
          prisma.agentRun.update({
            where: { id: run.id },
            data: { status: 'AWAITING_REVIEW', completedAt: new Date() },
          }),
        ])
        await logEvent('AgentRunCompleted', 'AgentRun', run.id, undefined)
        await publishOutbox('AgentRun', run.id, 'AgentRunCompleted', { runId: run.id, status: 'AWAITING_REVIEW' })
      })
      .catch(async (err) => {
        await prisma.agentRun.update({
          where: { id: run.id },
          data: { status: 'FAILED' },
        })
        console.error('Agent run failed:', err)
      })

    res.status(201).json(run)
  } catch (err) {
    next(err)
  }
})
