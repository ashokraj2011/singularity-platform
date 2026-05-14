import { Router, type Router as ExpressRouter } from 'express'
import { z } from 'zod'
import { contextFabricClient } from '../../lib/context-fabric/client'
import { config } from '../../config'

export const eventHorizonRouter: ExpressRouter = Router()

const bodySchema = z.object({
  message: z.string().min(1).max(4000),
  sessionId: z.string().min(1).max(200),
  app: z.string().max(120).default('Workflow Manager'),
  surface: z.string().max(160).optional(),
  path: z.string().max(500).optional(),
  capabilityId: z.string().max(120).optional(),
  actionIntent: z.enum([
    'explain_stuck_nodes',
    'summarize_run',
    'find_evidence',
    'draft_approval_note',
    'recommend_budget_model',
  ]).optional(),
  context: z.record(z.unknown()).default({}),
})

function nonBlank(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function defaultCapabilityId() {
  return nonBlank(process.env.EVENT_HORIZON_CAPABILITY_ID)
    ?? nonBlank(process.env.DEFAULT_CAPABILITY_ID)
    ?? '00000000-0000-0000-0000-00000000aaaa'
}

eventHorizonRouter.post('/chat', async (req, res) => {
  const body = bodySchema.parse(req.body)
  const capabilityId = nonBlank(body.capabilityId) || defaultCapabilityId()
  const result = await contextFabricClient.execute({
    trace_id: `event-horizon:${body.sessionId}:${Date.now()}`,
    idempotency_key: `event-horizon:${body.sessionId}:${Date.now()}`,
    run_context: {
      workflow_instance_id: `event-horizon-${body.sessionId}`,
      workflow_node_id: 'event-horizon-chat',
      agent_run_id: `event-horizon-${Date.now()}`,
      capability_id: capabilityId,
      user_id: req.user?.userId,
      trace_id: `event-horizon:${body.sessionId}`,
    },
    system_prompt: [
      'You are Event Horizon, the Singularity platform assistant.',
      'Answer from the current application context and platform facts.',
      'Be concise, practical, and governance-aware.',
      'You may recommend safe operator actions, but do not claim that a mutation was performed.',
      'Allowed action intents are explain_stuck_nodes, summarize_run, find_evidence, draft_approval_note, and recommend_budget_model.',
      'When an action intent is present, answer in that mode and cite the relevant run, budget, approval, artifact, or receipt fields from context.',
    ].join('\n'),
    task: [
      `User question: ${body.message}`,
      `Current app: ${body.app}`,
      `Current surface: ${body.surface ?? 'unknown'}`,
      `Current path: ${body.path ?? 'unknown'}`,
      `Requested safe action intent: ${body.actionIntent ?? 'answer_context_question'}`,
      `Context JSON: ${JSON.stringify(body.context).slice(0, 6000)}`,
    ].join('\n\n'),
    model_overrides: {
      provider: nonBlank(process.env.EVENT_HORIZON_PROVIDER),
      model: nonBlank(process.env.EVENT_HORIZON_MODEL),
      temperature: 0.2,
      maxOutputTokens: 700,
    },
    context_policy: {
      optimizationMode: 'aggressive',
      maxContextTokens: 4000,
      compareWithRaw: false,
    },
    limits: {
      inputTokenBudget: 4000,
      outputTokenBudget: 700,
      maxHistoryMessages: 4,
      maxSteps: 2,
      maxToolResultChars: 2000,
      maxPromptChars: 12000,
      timeoutSec: 180,
    },
    prefer_laptop: false,
  })
  res.json({
    response: result.finalResponse,
    status: result.status,
    correlation: result.correlation,
    usage: result.usage,
    warnings: result.warnings ?? [],
  })
})
