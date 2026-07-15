/**
 * DISCOVERY node executor (ADR 0006 Slice 4, server side).
 *
 * Runs a unified DiscoverySession scoped to the workflow run. It seeds the
 * node's configured questions, optionally elicits more via the governed LLM
 * gateway / Copilot (Context Fabric) + read-only MCP tools, then applies the
 * unified gate: the node PARKS (stays ACTIVE) while any blocking question is
 * OPEN and ADVANCES once every blocking question is resolved.
 *
 * The bound session id is stamped onto the node config (`_discoverySessionId`)
 * so `resumeDiscoveryNode` can advance the parked node when the last blocking
 * question is answered through the /api/discovery endpoints. Everything here is
 * best-effort and fail-closed: elicitation failures never advance a node that
 * still has open blocking questions.
 */
import type { WorkflowNode, WorkflowInstance } from '@prisma/client'
import { prisma } from '../../../../lib/prisma'
import { withTenantDbTransaction } from '../../../../lib/tenant-db-context'
import { logEvent, publishOutbox } from '../../../../lib/audit'
import { discoveryService, discoveryBridge } from '../../../discovery/discovery.deps'
import type { SeedStageQuestion } from '../../../discovery/discovery.bridge'

export const SRC_DISCOVERY_NODE = 'workflow_discovery_node'

interface DiscoveryNodeConfig {
  questions?: Array<{
    questionId?: string
    id?: string
    text?: string
    required?: boolean
    options?: unknown
    ordinal?: number
  }>
  hint?: string
  context?: string
  elicit?: boolean
  capabilityId?: string
}

function readConfig(node: WorkflowNode): DiscoveryNodeConfig {
  const cfg = (node.config ?? {}) as Record<string, unknown>
  const standard = cfg.standard && typeof cfg.standard === 'object' && !Array.isArray(cfg.standard)
    ? (cfg.standard as Record<string, unknown>)
    : {}
  const nested = cfg.discovery && typeof cfg.discovery === 'object' && !Array.isArray(cfg.discovery)
    ? (cfg.discovery as Record<string, unknown>)
    : {}
  return { ...standard, ...cfg, ...nested } as DiscoveryNodeConfig
}

async function bindSessionToNode(node: WorkflowNode, sessionId: string, tenantId?: string): Promise<void> {
  const cfg = (node.config ?? {}) as Record<string, unknown>
  if (cfg._discoverySessionId === sessionId) return
  await withTenantDbTransaction(
    prisma,
    (tx) => tx.workflowNode.update({
      where: { id: node.id },
      data: { config: { ...cfg, _discoverySessionId: sessionId } as any },
    }),
    tenantId,
  )
}

export interface DiscoveryActivationResult {
  resolved: boolean
  sessionId: string
}

export async function activateDiscoveryTask(
  node: WorkflowNode,
  instance: WorkflowInstance,
  actorId?: string,
): Promise<DiscoveryActivationResult> {
  const tenantId = instance.tenantId ?? undefined
  const cfg = readConfig(node)

  const session = await discoveryBridge.getOrCreateSession('RUN', instance.id, tenantId, actorId)
  await bindSessionToNode(node, session.id, tenantId)

  const seedQuestions: SeedStageQuestion[] = (cfg.questions ?? [])
    .map((q, i) => ({
      questionId: q.questionId ?? q.id ?? String(i),
      text: (q.text ?? '').trim(),
      required: q.required,
      options: q.options,
      ordinal: q.ordinal ?? i,
    }))
    .filter((q) => q.text.length > 0)

  if (seedQuestions.length) {
    await discoveryBridge.seedSessionQuestions({
      scopeType: 'RUN',
      scopeId: instance.id,
      tenantId,
      sourceType: SRC_DISCOVERY_NODE,
      keyPrefix: node.id,
      createdById: actorId,
      questions: seedQuestions,
    })
  }

  if (cfg.elicit) {
    try {
      await discoveryService.elicit({
        sessionId: session.id,
        userId: actorId,
        capabilityId: cfg.capabilityId,
        hint: cfg.hint,
        context: cfg.context,
        traceId: instance.id,
      })
    } catch (err: any) {
      await logEvent('DiscoveryElicitFailed', 'WorkflowInstance', instance.id, actorId, {
        nodeId: node.id,
        sessionId: session.id,
        error: err?.message,
      })
    }
  }

  const refreshed = await discoveryService.getSession(session.id)
  const resolved = refreshed?.status !== 'BLOCKED'

  await logEvent(
    resolved ? 'DiscoveryResolved' : 'DiscoveryBlocked',
    'WorkflowInstance',
    instance.id,
    actorId,
    { nodeId: node.id, sessionId: session.id, status: refreshed?.status },
  )
  await publishOutbox(
    'WorkflowInstance',
    instance.id,
    resolved ? 'DiscoveryResolved' : 'DiscoveryBlocked',
    { nodeId: node.id, sessionId: session.id },
  )

  return { resolved, sessionId: session.id }
}
