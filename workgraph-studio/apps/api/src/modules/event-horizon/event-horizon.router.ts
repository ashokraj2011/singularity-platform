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

const PLATFORM_CONTEXT = {
  name: 'Singularity',
  promise: 'A governed agent operating system for capability-scoped work: workflows, agents, prompt context, MCP local execution, budgets, approvals, artifacts, and audit receipts.',
  primaryMentalModel: 'Capability + Workflow + Budget Preset + Model Alias + MCP Workspace',
  apps: [
    { name: 'Operations Portal', url: 'http://localhost:5180', owns: 'setup center, health, run audit, WorkItems, architecture diagrams, AI causality proof' },
    { name: 'Identity & Access', url: 'http://localhost:5175', owns: 'users, teams, roles, permissions, IAM capabilities, memberships' },
    { name: 'Agent Runtime', url: 'http://localhost:3000', owns: 'runtime capabilities, agent templates, agent studio, tools, prompt profiles, knowledge, learning review' },
    { name: 'Workflow Manager', url: 'http://localhost:5174', owns: 'workflow design, workflow runs, runtime inbox, approvals, run insights, budgets, WorkItems, consumables' },
    { name: 'Blueprint Workbench', url: 'http://localhost:5176', owns: 'staged agent work, human gates, artifact refinement, consumable final packs' },
  ],
  ownership: {
    IAM: 'users, teams, roles, capability identity, membership and access decisions',
    Workgraph: 'workflow templates/runs, WorkItems, approvals, consumables, run budgets and evidence',
    AgentRuntime: 'agent templates, capability runtime assets, tools, prompt profile references, knowledge and learning candidates',
    PromptComposer: 'prompt layers, context plans, citations and prompt assembly receipts',
    ContextFabric: 'execution orchestration, token governor, memory, Context Fabric receipts',
    MCP: 'local/private files, AST index, local tools, branches and commits; LLM calls go through the central gateway',
    AuditGovernance: 'audit events, policy/rate/budget receipts and governance reports',
  },
  operatorWorkflows: [
    'Create/onboard a capability, optionally from GitHub or local repo.',
    'Activate a predefined capability agent team with locked governance/verifier/security gates.',
    'Design a governed workflow or delegate work through cross-capability WorkItems.',
    'Run workflow, inspect Mission Control/Run Insights, approve pauses and artifacts.',
    'Use Workbench for staged artifacts that become Workgraph consumables.',
    'Use Operations for audit reports, architecture diagrams and AI causality proof.',
  ],
  answerRules: [
    'Use the current page context first, then platform context.',
    'Explain where data lives and which app owns the next action.',
    'When evidence is missing, say what is missing and where to verify it.',
    'Do not claim a mutation happened unless the context includes a receipt or explicit result.',
  ],
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
  const snapshot = await platformSnapshot()
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
      `Singularity platform map JSON: ${JSON.stringify(PLATFORM_CONTEXT).slice(0, 6000)}`,
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
