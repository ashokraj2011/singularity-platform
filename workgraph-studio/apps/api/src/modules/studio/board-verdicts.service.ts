/**
 * Studio Board — AgentVerdicts service (PR-5). Agents CHALLENGE / ENDORSE / FLAG
 * human work but never change its status. Anti-nag: at most one OPEN verdict per
 * (target, agent, stance) — a friendly pre-check plus the DB partial-unique index as
 * the race backstop. Dismissing requires a recorded reason (that reason is the audit).
 * Agent writes are gated to a service principal at the router; humans answer/dismiss.
 */
import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { currentTenantIdForDb } from '../../lib/tenant-db-context'
import { logEvent, publishOutbox } from '../../lib/audit'
import { NotFoundError, ValidationError, ConflictError } from '../../lib/errors'
import { nextVerdictStatus, isTerminal, type VerdictInput, type VerdictAction, type VerdictStatus } from './board-verdicts'

export interface VerdictActor { actorType: 'AGENT' | 'HUMAN'; agentRole: string; actorId?: string | null; traceId?: string | null }

type VerdictRow = {
  id: string; boardId: string | null; targetType: string; targetRef: string; actorType: string
  agentRole: string; stance: string; rationale: string; evidenceRefs: Prisma.JsonValue
  resolvesWith: string | null; confidence: number; status: string
  answeredById: string | null; answerNote: string | null; createdAt: Date; resolvedAt: Date | null
}
function shape(v: VerdictRow) {
  return {
    id: v.id, boardId: v.boardId, targetType: v.targetType, targetRef: v.targetRef, actorType: v.actorType,
    agentRole: v.agentRole, stance: v.stance, rationale: v.rationale, evidenceRefs: v.evidenceRefs,
    resolvesWith: v.resolvesWith, confidence: v.confidence, status: v.status,
    answeredById: v.answeredById, answerNote: v.answerNote, createdAt: v.createdAt, resolvedAt: v.resolvedAt,
  }
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

async function loadVerdict(id: string): Promise<VerdictRow> {
  const v = (await prisma.agentVerdict.findUnique({ where: { id } })) as VerdictRow | null
  if (!v) throw new NotFoundError('AgentVerdict', id)
  return v
}

export async function createVerdict(input: VerdictInput, boardId: string | undefined, actor: VerdictActor) {
  const tenantId = currentTenantIdForDb() ?? undefined
  // Friendly anti-nag pre-check; the partial-unique index is the race-safe backstop.
  const existingOpen = await prisma.agentVerdict.findFirst({
    where: { targetType: input.targetType, targetRef: input.targetRef, agentRole: actor.agentRole, stance: input.stance, status: 'OPEN' },
    select: { id: true },
  })
  if (existingOpen) throw new ConflictError(`${actor.agentRole} already has an open ${input.stance} on ${input.targetType} ${input.targetRef}.`)
  try {
    const v = (await prisma.agentVerdict.create({
      data: {
        boardId: boardId ?? null, targetType: input.targetType, targetRef: input.targetRef,
        actorType: actor.actorType, agentRole: actor.agentRole, stance: input.stance,
        rationale: input.rationale, evidenceRefs: input.evidenceRefs as Prisma.InputJsonValue,
        resolvesWith: input.resolvesWith ?? null, confidence: input.confidence, status: 'OPEN',
        createdById: actor.actorId ?? null, traceId: actor.traceId ?? null, tenantId,
      },
    })) as VerdictRow
    await logEvent('AgentVerdictOpened', 'AgentVerdict', v.id, actor.actorId ?? undefined, { boardId, stance: input.stance, agentRole: actor.agentRole, targetRef: input.targetRef })
    await publishOutbox('AgentVerdict', v.id, 'AgentVerdictOpened', { boardId, stance: input.stance, agentRole: actor.agentRole, targetType: input.targetType })
    return shape(v)
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      throw new ConflictError('An open verdict for this target, agent and stance already exists.')
    }
    throw e
  }
}

async function transition(verdictId: string, action: VerdictAction, patch: { answeredById?: string; answerNote?: string }, actorId: string | undefined) {
  const v = await loadVerdict(verdictId)
  const to = nextVerdictStatus(v.status as VerdictStatus, action)
  if (!to) throw new ValidationError(`Cannot ${action} a verdict that is ${v.status}.`)
  const updated = (await prisma.agentVerdict.update({
    where: { id: verdictId },
    data: { status: to, ...patch, ...(to === 'OPEN' ? { resolvedAt: null } : isTerminal(to) ? { resolvedAt: new Date() } : {}) },
  })) as VerdictRow
  await logEvent(`AgentVerdict${cap(action)}`, 'AgentVerdict', verdictId, actorId, { to })
  await publishOutbox('AgentVerdict', verdictId, `AgentVerdict${cap(action)}`, { to })
  return shape(updated)
}

/** Human attaches counter-evidence → the challenge is ANSWERED (agent re-evaluates). */
export const answerVerdict = (id: string, note: string | undefined, userId: string) =>
  transition(id, 'answer', { answeredById: userId, ...(note ? { answerNote: note } : {}) }, userId)

/** Human dismisses — a reason is REQUIRED, and that recorded reason is the audit. */
export function dismissVerdict(id: string, note: string | undefined, userId: string) {
  if (!note?.trim()) throw new ValidationError('Dismissing a verdict requires a reason (note) — that reason is the audit trail.')
  return transition(id, 'dismiss', { answeredById: userId, answerNote: note }, userId)
}

/** Agent re-evaluated and agrees (or renews). */
export const concedeVerdict = (id: string, actorId: string) => transition(id, 'concede', {}, actorId)
export const reopenVerdict = (id: string, actorId: string) => transition(id, 'reopen', {}, actorId)

export async function listVerdicts(filter: { boardId?: string; targetType?: string; targetRef?: string; status?: string }) {
  const items = (await prisma.agentVerdict.findMany({
    where: {
      ...(filter.boardId ? { boardId: filter.boardId } : {}),
      ...(filter.targetType ? { targetType: filter.targetType } : {}),
      ...(filter.targetRef ? { targetRef: filter.targetRef } : {}),
      ...(filter.status ? { status: filter.status } : {}),
    },
    orderBy: { createdAt: 'desc' }, take: 500,
  })) as VerdictRow[]
  return { items: items.map(shape) }
}

/** CI-style gate panel: open verdicts on a board, by stance, with the challenge set. */
export async function verdictSummary(boardId: string, opts: { targetType?: string } = {}) {
  const open = (await prisma.agentVerdict.findMany({
    where: { boardId, status: 'OPEN', ...(opts.targetType ? { targetType: opts.targetType } : {}) },
    orderBy: { createdAt: 'desc' },
  })) as VerdictRow[]
  const byStance: Record<string, number> = { CHALLENGE: 0, ENDORSE: 0, FLAG: 0 }
  for (const v of open) byStance[v.stance] = (byStance[v.stance] ?? 0) + 1
  const challenges = open.filter((v) => v.stance === 'CHALLENGE')
  return {
    boardId,
    open: open.length,
    byStance,
    challenges: challenges.map(shape),
    // Gate-relevant: open challenges on requirements (policy decides if they BLOCK a lock).
    requirementChallenges: challenges.filter((v) => v.targetType === 'REQUIREMENT').length,
  }
}
