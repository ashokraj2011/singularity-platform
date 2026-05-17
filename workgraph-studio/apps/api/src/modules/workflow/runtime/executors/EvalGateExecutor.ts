import { Prisma, type WorkflowInstance, type WorkflowNode } from '@prisma/client'
import { prisma } from '../../../../lib/prisma'
import { logEvent, publishOutbox } from '../../../../lib/audit'
import { postJson } from '../../../../lib/audit-gov/client'

type EvalRunResponse = {
  id: string
  mode: 'TRACE' | 'DATASET'
  trace_id?: string | null
  dataset_id?: string | null
  status: string
  passed_count: number
  failed_count: number
  pass_rate: number
  results?: Array<{
    evaluator_id: string
    trace_id?: string
    dataset_example_id?: string
    passed: boolean
    reason: string
  }>
}

type EvalGateOutput = {
  evalGate: {
    status: 'PASSED' | 'BLOCKED'
    scope: string
    minPassRate: number
    passRate: number
    passedCount: number
    failedCount: number
    evalRunIds: string[]
    traceIds: string[]
    datasetId?: string
    missingEvidence: string[]
    results: EvalRunResponse[]
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function cfgValue(node: WorkflowNode, key: string): unknown {
  const cfg = isRecord(node.config) ? node.config : {}
  const standard = isRecord(cfg.standard) ? cfg.standard : {}
  return cfg[key] ?? standard[key]
}

function cfgString(node: WorkflowNode, key: string): string | undefined {
  const value = cfgValue(node, key)
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function cfgNumber(node: WorkflowNode, key: string, fallback: number): number {
  const value = cfgValue(node, key)
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(n) ? n : fallback
}

function cfgBool(node: WorkflowNode, key: string, fallback: boolean): boolean {
  const value = cfgValue(node, key)
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return value === 'true'
  return fallback
}

function cfgStringArray(node: WorkflowNode, key: string): string[] {
  const value = cfgValue(node, key)
  if (Array.isArray(value)) return value.map(String).map(s => s.trim()).filter(Boolean)
  if (typeof value === 'string') return value.split(',').map(s => s.trim()).filter(Boolean)
  return []
}

async function traceIdsForInstance(instanceId: string): Promise<string[]> {
  const runs = await prisma.agentRun.findMany({
    where: { instanceId },
    select: {
      outputs: {
        where: { outputType: { in: ['EXECUTION_TRACE', 'LLM_RESPONSE', 'APPROVAL_REQUIRED'] } },
        select: { rawContent: true, structuredPayload: true },
      },
    },
  })
  const ids = new Set<string>()
  for (const run of runs) {
    for (const output of run.outputs) {
      const payload = isRecord(output.structuredPayload) ? output.structuredPayload : {}
      const traceId = typeof payload.traceId === 'string' ? payload.traceId
        : typeof payload.trace_id === 'string' ? payload.trace_id
        : output.rawContent?.startsWith('wf-') ? output.rawContent
        : undefined
      if (traceId) ids.add(traceId)
    }
  }
  return Array.from(ids)
}

function summarizeRuns(results: EvalRunResponse[]): Pick<EvalGateOutput['evalGate'], 'passRate' | 'passedCount' | 'failedCount'> {
  const passedCount = results.reduce((sum, run) => sum + Number(run.passed_count ?? 0), 0)
  const failedCount = results.reduce((sum, run) => sum + Number(run.failed_count ?? 0), 0)
  const total = passedCount + failedCount
  return {
    passedCount,
    failedCount,
    passRate: total > 0 ? passedCount / total : 0,
  }
}

async function blockNode(instance: WorkflowInstance, node: WorkflowNode, output: EvalGateOutput, actorId?: string): Promise<void> {
  await prisma.$transaction([
    prisma.workflowNode.update({
      where: { id: node.id },
      data: { status: 'BLOCKED', completedAt: new Date() },
    }),
    prisma.workflowInstance.update({
      where: { id: instance.id },
      data: {
        status: 'PAUSED',
        context: {
          ...((instance.context ?? {}) as Record<string, unknown>),
          _blockedByEvalGate: output.evalGate,
        } as Prisma.InputJsonValue,
      },
    }),
    prisma.workflowMutation.create({
      data: {
        instanceId: instance.id,
        nodeId: node.id,
        mutationType: 'EVAL_GATE_BLOCKED',
        beforeState: { status: node.status } as Prisma.InputJsonValue,
        afterState: output as unknown as Prisma.InputJsonValue,
        performedById: actorId,
      },
    }),
  ])
  await logEvent('EvalGateBlocked', 'WorkflowNode', node.id, actorId, {
    instanceId: instance.id,
    output,
  })
  await publishOutbox('WorkflowNode', node.id, 'EvalGateBlocked', { instanceId: instance.id, nodeId: node.id, output })
}

export async function activateEvalGate(
  node: WorkflowNode,
  instance: WorkflowInstance,
  actorId?: string,
): Promise<{ passed: boolean; output: EvalGateOutput }> {
  const scope = (cfgString(node, 'scope') ?? 'CURRENT_RUN').toUpperCase()
  const evaluatorIds = cfgStringArray(node, 'evaluatorIds')
  const capabilityId = cfgString(node, 'capabilityId') ?? cfgString(node, 'capability_id')
  const minPassRate = Math.max(0, Math.min(1, cfgNumber(node, 'minPassRate', 1)))
  const blockOnMissingEvidence = cfgBool(node, 'blockOnMissingEvidence', true)
  const missingEvidence: string[] = []
  const results: EvalRunResponse[] = []
  let traceIds: string[] = []
  let datasetId: string | undefined

  if (scope === 'DATASET') {
    datasetId = cfgString(node, 'datasetId') ?? cfgString(node, 'dataset_id')
    if (!datasetId) missingEvidence.push('datasetId is required for DATASET scope')
    else {
      const run = await postJson<EvalRunResponse>('api/v1/engine/evaluators/run-dataset', {
        datasetId,
        evaluatorIds,
        capabilityId,
        metadata: { workflowInstanceId: instance.id, workflowNodeId: node.id },
      })
      if (run) results.push(run)
      else missingEvidence.push('audit-governance evaluator runner was unavailable')
    }
  } else {
    traceIds = scope === 'TRACE'
      ? [cfgString(node, 'traceId') ?? cfgString(node, 'trace_id')].filter((value): value is string => Boolean(value))
      : await traceIdsForInstance(instance.id)
    if (traceIds.length === 0) missingEvidence.push('No trace ids were found for this workflow run')
    for (const traceId of traceIds) {
      const run = await postJson<EvalRunResponse>('api/v1/engine/evaluators/run-trace', {
        traceId,
        evaluatorIds,
        capabilityId,
        metadata: { workflowInstanceId: instance.id, workflowNodeId: node.id },
      })
      if (run) results.push(run)
      else missingEvidence.push(`audit-governance evaluator runner was unavailable for trace ${traceId}`)
    }
  }

  const summary = summarizeRuns(results)
  if (results.length > 0 && results.every(run => (run.results?.length ?? 0) === 0)) {
    missingEvidence.push('No evaluator results were produced')
  }
  const passed = results.length > 0
    && summary.passRate >= minPassRate
    && (!blockOnMissingEvidence || missingEvidence.length === 0)
  const output: EvalGateOutput = {
    evalGate: {
      status: passed ? 'PASSED' : 'BLOCKED',
      scope,
      minPassRate,
      passRate: summary.passRate,
      passedCount: summary.passedCount,
      failedCount: summary.failedCount,
      evalRunIds: results.map(run => run.id),
      traceIds,
      datasetId,
      missingEvidence,
      results,
    },
  }

  if (!passed) {
    await blockNode(instance, node, output, actorId)
  } else {
    await logEvent('EvalGatePassed', 'WorkflowNode', node.id, actorId, {
      instanceId: instance.id,
      output,
    })
    await publishOutbox('WorkflowNode', node.id, 'EvalGatePassed', { instanceId: instance.id, nodeId: node.id, output })
  }

  return { passed, output }
}
