import { Router, type Router as ExpressRouter } from 'express'
import { z } from 'zod'
import { config } from '../../config'
import { contextFabricClient } from '../../lib/context-fabric/client'
// M36.4 — system_prompt now resolved from prompt-composer SystemPrompt table
import { promptComposerClient } from '../../lib/prompt-composer/client'
import { prisma } from '../../lib/prisma'

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

// M37.3 — PLATFORM_CONTEXT was a 35-line hardcoded object literal here.
// Now it lives as a JSON blob in prompt-composer's SystemPrompt table
// (key=platform.context.singularity). Fetched once per request through
// the cached getSystemPrompt() helper. Edit + re-seed to change which
// apps/owners/rules are surfaced to Event Horizon.
async function loadPlatformContext(): Promise<unknown> {
  try {
    const { content } = await promptComposerClient.getSystemPrompt('platform.context.singularity')
    return JSON.parse(content)
  } catch (err) {
    // If composer is unreachable on cold start, return a minimal stub so
    // Event Horizon still answers (it just loses the platform overview).
    return { name: 'Singularity', warning: `platform.context.singularity unavailable: ${(err as Error).message}` }
  }
}

function nonBlank(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function defaultCapabilityId() {
  return nonBlank(process.env.EVENT_HORIZON_CAPABILITY_ID)
    ?? nonBlank(process.env.DEFAULT_CAPABILITY_ID)
    ?? '00000000-0000-0000-0000-00000000aaaa'
}

function eventHorizonModelAlias() {
  return nonBlank(config.EVENT_HORIZON_MODEL_ALIAS)
    ?? nonBlank(process.env.DEFAULT_MODEL_ALIAS)
    ?? nonBlank(process.env.WORKBENCH_DEFAULT_MODEL_ALIAS)
}

async function platformSnapshot() {
  try {
    const [workflowTemplates, activeRuns, pendingApprovals, workItems, consumables] = await Promise.all([
      prisma.workflow.count(),
      prisma.workflowInstance.count({ where: { status: { in: ['ACTIVE', 'PAUSED'] } } }),
      prisma.approvalRequest.count({ where: { status: 'PENDING' } }),
      prisma.workItem.count({ where: { status: { in: ['QUEUED', 'IN_PROGRESS', 'AWAITING_PARENT_APPROVAL'] } } }),
      prisma.consumable.count(),
    ])
    return {
      ok: true,
      workflowTemplates,
      activeRuns,
      pendingApprovals,
      openWorkItems: workItems,
      consumables,
      generatedAt: new Date().toISOString(),
    }
  } catch (err) {
    return {
      ok: false,
      warning: `Workgraph summary unavailable: ${(err as Error).message}`,
      generatedAt: new Date().toISOString(),
    }
  }
}

// M36.5 — quick-action catalog proxy. SPAs hit this instead of hardcoding
// ACTIONS arrays; backend fetches from prompt-composer (singularity_composer
// DB) so a prompt engineer can edit a row and the SPA picks it up without
// a rebuild. `surface` defaults to "workflow-manager" (workgraph-web).
eventHorizonRouter.get('/actions', async (req, res) => {
  const surface = String(req.query.surface ?? 'workflow-manager').trim()
  try {
    const url = `${config.PROMPT_COMPOSER_URL.replace(/\/$/, '')}/api/v1/event-horizon-actions?surface=${encodeURIComponent(surface)}`
    const r = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    if (!r.ok) {
      const text = await r.text().catch(() => '')
      return res.status(r.status).json({ error: 'composer fetch failed', detail: text.slice(0, 300) })
    }
    const json = await r.json() as { success?: boolean; data?: unknown }
    res.json(json.data ?? [])
  } catch (err) {
    res.status(502).json({ error: 'event-horizon actions fetch failed', detail: (err as Error).message })
  }
})

eventHorizonRouter.post('/chat', async (req, res) => {
  const body = bodySchema.parse(req.body)
  const capabilityId = nonBlank(body.capabilityId) || defaultCapabilityId()
  // M37.3 — load PLATFORM_CONTEXT + snapshot in parallel.
  const [snapshot, platformContext] = await Promise.all([platformSnapshot(), loadPlatformContext()])
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
    // M36.4 — system prompt now lives in prompt-composer's SystemPrompt table
    // under the key "event-horizon.system". Edit + re-seed to change behavior.
    system_prompt: (await promptComposerClient.getSystemPrompt('event-horizon.system')).content,
    task: [
      `User question: ${body.message}`,
      `Current app: ${body.app}`,
      `Current surface: ${body.surface ?? 'unknown'}`,
      `Current path: ${body.path ?? 'unknown'}`,
      `Requested safe action intent: ${body.actionIntent ?? 'answer_context_question'}`,
      `Current page context JSON: ${JSON.stringify(body.context).slice(0, 6000)}`,
      `Singularity platform map JSON: ${JSON.stringify(platformContext).slice(0, 6000)}`,
      `Live platform summary JSON: ${JSON.stringify(snapshot).slice(0, 2000)}`,
    ].join('\n\n'),
    model_overrides: {
      modelAlias: eventHorizonModelAlias(),
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
