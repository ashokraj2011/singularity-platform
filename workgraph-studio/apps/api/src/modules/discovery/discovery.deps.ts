/**
 * Production wiring for the DiscoveryService ports (ADR 0006):
 *   store  → Prisma
 *   model  → Context Fabric governed single-turn
 *   tool   → MCP /mcp/tool-run (read-only research)
 *   routing→ shared llm-routing resolver
 *
 * Kept separate from discovery.service.ts so the service stays free of
 * infra imports and unit tests can inject fakes instead.
 */
import { config } from '../../config'
import { prisma } from '../../lib/prisma'
import { contextFabricClient } from '../../lib/context-fabric/client'
import { resolveLlmRouting } from '../llm-routing/resolve'
import { createDiscoveryService } from './discovery.service'
import { createDiscoveryBridge } from './discovery.bridge'
import type {
  DiscoveryAssumptionRecord,
  DiscoveryBudget,
  DiscoveryDeps,
  DiscoveryQuestionRecord,
  DiscoverySessionWithChildren,
  ModelCaller,
  ToolCaller,
  DiscoveryStore,
} from './discovery.types'

const prismaStore: DiscoveryStore = {
  async createSession(input) {
    const row = await prisma.discoverySession.create({
      data: {
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        touchPoint: input.touchPoint ?? 'DISCOVERY',
        createdById: input.createdById,
        tenantId: input.tenantId,
        budget: (input.budget ?? undefined) as any,
      },
    })
    return row as unknown as DiscoverySessionWithChildren
  },
  async getSession(id) {
    const row = await prisma.discoverySession.findUnique({
      where: { id },
      include: {
        questions: { orderBy: { ordinal: 'asc' } },
        assumptions: { orderBy: { createdAt: 'asc' } },
      },
    })
    return row as unknown as DiscoverySessionWithChildren | null
  },
  async findSessionByScope(scopeType, scopeId, tenantId) {
    const row = await prisma.discoverySession.findFirst({
      where: { scopeType, scopeId, ...(tenantId ? { tenantId } : {}) },
      orderBy: { createdAt: 'asc' },
    })
    return row as unknown as DiscoverySessionWithChildren | null
  },
  async updateSessionStatus(id, status) {
    await prisma.discoverySession.update({ where: { id }, data: { status } })
  },
  async updateSessionBudget(id, budget: DiscoveryBudget) {
    await prisma.discoverySession.update({ where: { id }, data: { budget: budget as any } })
  },
  async addQuestion(input) {
    const row = await prisma.discoveryQuestion.create({
      data: {
        sessionId: input.sessionId,
        tenantId: input.tenantId,
        text: input.text,
        kind: input.kind ?? 'clarification',
        source: input.source ?? 'human',
        blocking: input.blocking ?? false,
        options: (input.options ?? undefined) as any,
        proposedAnswer: input.proposedAnswer ?? null,
        confidence: input.confidence ?? null,
        ordinal: input.ordinal ?? 0,
        sourceType: input.sourceType ?? null,
        sourceId: input.sourceId ?? null,
      },
    })
    return row as unknown as DiscoveryQuestionRecord
  },
  async findQuestionByText(sessionId, text) {
    const row = await prisma.discoveryQuestion.findFirst({ where: { sessionId, text: text.trim() } })
    return row as unknown as DiscoveryQuestionRecord | null
  },
  async findQuestionBySource(sourceType, sourceId) {
    const row = await prisma.discoveryQuestion.findFirst({ where: { sourceType, sourceId } })
    return row as unknown as DiscoveryQuestionRecord | null
  },
  async getQuestion(id) {
    const row = await prisma.discoveryQuestion.findUnique({ where: { id } })
    return row as unknown as DiscoveryQuestionRecord | null
  },
  async answerQuestion(id, answer, answeredById) {
    const row = await prisma.discoveryQuestion.update({
      where: { id },
      data: { status: 'ANSWERED', answer, answeredById, answeredAt: new Date() },
    })
    return row as unknown as DiscoveryQuestionRecord
  },
  async dismissQuestion(id) {
    const row = await prisma.discoveryQuestion.update({ where: { id }, data: { status: 'DISMISSED' } })
    return row as unknown as DiscoveryQuestionRecord
  },
  async addAssumption(input) {
    const row = await prisma.discoveryAssumption.create({
      data: {
        sessionId: input.sessionId,
        tenantId: input.tenantId,
        text: input.text,
        confidence: input.confidence ?? 0.5,
        evidenceRef: (input.evidenceRef ?? undefined) as any,
      },
    })
    return row as unknown as DiscoveryAssumptionRecord
  },
  async getAssumption(id) {
    const row = await prisma.discoveryAssumption.findUnique({ where: { id } })
    return row as unknown as DiscoveryAssumptionRecord | null
  },
  async setAssumptionStatus(id, status, opts) {
    const validated = status === 'VALIDATED' || status === 'INVALIDATED'
    const row = await prisma.discoveryAssumption.update({
      where: { id },
      data: {
        status,
        validatedById: opts?.validatedById,
        validatedAt: validated ? new Date() : undefined,
        evidenceRef: (opts?.evidenceRef ?? undefined) as any,
      },
    })
    return row as unknown as DiscoveryAssumptionRecord
  },
}

const cfModelCaller: ModelCaller = {
  async governedTurn(req) {
    const res = await contextFabricClient.executeGovernedTurn({
      trace_id: req.traceId,
      system_prompt: req.systemPrompt,
      task: req.task,
      run_context: req.executor ? { executor: req.executor } : undefined,
      model_overrides: req.modelAlias ? { modelAlias: req.modelAlias } : undefined,
      limits: req.outputTokenBudget ? { outputTokenBudget: req.outputTokenBudget } : undefined,
      governance_mode: 'fail_open',
    })
    return {
      status: res.status,
      text: res.finalResponse ?? '',
      inputTokens: res.usage?.inputTokens ?? res.tokensUsed?.input ?? 0,
      outputTokens: res.usage?.outputTokens ?? res.tokensUsed?.output ?? 0,
      correlationId: res.correlation?.cfCallId,
    }
  },
}

const mcpToolCaller: ToolCaller = {
  async run(req) {
    try {
      const res = await fetch(`${config.MCP_SERVER_URL.replace(/\/$/, '')}/mcp/tool-run`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.MCP_BEARER_TOKEN}`,
        },
        body: JSON.stringify({
          tool_name: req.toolName,
          args: req.args,
          run_context: { trace_id: req.traceId, purpose: 'discovery_research' },
        }),
        signal: AbortSignal.timeout(60_000),
      })
      if (!res.ok) return { ok: false, error: `MCP tool-run ${res.status}` }
      const body = (await res.json()) as Record<string, unknown>
      if (body.tool_success === false || typeof body.error === 'string') {
        return { ok: false, error: (body.error as string) ?? 'tool failed' }
      }
      return { ok: true, data: body.result ?? body.data ?? body }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  },
}

export const discoveryDeps: DiscoveryDeps = {
  store: prismaStore,
  model: cfModelCaller,
  tool: mcpToolCaller,
  resolveRouting: resolveLlmRouting,
}

export const discoveryService = createDiscoveryService(discoveryDeps)
export const discoveryBridge = createDiscoveryBridge(prismaStore)
