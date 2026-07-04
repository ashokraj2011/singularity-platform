import { Router, type Router as ExpressRouter } from 'express'
import { z } from 'zod'
import { config } from '../../config'
import { contextFabricClient, type ExecuteRequest } from '../../lib/context-fabric/client'
// M36.4 — system_prompt now resolved from prompt-composer SystemPrompt table
import { promptComposerAuthHeaders, promptComposerClient } from '../../lib/prompt-composer/client'
import { prisma } from '../../lib/prisma'
import { withTenantDbTransaction } from '../../lib/tenant-db-context'
import { resolveLlmRouting } from '../llm-routing/resolve'
import { isJsonObject, readUpstreamJsonBody, upstreamSnippet } from '../../lib/upstream-json'

export const eventHorizonRouter: ExpressRouter = Router()

type ComposerActionEnvelope = {
  success?: boolean
  data?: unknown
  parseError?: string
  raw?: string
}

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

async function readComposerActionEnvelope(response: Response): Promise<ComposerActionEnvelope> {
  const body = await readUpstreamJsonBody(response)
  if (!body.raw.trim()) return {}
  if (body.parseError) {
    return {
      parseError: body.parseError,
      raw: upstreamSnippet(body.raw, 500),
    }
  }
  if (isJsonObject(body.data)) return body.data as ComposerActionEnvelope
  return {
    parseError: 'Prompt Composer actions returned a non-object JSON body',
    raw: upstreamSnippet(body.raw, 500),
  }
}

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
    // RLS Phase 2 — DELIBERATE SEMANTIC CHANGE: the three RLS-scoped counts
    // (active runs, pending approvals, consumables) are now scoped to the request
    // tenant via the ALS default (this runs inside the /chat request context).
    // Rationale: under FORCE RLS a bare cross-tenant count would fail-closed to 0,
    // and surfacing platform-wide totals into a single tenant's chat is a
    // cross-tenant leak — so a tenant user's "platform overview" becomes THEIR
    // tenant's overview. If Event Horizon is meant to be a global ops view, this
    // is the spot to switch these three to adminPrisma (a deliberate bypass).
    // workflow/workItem counts are non-RLS tables and stay platform-wide.
    const [workflowTemplates, activeRuns, pendingApprovals, workItems, consumables] = await Promise.all([
      prisma.workflow.count(),
      withTenantDbTransaction(prisma, (tx) => tx.workflowInstance.count({ where: { status: { in: ['ACTIVE', 'PAUSED'] } } })),
      withTenantDbTransaction(prisma, (tx) => tx.approvalRequest.count({ where: { status: 'PENDING' } })),
      prisma.workItem.count({ where: { status: { in: ['QUEUED', 'IN_PROGRESS', 'AWAITING_PARENT_APPROVAL'] } } }),
      withTenantDbTransaction(prisma, (tx) => tx.consumable.count()),
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
    const r = await fetch(url, {
      headers: await promptComposerAuthHeaders(),
      signal: AbortSignal.timeout(10_000),
    })
    if (!r.ok) {
      const text = await r.text().catch(() => '')
      return res.status(r.status).json({ error: 'composer fetch failed', detail: text.slice(0, 300) })
    }
    const json = await readComposerActionEnvelope(r)
    if (json.parseError) {
      return res.status(502).json({ error: 'composer actions invalid response', detail: json.parseError, raw: json.raw })
    }
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
  // LLM routing: the CHAT touch point may be wired to a specific connection (per
  // user / capability / default) in the routing canvas; fall back to the env default.
  const routedAlias = await resolveLlmRouting('CHAT', { userId: req.user?.userId, capabilityId })
  const executeReq: ExecuteRequest = {
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
      modelAlias: routedAlias ?? eventHorizonModelAlias(),
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
  }
  // EH chat is single-shot Q&A with a PROVIDED system prompt, so it routes
  // through the governed SINGLE-TURN path (governed audit + posture, prompt
  // used verbatim), not the multi-phase stage loop. The legacy /execute
  // fallback remains only for incident recovery.
  let result
  if (config.CONTEXT_FABRIC_GOVERN_SIDE_CALLERS) {
    result = await contextFabricClient.executeGovernedTurn({
      trace_id: executeReq.trace_id,
      run_context: executeReq.run_context as unknown as Record<string, unknown>,
      system_prompt: executeReq.system_prompt,
      task: executeReq.task,
      model_overrides: executeReq.model_overrides,
      limits: { outputTokenBudget: executeReq.limits?.outputTokenBudget },
    })
  } else {
    result = await contextFabricClient.execute(executeReq)
  }
  res.json({
    response: result.finalResponse,
    status: result.status,
    correlation: result.correlation,
    usage: result.usage,
    warnings: result.warnings ?? [],
  })
})
