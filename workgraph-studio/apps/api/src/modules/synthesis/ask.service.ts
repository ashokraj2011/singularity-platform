/**
 * Synthesis Studio — "Ask Synthesis" sidecar (R1A 5.1). A lightweight, always-available Q&A
 * surface: ask the Facilitator a question scoped to a project (or an already-open working
 * session) and get a fast, cited answer — plus small proposal items when the ask implies a
 * change. It is a THIN composition over the agent driver: a per-project dedicated sidecar
 * WORKSPACE (kept separate from real working sessions via a reserved purpose) hosts one reused
 * ASK_SIDECAR thread, and every ask is a governed runAgentTurn(FACILITATOR). All the tenant-tx,
 * manifest, autonomy and proposal machinery is inherited unchanged — Ask adds no DB surface of
 * its own, and (because it calls only tenant-tx-wrapped services) no new RLS surface either.
 */
import type { Request } from 'express'
import { ValidationError } from '../../lib/errors'
import { createWorkspace, listWorkspaces, createThread, listThreads } from './workspace.service'
import { listMessages } from './message.service'
import { runAgentTurn, type AgentTurnResult } from './synthesis-agent.service'

// Marks a project's dedicated Ask-Synthesis workspace so it is never confused with a real
// working session. A reserved purpose is enough — no schema change, no new table.
export const ASK_SIDECAR_PURPOSE = '__ask_sidecar__'
const ASK_AGENT_ROLE = 'FACILITATOR'

const byCreatedAtAsc = <T extends { createdAt: Date | string }>(a: T, b: T) =>
  new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()

export interface AskTarget {
  workspaceId?: string
  specificationProjectId?: string
  workItemId?: string | null
}

/** Find the sidecar workspace WITHOUT creating it: an explicit session, or the project's Ask workspace. */
async function findSidecarWorkspaceId(target: AskTarget): Promise<string | null> {
  if (target.workspaceId) return target.workspaceId // ask inside an existing session (context inherited)
  if (!target.specificationProjectId) throw new ValidationError('ask requires a workspaceId or a specificationProjectId')
  const { items } = await listWorkspaces(target.specificationProjectId) // tenant-scoped; validates the project
  const existing = items.filter((w) => w.purpose === ASK_SIDECAR_PURPOSE).sort(byCreatedAtAsc)[0]
  return existing?.id ?? null
}

/** Find-or-create the project's dedicated Ask workspace (only the ask path creates). */
async function resolveSidecarWorkspaceId(target: AskTarget, userId: string): Promise<string> {
  const found = await findSidecarWorkspaceId(target)
  if (found) return found
  const created = await createWorkspace({
    specificationProjectId: target.specificationProjectId as string, // guaranteed by findSidecarWorkspaceId's guard
    workItemId: target.workItemId ?? null,
    title: 'Ask Synthesis',
    purpose: ASK_SIDECAR_PURPOSE,
  }, userId)
  return created.id
}

/** The single ASK_SIDECAR thread on a workspace, if it exists. */
async function findAskThreadId(workspaceId: string): Promise<string | null> {
  const { items } = await listThreads(workspaceId) // tenant-scoped
  return items.filter((t) => t.kind === 'ASK_SIDECAR').sort(byCreatedAtAsc)[0]?.id ?? null
}

async function resolveAskThreadId(workspaceId: string, userId: string): Promise<string> {
  const found = await findAskThreadId(workspaceId)
  if (found) return found
  const thread = await createThread(workspaceId, { kind: 'ASK_SIDECAR', agentRole: ASK_AGENT_ROLE, title: 'Ask Synthesis' }, userId)
  return thread.id
}

export interface AskResult extends AgentTurnResult {
  workspaceId: string
  threadId: string
}

export async function ask(target: AskTarget, question: string, req: Request, actor: string): Promise<AskResult> {
  const workspaceId = await resolveSidecarWorkspaceId(target, actor)
  const threadId = await resolveAskThreadId(workspaceId, actor)
  const result = await runAgentTurn(workspaceId, threadId, ASK_AGENT_ROLE, question, req, actor)
  return { ...result, workspaceId, threadId }
}

/**
 * The sidecar conversation history — READ-ONLY: if the project has never been asked, this
 * returns an empty transcript without creating a workspace or thread (a GET must not mutate).
 */
export async function askHistory(target: AskTarget, opts: { afterSeq?: number } = {}) {
  const workspaceId = await findSidecarWorkspaceId(target)
  if (!workspaceId) return { workspaceId: null, threadId: null, items: [] as unknown[] }
  const threadId = await findAskThreadId(workspaceId)
  if (!threadId) return { workspaceId, threadId: null, items: [] as unknown[] }
  const { items } = await listMessages(workspaceId, threadId, opts)
  return { workspaceId, threadId, items }
}
