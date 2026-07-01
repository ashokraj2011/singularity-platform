import { Prisma, type WorkflowNode, type WorkflowInstance } from '@prisma/client'
import { prisma } from '../../../../lib/prisma'
import { withTenantDbTransaction } from '../../../../lib/tenant-db-context'
import { logEvent, publishOutbox } from '../../../../lib/audit'
import {
  analyzeWorkflowInstance,
  asPrismaJson,
  formalVerificationEnabled,
  recordFormalDisabledSkip,
  shouldBlockFormalResult,
} from '../../formal-verification'

type PolicyCheckOutput = {
  policyCheck: {
    engine: string
    status: 'PASSED' | 'BLOCKED' | 'SKIPPED'
    formalVerification?: Record<string, unknown>
    skipReason?: Record<string, unknown>
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

async function blockNode(instance: WorkflowInstance, node: WorkflowNode, output: PolicyCheckOutput, actorId?: string): Promise<void> {
  const tenantId = instance.tenantId ?? undefined
  await withTenantDbTransaction(prisma, (tx) => Promise.all([
    tx.workflowNode.update({
      where: { id: node.id },
      data: { status: 'BLOCKED', completedAt: new Date() },
    }),
    tx.workflowInstance.update({
      where: { id: instance.id },
      data: {
        status: 'PAUSED',
        context: {
          ...((instance.context ?? {}) as Record<string, unknown>),
          _blockedByPolicyCheck: output.policyCheck,
        } as Prisma.InputJsonValue,
      },
    }),
    tx.workflowMutation.create({
      data: {
        instanceId: instance.id,
        nodeId: node.id,
        mutationType: 'POLICY_CHECK_BLOCKED',
        beforeState: { status: node.status } as Prisma.InputJsonValue,
        afterState: asPrismaJson(output),
        performedById: actorId,
      },
    }),
  ]), tenantId)
  await logEvent('PolicyCheckBlocked', 'WorkflowNode', node.id, actorId, { instanceId: instance.id, output })
  await publishOutbox('WorkflowNode', node.id, 'PolicyCheckBlocked', { instanceId: instance.id, nodeId: node.id, output })
}

export async function activatePolicyCheck(
  node: WorkflowNode,
  instance: WorkflowInstance,
  actorId?: string,
): Promise<{ passed: boolean; output: PolicyCheckOutput }> {
  const engine = (cfgString(node, 'engine') ?? cfgString(node, 'policyEngine') ?? 'local_allow').toLowerCase()
  const tenantId = instance.tenantId ?? undefined

  if (engine === 'formal_verifier' || engine === 'formal-verifier') {
    if (!formalVerificationEnabled()) {
      const skipReason = await recordFormalDisabledSkip(instance, node, actorId)
      const output: PolicyCheckOutput = {
        policyCheck: { engine: 'formal_verifier', status: 'SKIPPED', skipReason },
      }
      const now = new Date()
      await withTenantDbTransaction(prisma, (tx) => tx.workflowNode.update({
        where: { id: node.id },
        data: { status: 'COMPLETED', startedAt: node.startedAt ?? now, completedAt: now },
      }), tenantId)
      return { passed: true, output }
    }

    const analysis = await analyzeWorkflowInstance(instance.id, actorId, node.id, tenantId)
    const output: PolicyCheckOutput = {
      policyCheck: {
        engine: 'formal_verifier',
        status: shouldBlockFormalResult(analysis.result, node.config) ? 'BLOCKED' : 'PASSED',
        formalVerification: analysis as Record<string, unknown>,
      },
    }
    if (output.policyCheck.status === 'BLOCKED') {
      await blockNode(instance, node, output, actorId)
      return { passed: false, output }
    }
    const now = new Date()
    await withTenantDbTransaction(prisma, (tx) => tx.workflowNode.update({
      where: { id: node.id },
      data: { status: 'COMPLETED', startedAt: node.startedAt ?? now, completedAt: now },
    }), tenantId)
    return { passed: true, output }
  }

  const now = new Date()
  await withTenantDbTransaction(prisma, (tx) => tx.workflowNode.update({
    where: { id: node.id },
    data: { status: 'COMPLETED', startedAt: now, completedAt: now },
  }), tenantId)
  return {
    passed: true,
    output: { policyCheck: { engine, status: 'PASSED' } },
  }
}
