/**
 * Synthesis Studio — the agent turn driver (R1A Agents phase). One governed turn:
 *   1. build + persist the ContextManifest (gates the run; the immutable hash is the anchor)
 *   2. record the human's turn against that manifest
 *   3. permission-inheritance (∩) → the allowed proposal-item verbs
 *   4. call contextFabricClient.executeGovernedTurn (single verbatim turn, NO server tool loop)
 *   5. parse the response into proposal-item intents; filter to ∩-allowed verbs
 *   6. autonomy ladder → disposition; material change is persisted as a PENDING proposal
 *      (never auto-applied); prohibited actions are blocked
 *   7. persist the assistant message with correlation / tokens / manifest / proposal
 * The agent NEVER mutates a domain entity here — it only emits items; application happens
 * later, on a human accept, through the typed-tool apply-registry.
 */
import type { Request } from 'express'
import { contextFabricClient } from '../../lib/context-fabric/client'
import { NotFoundError } from '../../lib/errors'
import { buildManifest } from './context-manifest.service'
import { appendMessage } from './message.service'
import { createWorkspaceProposal, type ProposalItemInput } from './proposal.service'
import { agentConfig, type AgentConfig } from './agents/registry'
import { dispositionFor, type TurnDisposition } from './autonomy'
import { effectiveTools } from './permission-inheritance'
import { parseAgentTurn, responseContract } from './agent-response'

function buildSystemPrompt(cfg: AgentConfig, allowedTools: string[], manifestSummary: unknown): string {
  return [
    cfg.persona,
    '',
    `Context manifest summary (what you may read): ${JSON.stringify(manifestSummary ?? {})}.`,
    '',
    responseContract(allowedTools),
  ].join('\n')
}

export interface AgentTurnResult {
  message: unknown
  disposition: TurnDisposition
  proposalId: string | null
  manifestId: string
}

export async function runAgentTurn(workspaceId: string, threadId: string, roleRaw: string, userTurn: string, req: Request, actor: string): Promise<AgentTurnResult> {
  const cfg = agentConfig(roleRaw)
  if (!cfg) throw new NotFoundError('AgentRole', roleRaw)

  // 1-2. Manifest (gates the run) + the human's turn recorded against it.
  const { manifest } = await buildManifest(workspaceId, threadId, req)
  await appendMessage(workspaceId, threadId, { role: 'USER', authorType: 'HUMAN', authorId: actor, content: { text: userTurn }, contextManifestId: manifest.id })

  // 3. Permission-inheritance (∩). v1: the surface is already studioAuthz-gated, so the
  // human-allowed set is the role's tools; a per-resource policy allow-list is a follow-on.
  const allowedTools = effectiveTools(cfg.allowedTools, cfg.allowedTools)

  // 4. Governed turn (single verbatim turn). On failure, an honest system note — no proposal.
  let responseText = ''
  let correlation: Record<string, unknown> = {}
  let tokens: Record<string, unknown> = {}
  try {
    const resp = await contextFabricClient.executeGovernedTurn({
      system_prompt: buildSystemPrompt(cfg, allowedTools, manifest.summary),
      task: userTurn,
      run_context: {
        surface: 'synthesis', workspace_id: workspaceId, thread_id: threadId,
        agent_role: cfg.role, user_id: actor, capability_id: cfg.capabilityId,
        autonomy_ceiling: cfg.autonomyCeiling, allowed_tools: allowedTools,
        context_manifest_hash: manifest.manifestHash,
      },
    })
    responseText = resp.finalResponse ?? ''
    correlation = resp.correlation as unknown as Record<string, unknown>
    tokens = (resp.tokensUsed ?? {}) as unknown as Record<string, unknown>
  } catch (err) {
    const note = await appendMessage(workspaceId, threadId, { role: 'SYSTEM', authorType: 'SYSTEM', content: { error: (err as Error).message, agentRole: cfg.role }, contextManifestId: manifest.id })
    return { message: note.message, disposition: { kind: 'BLOCKED', reason: 'governed turn failed' }, proposalId: null, manifestId: manifest.id }
  }

  // 5. Parse → items; drop anything outside the ∩-allowed verb set (defence-in-depth).
  const parsed = parseAgentTurn(responseText)
  const requestedActions = parsed.proposalItems.map((i) => i.kind)
  const allowedItems = parsed.proposalItems.filter((i) => allowedTools.includes(i.kind))

  // 6. Autonomy → disposition (prohibited blocks; material change caps at PROPOSE).
  const disposition = dispositionFor(cfg.autonomyCeiling, allowedItems.length > 0, requestedActions)

  // 7. Material change → a PENDING proposal (never auto-applied).
  let proposalId: string | null = null
  if (disposition.kind === 'PROPOSE' && allowedItems.length > 0) {
    const proposal = await createWorkspaceProposal({
      workspaceId, agentRole: cfg.role,
      items: allowedItems.map((i): ProposalItemInput => ({
        kind: i.kind, title: i.title, targetEntityType: i.targetEntityType,
        targetEntityId: i.targetEntityId, diff: i.diff, citations: i.citations, uncertainty: i.uncertainty,
      })),
    }, actor)
    proposalId = proposal.id
  }

  const assistant = await appendMessage(workspaceId, threadId, {
    role: 'ASSISTANT', authorType: 'AGENT', agentRole: cfg.role,
    content: { text: parsed.message, disposition, citations: parsed.citations },
    contextManifestId: manifest.id, proposalId, correlation, tokens,
  })
  return { message: assistant.message, disposition, proposalId, manifestId: manifest.id }
}
