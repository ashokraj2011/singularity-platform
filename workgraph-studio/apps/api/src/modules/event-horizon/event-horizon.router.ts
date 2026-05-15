import { Router, type Router as ExpressRouter } from 'express'
import { z } from 'zod'
import { contextFabricClient } from '../../lib/context-fabric/client'
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

async function platformSnapshot() {
  try {
    const [workflowTemplates, activeRuns, pendingApprovals, workItems, consumables] = await Promise.all([
      prisma.workflow.count(),
      prisma.workflowInstance.count({ where: { status: { in: ['ACTIVE', 'PAUSED'] } } }),
      prisma.approvalRequest.count({ where: { status: 'PENDING' } }),
      prisma.workItem.count({ where: { status: { in: ['QUEUED', 'CLAIMED', 'STARTED', 'WAITING_APPROVAL', 'REWORK'] } } }),
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
    system_prompt: [
      'You are Event Horizon, the Singularity platform assistant.',
      'You understand the entire Singularity application: Operations Portal, IAM, Agent Runtime, Workflow Manager, Blueprint Workbench, Prompt Composer, Context Fabric, MCP, and Audit Governance.',
      'Answer from the current application context, then from the platform map and live summary.',
      'Be concise, practical, and governance-aware.',
      'You may recommend safe operator actions, but do not claim that a mutation was performed.',
      'Allowed action intents are explain_stuck_nodes, summarize_run, find_evidence, draft_approval_note, and recommend_budget_model.',
      'When an action intent is present, answer in that mode and cite the relevant run, budget, approval, artifact, or receipt fields from context.',
      'If a user asks where to do something, name the owning application and give the safest next screen/action.',
      'If evidence is incomplete, call that out explicitly instead of overclaiming.',
    ].join('\n'),
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
