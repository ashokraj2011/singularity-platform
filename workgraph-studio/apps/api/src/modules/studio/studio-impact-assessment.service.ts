import { randomUUID } from 'crypto'
import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { config } from '../../config'
import { currentTenantIdForDb, withTenantDbTransaction } from '../../lib/tenant-db-context'
import { contextFabricClient } from '../../lib/context-fabric/client'
import { listAgentTemplates } from '../../lib/agent-and-tools/client'
import { logEvent, publishOutbox } from '../../lib/audit'
import { NotFoundError } from '../../lib/errors'
import {
  capabilityImpactSystemPrompt,
  capabilityImpactTask,
  parseCapabilityImpactResult,
} from './studio-impact-assessment'

const tenantId = () => currentTenantIdForDb() ?? config.WORKGRAPH_DEFAULT_TENANT_ID

function tenantTx<T>(callback: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return withTenantDbTransaction(prisma, callback, tenantId())
}

function assignedCapabilityLink(project: {
  primaryCapabilityId: string | null
  primaryCapabilityName: string | null
  capabilityLinks: Array<{ capabilityId: string; capabilityName: string | null; role: string }>
}) {
  if (!project.primaryCapabilityId) return []
  const primary = project.capabilityLinks.find((link) =>
    link.role === 'PRIMARY' && link.capabilityId === project.primaryCapabilityId,
  )
  return [primary ?? {
    capabilityId: project.primaryCapabilityId,
    capabilityName: project.primaryCapabilityName ?? project.primaryCapabilityId,
    role: 'PRIMARY',
  }]
}

type ImpactLlmResponse = {
  text: string
  traceId: string
  totalTokens: number
  estimatedCost: number | null
}

export interface CapabilityImpactLlm {
  complete(input: {
    system: string
    task: string
    traceId: string
    actorId: string
    projectId: string
    capabilityId: string
    agentTemplateId?: string
    outputTokenBudget: number
  }): Promise<ImpactLlmResponse>
}

export const defaultCapabilityImpactLlm: CapabilityImpactLlm = {
  async complete(input) {
    const response = await contextFabricClient.executeGovernedTurn({
      trace_id: input.traceId,
      run_context: {
        project_id: input.projectId,
        capability_id: input.capabilityId,
        agent_template_id: input.agentTemplateId,
        user_id: input.actorId,
        surface: 'initiative-impact-assessment',
      },
      system_prompt: input.system,
      task: input.task,
      model_overrides: { temperature: 0.25, maxOutputTokens: input.outputTokenBudget },
      limits: { outputTokenBudget: input.outputTokenBudget, timeoutSec: 120 },
      governance_mode: 'fail_closed',
    })
    const totalTokens = response.tokensUsed?.total
      ?? response.usage?.totalTokens
      ?? response.modelUsage?.totalTokens
      ?? 0
    const estimatedCost = response.tokensUsed?.estimatedCost
      ?? response.tokensUsed?.estimated_cost
      ?? response.usage?.estimatedCost
      ?? response.modelUsage?.estimatedCost
      ?? null
    return {
      text: response.finalResponse ?? '',
      traceId: response.correlation?.traceId ?? input.traceId,
      totalTokens: Math.max(0, Math.round(totalTokens ?? 0)),
      estimatedCost: typeof estimatedCost === 'number' && Number.isFinite(estimatedCost) ? estimatedCost : null,
    }
  },
}

const assessmentSelect = {
  id: true,
  projectId: true,
  capabilityId: true,
  capabilityName: true,
  agentTemplateId: true,
  agentTemplateName: true,
  status: true,
  summary: true,
  recommendations: true,
  risks: true,
  dependencies: true,
  suggestedClaims: true,
  traceId: true,
  tokensUsed: true,
  estimatedCostUsd: true,
  error: true,
  assessedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.CapabilityImpactAssessmentSelect

export async function listCapabilityImpactAssessments(projectId: string) {
  const project = await tenantTx(tx => tx.specificationProject.findFirst({
    where: { id: projectId, tenantId: tenantId() },
    select: { id: true, primaryCapabilityId: true },
  }))
  if (!project) throw new NotFoundError('SpecificationProject', projectId)
  const items = await tenantTx(tx => tx.capabilityImpactAssessment.findMany({
    where: { projectId, tenantId: tenantId(), ...(project.primaryCapabilityId ? { capabilityId: project.primaryCapabilityId } : { capabilityId: '__none__' }) },
    select: assessmentSelect,
    orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
  }))
  return { items }
}

export async function runCapabilityImpactAssessments(
  projectId: string,
  actorId: string,
  authHeader?: string,
  llm: CapabilityImpactLlm = defaultCapabilityImpactLlm,
) {
  const project = await tenantTx(tx => tx.specificationProject.findFirst({
    where: { id: projectId, tenantId: tenantId() },
    include: { capabilityLinks: { orderBy: { role: 'asc' } } },
  }))
  if (!project) throw new NotFoundError('SpecificationProject', projectId)

  const assignedCapabilityLinks = assignedCapabilityLink(project)
  let consumedTokens = project.tokenUsed
  let consumedCost = project.costUsedUsd
  for (const link of assignedCapabilityLinks) {
    const remainingTokens = Math.max(0, project.tokenBudget - consumedTokens)
    const remainingCost = project.costBudgetUsd == null ? null : Math.max(0, project.costBudgetUsd - consumedCost)
    if (remainingTokens < 500 || remainingCost === 0) {
      const budgetError = remainingCost === 0
        ? 'Initiative cost budget is exhausted.'
        : 'Initiative token budget has fewer than 500 tokens remaining.'
      await tenantTx(tx => tx.capabilityImpactAssessment.upsert({
        where: { projectId_capabilityId: { projectId, capabilityId: link.capabilityId } },
        create: {
          projectId,
          capabilityId: link.capabilityId,
          capabilityName: link.capabilityName,
          status: 'FAILED',
          error: budgetError,
          tenantId: tenantId(),
        },
        update: { status: 'FAILED', error: budgetError },
      }))
      continue
    }

    const templates = await listAgentTemplates(authHeader, { capabilityId: link.capabilityId, limit: 100 }).catch(() => [])
    const agent = templates.find((item) => item.capabilityId === link.capabilityId && item.isActive !== false)
      ?? templates.find((item) => item.isActive !== false)
    const agentName = agent?.name ?? `${link.capabilityName ?? link.capabilityId} impact analyst`

    await tenantTx(tx => tx.capabilityImpactAssessment.upsert({
      where: { projectId_capabilityId: { projectId, capabilityId: link.capabilityId } },
      create: {
        projectId,
        capabilityId: link.capabilityId,
        capabilityName: link.capabilityName,
        agentTemplateId: agent?.id,
        agentTemplateName: agentName,
        status: 'RUNNING',
        tenantId: tenantId(),
      },
      update: {
        capabilityName: link.capabilityName,
        agentTemplateId: agent?.id ?? null,
        agentTemplateName: agentName,
        status: 'RUNNING',
        summary: null,
        recommendations: [],
        risks: [],
        dependencies: [],
        suggestedClaims: [],
        traceId: null,
        tokensUsed: 0,
        estimatedCostUsd: null,
        error: null,
        assessedAt: null,
      },
    }))

    const traceId = `initiative-impact:${projectId}:${link.capabilityId}:${randomUUID()}`
    try {
      const outputTokenBudget = Math.min(2200, Math.max(500, remainingTokens))
      const response = await llm.complete({
        system: capabilityImpactSystemPrompt(link.capabilityName ?? link.capabilityId, agentName),
        task: capabilityImpactTask({ ...project, capabilityName: link.capabilityName ?? link.capabilityId }),
        traceId,
        actorId,
        projectId,
        capabilityId: link.capabilityId,
        agentTemplateId: agent?.id,
        outputTokenBudget,
      })
      const parsed = parseCapabilityImpactResult(response.text)
      await tenantTx(async (tx) => {
        await tx.capabilityImpactAssessment.update({
          where: { projectId_capabilityId: { projectId, capabilityId: link.capabilityId } },
          data: {
            status: 'COMPLETED',
            summary: parsed.summary,
            recommendations: parsed.recommendations,
            risks: parsed.risks,
            dependencies: parsed.dependencies,
            suggestedClaims: parsed.suggestedClaims,
            traceId: response.traceId,
            tokensUsed: response.totalTokens,
            estimatedCostUsd: response.estimatedCost,
            error: null,
            assessedAt: new Date(),
          },
        })
        await tx.specificationProject.update({
          where: { id: projectId },
          data: {
            tokenUsed: { increment: response.totalTokens },
            ...(response.estimatedCost != null ? { costUsedUsd: { increment: response.estimatedCost } } : {}),
          },
        })
      })
      consumedTokens += response.totalTokens
      consumedCost += response.estimatedCost ?? 0
      await logEvent('InitiativeCapabilityImpactAssessed', 'SpecificationProject', projectId, actorId, {
        capabilityId: link.capabilityId,
        agentTemplateId: agent?.id ?? null,
        traceId: response.traceId,
      })
      await publishOutbox('SpecificationProject', projectId, 'InitiativeCapabilityImpactAssessed', {
        projectId,
        capabilityId: link.capabilityId,
        status: 'COMPLETED',
        traceId: response.traceId,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Capability impact assessment failed'
      await tenantTx(tx => tx.capabilityImpactAssessment.update({
        where: { projectId_capabilityId: { projectId, capabilityId: link.capabilityId } },
        data: { status: 'FAILED', error: message.slice(0, 2000), traceId, assessedAt: new Date() },
      }))
      await logEvent('InitiativeCapabilityImpactAssessmentFailed', 'SpecificationProject', projectId, actorId, {
        capabilityId: link.capabilityId,
        traceId,
        error: message,
      })
    }
  }

  return listCapabilityImpactAssessments(projectId)
}
