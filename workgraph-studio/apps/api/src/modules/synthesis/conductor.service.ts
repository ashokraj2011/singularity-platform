/**
 * Synthesis Studio conductor.
 *
 * This is intentionally a deterministic router, not another agent persona. It
 * records the route decision in the existing fenced thread and delegates the
 * actual work to runAgentTurn, so manifests, permissions, proposals, receipts,
 * and failure handling remain on the established governed path.
 */
import type { Request } from 'express'
import { randomUUID } from 'node:crypto'
import { listContextRefs } from './context-reference.service'
import { listDocuments } from './document.service'
import { listMessages, appendMessage } from './message.service'
import { listProposals } from './proposal.service'
import { getWorkspace } from './workspace.service'
import { runAgentTurn, type AgentTurnResult } from './synthesis-agent.service'

export type ConductorPhase = 'FRAME' | 'EVIDENCE' | 'DECIDE' | 'SPECIFY' | 'GENERATE' | 'QUESTION' | 'CHITCHAT'
export type ConductorRoute = 'QUESTION' | 'EVIDENCE' | 'SPECIFY' | 'GENERATE' | 'CONVERSATION'

export interface ConductorDecision {
  route: ConductorRoute
  phase: ConductorPhase
  agentRole: 'FACILITATOR' | 'EVIDENCE_CURATOR' | 'REQUIREMENTS_EDITOR'
  reason: string
}

const matches = (text: string, pattern: RegExp) => pattern.test(text)

/** Stable, inspectable routing rules. More advanced classification can be added behind this contract. */
export function classifyConductorTurn(text: string): ConductorDecision {
  const normalized = text.trim()
  if (matches(normalized, /^(what|why|how|when|where|who|which|can|could|should|is|are|do|does|will)\b/i) || /\?\s*$/.test(normalized)) {
    return { route: 'QUESTION', phase: 'QUESTION', agentRole: 'FACILITATOR', reason: 'The turn is interrogative and stays in the initiative context.' }
  }
  if (matches(normalized, /\b(evidence|source|document|fact|claim|research|contradiction|validate|validation)\b/i)) {
    return { route: 'EVIDENCE', phase: 'EVIDENCE', agentRole: 'EVIDENCE_CURATOR', reason: 'The turn references evidence, sources, or validation.' }
  }
  if (matches(normalized, /\b(requirement|acceptance|scope|specification|spec|api|schema|criteria|constraint)\b/i)) {
    return { route: 'SPECIFY', phase: 'SPECIFY', agentRole: 'REQUIREMENTS_EDITOR', reason: 'The turn shapes a requirement, specification, or acceptance contract.' }
  }
  if (matches(normalized, /\b(generate|break down|work item|work-items|plan|implement|delivery|build)\b/i)) {
    return { route: 'GENERATE', phase: 'GENERATE', agentRole: 'REQUIREMENTS_EDITOR', reason: 'The turn asks to turn the initiative into executable work.' }
  }
  return { route: 'CONVERSATION', phase: 'FRAME', agentRole: 'FACILITATOR', reason: 'The turn establishes or reframes the initiative.' }
}

export interface ConductorResult extends AgentTurnResult {
  decision: ConductorDecision
}

export async function converse(
  workspaceId: string,
  threadId: string,
  text: string,
  req: Request,
  actor: string,
): Promise<ConductorResult> {
  const decision = classifyConductorTurn(text)
  await appendMessage(workspaceId, threadId, {
    role: 'SYSTEM',
    authorType: 'SYSTEM',
    content: {
      kind: 'SYSTEM_STATE',
      state: 'ROUTED',
      route: decision.route,
      phase: decision.phase,
      agentRole: decision.agentRole,
      reason: decision.reason,
    },
    correlation: { conductorDecision: decision, generatedAt: new Date().toISOString() },
    coalesceKey: `conductor-route:${threadId}:${randomUUID()}`,
  })
  const result = await runAgentTurn(workspaceId, threadId, decision.agentRole, text, req, actor)
  return { ...result, decision }
}

export async function getPane(workspaceId: string) {
  const [workspace, refs, documents, proposals] = await Promise.all([
    getWorkspace(workspaceId),
    listContextRefs(workspaceId),
    listDocuments({ workspaceId }),
    listProposals(workspaceId),
  ])
  const pendingProposals = proposals.items.reduce((total, proposal) => total + proposal.items.filter((item) => item.status === 'PENDING').length, 0)
  const phase: ConductorPhase = pendingProposals > 0
    ? 'DECIDE'
    : documents.items.length > 0
      ? 'SPECIFY'
      : refs.items.length > 0
        ? 'EVIDENCE'
        : 'FRAME'
  const nextAction = pendingProposals > 0
    ? 'Review the pending proposal before changing the initiative.'
    : documents.items.length === 0
      ? 'Add a source or create the first working document.'
      : refs.items.length === 0
        ? 'Ground the session with a claim, source, or decision reference.'
        : 'Continue the conversation to refine the next durable decision.'
  return {
    workspace: {
      id: workspace.id,
      title: workspace.title,
      status: workspace.status,
      specificationProjectId: workspace.specificationProjectId,
      workItemId: workspace.workItemId,
      lastActivityAt: workspace.lastActivityAt,
    },
    phase,
    nextAction,
    counts: {
      contextRefs: refs.items.length,
      documents: documents.items.length,
      proposals: proposals.items.length,
      pendingProposalItems: pendingProposals,
    },
    documents: documents.items.slice(0, 8),
    proposals: proposals.items.slice(0, 8),
  }
}

export async function getThreadSnapshot(workspaceId: string, threadId: string) {
  const messages = await listMessages(workspaceId, threadId)
  return { items: messages.items, headSeq: messages.items.at(-1)?.seq ?? 0 }
}
