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
import { createBoard, listBoards } from '../studio/board.service'
import { ingest, MAX_INGEST_BYTES } from '../studio/board-ingestion.service'
import { validateBoardArtifacts } from '../experience/experience.service'
import { ValidationError } from '../../lib/errors'

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
  if (result.disposition.kind !== 'BLOCKED') {
    try { await appendNextActionCard(workspaceId, threadId, decision) } catch { /* cards are advisory; the governed turn remains durable */ }
  }
  return { ...result, decision }
}

type StudioCard = {
  cardType: 'SCAFFOLD_REVIEW' | 'GATE' | 'PLAN'
  text: string
  payload: Record<string, unknown>
  action: { label: string; href: string }
}

/** Project the next governed surface without creating a second mutation path. */
async function appendNextActionCard(workspaceId: string, threadId: string, decision: ConductorDecision) {
  const pane = await getPane(workspaceId)
  const projectId = pane.workspace.specificationProjectId
  let card: StudioCard | null = null
  if (decision.route === 'CONVERSATION' && pane.counts.documents === 0 && pane.counts.contextRefs === 0 && pane.counts.proposals === 0) {
    card = {
      cardType: 'SCAFFOLD_REVIEW',
      text: 'The initiative is framed. Review the guided intake scaffold to turn the conversation into durable evidence and a safe specification starting point.',
      payload: { status: 'ACTION_REQUIRED', projectId },
      action: { label: 'Open scaffold review', href: `/synthesis/intake?project=${encodeURIComponent(projectId)}` },
    }
  } else if (decision.route === 'SPECIFY') {
    card = {
      cardType: 'GATE',
      text: 'Specification work is ready for a human checkpoint before it becomes an execution contract.',
      payload: { status: 'ACTION_REQUIRED', projectId, checks: ['requirements', 'acceptance criteria', 'evidence coverage'] },
      action: { label: 'Review specification', href: `/synthesis/spec?project=${encodeURIComponent(projectId)}` },
    }
  } else if (decision.route === 'GENERATE') {
    card = {
      cardType: 'PLAN',
      text: 'The initiative is ready to shape into governed delivery work. Review the generation plan before applying it.',
      payload: { status: 'ACTION_REQUIRED', projectId, source: 'CONDUCTOR' },
      action: { label: 'Open generation plan', href: `/synthesis/generate?project=${encodeURIComponent(projectId)}` },
    }
  }
  if (!card) return null
  return appendMessage(workspaceId, threadId, {
    role: 'SYSTEM',
    authorType: 'SYSTEM',
    content: { kind: 'CARD', cardType: card.cardType, text: card.text, payload: card.payload, actions: [card.action] },
    correlation: { conductorCard: card.cardType, projectId },
    coalesceKey: `conductor-card:${threadId}:${card.cardType}:${pane.counts.documents}:${pane.counts.contextRefs}:${pane.counts.proposals}`,
  })
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

function documentKind(filename: string): string | null {
  const extension = filename.toLowerCase().slice(filename.lastIndexOf('.'))
  return ({
    '.txt': 'TEXT', '.md': 'MARKDOWN', '.markdown': 'MARKDOWN', '.pdf': 'PDF',
    '.docx': 'DOCX', '.pptx': 'PPTX', '.xlsx': 'XLSX',
  } as Record<string, string>)[extension] ?? null
}

export interface AttachmentInput {
  filename: string
  content: Buffer
}

/** Attach a source to the initiative and announce it in the active thread. */
export async function attachSource(workspaceId: string, threadId: string, input: AttachmentInput, actor: string) {
  if (input.content.length > MAX_INGEST_BYTES) throw new ValidationError('Source file exceeds the 500 KB ingestion limit.')
  const kind = documentKind(input.filename)
  if (!kind) throw new ValidationError('Supported source files are .txt, .md, .pdf, .docx, .pptx, and .xlsx.')
  const workspace = await getWorkspace(workspaceId)
  const boards = await listBoards(workspace.specificationProjectId)
  const board = boards.items[0] ?? await createBoard(workspace.specificationProjectId, 'Synthesis Sources', actor)
  const artifact = await ingest(board.id, 'main', {
    kind,
    filename: input.filename,
    content: input.content,
  }, { actorId: actor })
  let report: Awaited<ReturnType<typeof validateBoardArtifacts>> | null = null
  try { report = await validateBoardArtifacts(board.id, actor) } catch { /* upload remains durable; validation is retryable from Source Intake */ }
  const message = await appendMessage(workspaceId, threadId, {
    role: 'SYSTEM',
    authorType: 'SYSTEM',
    content: {
      kind: 'ATTACHMENT',
      attachment: {
        artifactId: artifact.id,
        boardId: board.id,
        filename: artifact.filename,
        documentKind: artifact.kind,
        status: artifact.status,
        contentHash: artifact.contentHash,
        parseSummary: artifact.parseSummary,
      },
    },
    correlation: { artifactId: artifact.id, boardId: board.id },
    coalesceKey: `attachment:${threadId}:${artifact.contentHash}`,
  })
  let card: { message: unknown; deduped: boolean } | null = null
  if (report) {
    const tensions = Array.isArray(report.tensions) ? report.tensions : []
    const cardType = tensions.length ? 'CONTRADICTION' : 'EVIDENCE'
    const cardMessage = await appendMessage(workspaceId, threadId, {
      role: 'SYSTEM',
      authorType: 'SYSTEM',
      content: {
        kind: 'CARD',
        cardType,
        text: tensions.length
          ? `${tensions.length} cross-source contradiction${tensions.length === 1 ? '' : 's'} need human adjudication.`
          : 'The source pile has a validation report ready for review.',
        payload: { reportId: report.id, boardId: board.id, tensionCount: tensions.length, status: tensions.length ? 'ACTION_REQUIRED' : 'READY' },
        actions: [{ label: tensions.length ? 'Review contradictions' : 'Review evidence', href: `/synthesis/intake?project=${encodeURIComponent(workspace.specificationProjectId)}&report=${encodeURIComponent(report.id)}` }],
      },
      correlation: { artifactId: artifact.id, reportId: report.id, boardId: board.id },
      coalesceKey: `evidence-report:${threadId}:${report.id}`,
    })
    card = { message: cardMessage.message, deduped: cardMessage.deduped }
  }
  return { artifact, message: message.message, boardId: board.id, deduped: message.deduped, card }
}
