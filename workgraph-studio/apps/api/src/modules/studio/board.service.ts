/**
 * Studio Board — event-sourcing service (PR-1).
 *
 * The board's system of record is an append-only, per-branch event log with a
 * gap-free monotonic eventSeq. The BoardBranch row IS the fence: we allocate the
 * next seq under `SELECT … FOR UPDATE` (the same serialized pattern as workflow
 * checkpoints), so concurrent appends can't skip or reuse a number, backed by
 * `@@unique([branchId, eventSeq])` as a safety net. State at any point is a pure
 * fold over events from the nearest snapshot (see board-events.ts).
 *
 * Read-only past: appends only land at the branch head — the only write verb
 * available off head is fork (Part 3). Studio normally uses plain prisma, but the
 * gap-free fence needs a transaction, so appends use withTenantDbTransaction.
 */
import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { withTenantDbTransaction, currentTenantIdForDb } from '../../lib/tenant-db-context'
import { logEvent, publishOutbox } from '../../lib/audit'
import { NotFoundError, ValidationError, ConflictError } from '../../lib/errors'
import { getProject } from './studio-projects.service'
import {
  materialize, hashState, shouldCoalesce, coalescePayload, isSnapshotDue, asRecord,
  type ObjectMap, type BoardObject, type BoardEventLike,
} from './board-events'
import { parseExplorationBudget, budgetExhausted } from './board-branches'

export type BoardActor = { actorType: 'HUMAN' | 'AGENT' | 'SYSTEM'; actorId?: string | null; agentRole?: string | null }
export interface AppendEventInput {
  eventType: string
  objectIds?: string[]
  payload?: Record<string, unknown>
  causedBy?: unknown[]
  coalesceKey?: string | null
  expectedHeadSeq?: number
}

// Prisma returns BIGINT columns as JS bigint; the API speaks plain numbers
// (a branch's event count never approaches 2^53). Convert at the boundary.
type BranchRow = {
  id: string; name: string; mode: string; status: string
  parentBranchId: string | null; forkEventSeq: bigint | null; headEventSeq: bigint
  purpose: string | null; explorationBudget: Prisma.JsonValue; createdAt: Date
}
function shapeBranch(b: BranchRow) {
  return {
    id: b.id, name: b.name, mode: b.mode, status: b.status,
    parentBranchId: b.parentBranchId,
    forkEventSeq: b.forkEventSeq === null ? null : Number(b.forkEventSeq),
    headEventSeq: Number(b.headEventSeq), purpose: b.purpose,
    explorationBudget: b.explorationBudget, createdAt: b.createdAt,
  }
}
type EventRow = {
  id: string; boardId: string; branchId: string; eventSeq: bigint; eventType: string
  objectIds: Prisma.JsonValue; actorType: string; actorId: string | null; agentRole: string | null
  payload: Prisma.JsonValue; causedBy: Prisma.JsonValue; coalesceKey: string | null; createdAt: Date
}
function shapeEvent(e: EventRow) {
  return { ...e, eventSeq: Number(e.eventSeq) }
}
function eventToLike(e: EventRow): BoardEventLike {
  return {
    eventType: e.eventType, objectIds: e.objectIds, payload: asRecord(e.payload),
    actorType: e.actorType, actorId: e.actorId, coalesceKey: e.coalesceKey, createdAt: e.createdAt,
  }
}

// ── Boards ──────────────────────────────────────────────────────────────────
export async function createBoard(projectId: string, name: string, userId: string) {
  await getProject(projectId) // tenant-scoped 404 — can't create a board on a project the caller can't see
  const tenantId = currentTenantIdForDb() ?? undefined
  const board = await prisma.board.create({
    data: {
      projectId, name, createdById: userId, tenantId,
      branches: { create: { name: 'main', mode: 'HUMAN', status: 'ACTIVE', createdById: userId, tenantId } },
    },
    include: { branches: true },
  })
  await logEvent('BoardCreated', 'Board', board.id, userId, { projectId, name })
  await publishOutbox('Board', board.id, 'BoardCreated', { projectId, name })
  return shapeBoard(board)
}

export async function listBoards(projectId: string) {
  await getProject(projectId)
  const boards = await prisma.board.findMany({
    where: { projectId }, include: { branches: true }, orderBy: { createdAt: 'asc' },
  })
  return { items: boards.map(shapeBoard) }
}

function shapeBoard(b: { id: string; projectId: string; name: string; createdById: string | null; createdAt: Date; branches: BranchRow[] }) {
  return { id: b.id, projectId: b.projectId, name: b.name, createdById: b.createdById, createdAt: b.createdAt, branches: b.branches.map(shapeBranch) }
}

async function loadBoard(boardId: string) {
  const board = await prisma.board.findUnique({ where: { id: boardId }, select: { id: true } })
  if (!board) throw new NotFoundError('Board', boardId)
}
async function resolveBranch(boardId: string, branchName: string): Promise<BranchRow> {
  const branch = await prisma.boardBranch.findFirst({ where: { boardId, name: branchName } })
  if (!branch) throw new NotFoundError('BoardBranch', `${boardId}/${branchName}`)
  return branch
}

// ── Append (the fenced write path) ────────────────────────────────────────────
export async function appendEvent(boardId: string, branchName: string, input: AppendEventInput, actor: BoardActor) {
  await loadBoard(boardId)
  const tenantId = currentTenantIdForDb() ?? undefined
  const nowMs = Date.now()

  const { event, coalesced, suspended } = await withTenantDbTransaction(prisma, async (tx) => {
    // Fence: lock the branch row so exactly one appender allocates the next seq.
    const rows = await tx.$queryRaw<BranchRow[]>`
      SELECT "id", "name", "mode", "status", "parentBranchId", "forkEventSeq", "headEventSeq", "purpose", "explorationBudget", "createdAt"
      FROM "board_branches" WHERE "boardId" = ${boardId} AND "name" = ${branchName} FOR UPDATE`
    const branch = rows[0]
    if (!branch) throw new NotFoundError('BoardBranch', `${boardId}/${branchName}`)
    if (branch.status !== 'ACTIVE') {
      const why = branch.status === 'SUSPENDED' ? ' (exploration budget exhausted)' : ''
      throw new ValidationError(`Branch "${branchName}" is ${branch.status}${why} — read-only past, fork to edit.`)
    }
    const head = Number(branch.headEventSeq)
    // Read-only-past guard: reject a stale view cursor (client thought head was elsewhere).
    if (input.expectedHeadSeq !== undefined && input.expectedHeadSeq !== head) {
      throw new ConflictError(`Stale board view (expected head ${input.expectedHeadSeq}, actual ${head}) — read-only past, fork to edit.`)
    }

    // Coalesce with the branch's most recent event if key + actor + window match.
    const last = (await tx.boardEvent.findFirst({ where: { branchId: branch.id }, orderBy: { eventSeq: 'desc' } })) as EventRow | null
    const nextLike: BoardEventLike = {
      eventType: input.eventType, coalesceKey: input.coalesceKey ?? null,
      actorType: actor.actorType, actorId: actor.actorId ?? null, createdAt: new Date(nowMs),
    }
    if (last && shouldCoalesce(eventToLike(last), nextLike, nowMs)) {
      const mergedPayload = coalescePayload(asRecord(last.payload), input.payload ?? {}, input.eventType)
      const mergedIds = Array.from(new Set([...(Array.isArray(last.objectIds) ? (last.objectIds as string[]) : []), ...(input.objectIds ?? [])]))
      const updated = (await tx.boardEvent.update({
        where: { id: last.id },
        data: { payload: mergedPayload as Prisma.InputJsonValue, objectIds: mergedIds as Prisma.InputJsonValue },
      })) as EventRow
      return { event: updated, coalesced: true, suspended: false }
    }

    // Append a fresh event at head+1 and advance the fence.
    const nextSeq = BigInt(head + 1)
    const created = (await tx.boardEvent.create({
      data: {
        boardId, branchId: branch.id, eventSeq: nextSeq, eventType: input.eventType,
        objectIds: (input.objectIds ?? []) as Prisma.InputJsonValue,
        actorType: actor.actorType, actorId: actor.actorId ?? null, agentRole: actor.agentRole ?? null,
        payload: (input.payload ?? {}) as Prisma.InputJsonValue,
        causedBy: (input.causedBy ?? []) as Prisma.InputJsonValue,
        coalesceKey: input.coalesceKey ?? null, tenantId,
      },
    })) as EventRow
    // Agent-exploration branches auto-suspend once they exhaust their event budget:
    // the sandbox is one big proposal, bounded, and stops writing when spent.
    const suspended = branch.mode === 'AGENT_EXPLORATION' && budgetExhausted(parseExplorationBudget(branch.explorationBudget), head + 1)
    await tx.boardBranch.update({ where: { id: branch.id }, data: { headEventSeq: nextSeq, ...(suspended ? { status: 'SUSPENDED' } : {}) } })

    // Snapshot policy: bounded replay cost.
    const lastSnap = await tx.boardSnapshot.findFirst({ where: { branchId: branch.id }, orderBy: { eventSeq: 'desc' } })
    const due = isSnapshotDue({
      seq: head + 1,
      lastSnapshotSeq: lastSnap ? Number(lastSnap.eventSeq) : 0,
      sinceMs: lastSnap ? lastSnap.createdAt.getTime() : branch.createdAt.getTime(),
      nowMs,
    })
    if (due) {
      const { state } = await materializeInternal(tx, branch.id, head + 1)
      await tx.boardSnapshot.create({
        data: { boardId, branchId: branch.id, eventSeq: nextSeq, state: state as Prisma.InputJsonValue, stateHash: hashState(state), tenantId },
      })
    }
    return { event: created, coalesced: false, suspended }
  })

  await publishOutbox('BoardEvent', event.id, event.eventType, { boardId, branch: branchName, eventSeq: Number(event.eventSeq), coalesced })
  if (suspended) {
    await logEvent('BoardBranchSuspended', 'BoardBranch', event.branchId, actor.actorId ?? undefined, { boardId, branch: branchName, reason: 'exploration-budget-exhausted' })
    await publishOutbox('BoardBranch', event.branchId, 'BoardBranchSuspended', { boardId, branch: branchName, reason: 'exploration-budget-exhausted' })
  }
  return { ...shapeEvent(event), coalesced, suspended }
}

// ── Materialize / time-travel read ────────────────────────────────────────────
async function materializeInternal(client: Prisma.TransactionClient, branchId: string, atSeq: number, depth = 0): Promise<{ state: ObjectMap; eventSeq: number }> {
  const snap = await client.boardSnapshot.findFirst({
    where: { branchId, eventSeq: { lte: BigInt(atSeq) } }, orderBy: { eventSeq: 'desc' },
  })
  let base: ObjectMap
  let baseSeq: number
  if (snap) {
    base = (snap.state as unknown as ObjectMap) ?? {}
    baseSeq = Number(snap.eventSeq)
  } else if (depth < 64) {
    // No snapshot on this branch yet — if it's a fork, seed from the parent's state
    // AT the fork point (fork was O(1); the child reads parent snapshots below it).
    const branch = await client.boardBranch.findUnique({ where: { id: branchId }, select: { parentBranchId: true, forkEventSeq: true } })
    if (branch?.parentBranchId && branch.forkEventSeq !== null) {
      base = (await materializeInternal(client, branch.parentBranchId, Number(branch.forkEventSeq), depth + 1)).state
    } else {
      base = {}
    }
    baseSeq = 0
  } else {
    base = {}
    baseSeq = 0
  }
  const events = (await client.boardEvent.findMany({
    where: { branchId, eventSeq: { gt: BigInt(baseSeq), lte: BigInt(atSeq) } }, orderBy: { eventSeq: 'asc' },
  })) as EventRow[]
  return { state: materialize(base, events.map(eventToLike)), eventSeq: atSeq }
}

/** Time-travel read: `at` = eventSeq | ISO timestamp | undefined (=head). Read-only. */
export async function readState(boardId: string, branchName: string, at?: string) {
  await loadBoard(boardId)
  const branch = await resolveBranch(boardId, branchName)
  const head = Number(branch.headEventSeq)
  let atSeq = head
  if (at !== undefined && at !== '' && at !== 'head') {
    if (/^\d+$/.test(at)) {
      atSeq = Math.min(Number(at), head)
    } else if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(at)) {
      // Moment cursor — "jump to the moment the latency assumption was born".
      const moment = await prisma.boardMoment.findFirst({ where: { id: at, branchId: branch.id }, select: { eventSeqStart: true } })
      if (!moment) throw new NotFoundError('BoardMoment', at)
      atSeq = Math.min(Number(moment.eventSeqStart), head)
    } else {
      const d = new Date(at)
      if (Number.isNaN(d.getTime())) throw new ValidationError(`Invalid 'at' cursor: "${at}" (expected an eventSeq, moment id, or ISO timestamp).`)
      const e = await prisma.boardEvent.findFirst({ where: { branchId: branch.id, createdAt: { lte: d } }, orderBy: { eventSeq: 'desc' } })
      atSeq = e ? Number(e.eventSeq) : 0
    }
  }
  const { state } = await materializeInternal(prisma, branch.id, atSeq)
  const objects = (Object.values(state) as BoardObject[]).filter((o) => !o.deleted)
  return {
    boardId, branch: branchName, atEventSeq: atSeq, headEventSeq: head,
    readOnly: atSeq < head, stateHash: hashState(state), objects,
  }
}

/** Replay stream: events on a branch in [from, to]. */
export async function listEvents(boardId: string, branchName: string, from?: number, to?: number) {
  await loadBoard(boardId)
  const branch = await resolveBranch(boardId, branchName)
  const seqFilter: { gte?: bigint; lte?: bigint } = {}
  if (from !== undefined) seqFilter.gte = BigInt(from)
  if (to !== undefined) seqFilter.lte = BigInt(to)
  const events = (await prisma.boardEvent.findMany({
    where: { branchId: branch.id, ...(from !== undefined || to !== undefined ? { eventSeq: seqFilter } : {}) },
    orderBy: { eventSeq: 'asc' }, take: 2000,
  })) as EventRow[]
  return { items: events.map(shapeEvent), headEventSeq: Number(branch.headEventSeq) }
}

// ── Fork / branches (PR-3) ─────────────────────────────────────────────────────
export interface ForkInput {
  name: string
  fromBranch?: string
  atEventSeq?: number
  atMomentId?: string
  mode?: 'HUMAN' | 'AGENT_EXPLORATION'
  purpose?: string
  maxEvents?: number
  maxTurns?: number
}

/**
 * Fork a branch at a point in the past. O(1): no copying — we drop a forced
 * snapshot on the parent at the fork seq and the child seeds from it (its own log
 * starts fresh at seq 0, state 0 ≡ parent state at fork). This is the only write
 * verb available off head — the escape hatch from the read-only past.
 */
export async function forkBranch(boardId: string, input: ForkInput, userId: string) {
  await loadBoard(boardId)
  const fromName = input.fromBranch ?? 'main'
  const parent = await resolveBranch(boardId, fromName)
  const parentHead = Number(parent.headEventSeq)

  let forkSeq = parentHead
  if (input.atMomentId) {
    const m = await prisma.boardMoment.findFirst({ where: { id: input.atMomentId, branchId: parent.id }, select: { eventSeqStart: true } })
    if (!m) throw new NotFoundError('BoardMoment', input.atMomentId)
    forkSeq = Math.min(Number(m.eventSeqStart), parentHead)
  } else if (input.atEventSeq !== undefined) {
    forkSeq = Math.max(0, Math.min(input.atEventSeq, parentHead))
  }

  const mode = input.mode ?? 'HUMAN'
  if (mode === 'AGENT_EXPLORATION' && !input.purpose?.trim()) {
    throw new ValidationError('An AGENT_EXPLORATION branch requires a stated purpose.')
  }
  const budget = parseExplorationBudget({ maxEvents: input.maxEvents, maxTurns: input.maxTurns })
  const tenantId = currentTenantIdForDb() ?? undefined

  const branch = await withTenantDbTransaction(prisma, async (tx) => {
    const existing = await tx.boardBranch.findFirst({ where: { boardId, name: input.name }, select: { id: true } })
    if (existing) throw new ConflictError(`A branch named "${input.name}" already exists on this board.`)
    // Forced snapshot on the parent at the fork seq so the child reads it in O(1).
    if (forkSeq > 0) {
      const snapExists = await tx.boardSnapshot.findFirst({ where: { branchId: parent.id, eventSeq: BigInt(forkSeq) }, select: { id: true } })
      if (!snapExists) {
        const { state } = await materializeInternal(tx, parent.id, forkSeq)
        await tx.boardSnapshot.create({ data: { boardId, branchId: parent.id, eventSeq: BigInt(forkSeq), state: state as Prisma.InputJsonValue, stateHash: hashState(state), tenantId } })
      }
    }
    return tx.boardBranch.create({
      data: {
        boardId, name: input.name, parentBranchId: parent.id, forkEventSeq: BigInt(forkSeq),
        headEventSeq: BigInt(0), mode, purpose: input.purpose ?? null, status: 'ACTIVE',
        explorationBudget: budget as Prisma.InputJsonValue, createdById: userId, tenantId,
      },
    })
  })
  await logEvent('BoardBranchForked', 'BoardBranch', branch.id, userId, { boardId, from: fromName, forkSeq, mode })
  await publishOutbox('BoardBranch', branch.id, 'BoardBranchForked', { boardId, name: input.name, from: fromName, forkSeq, mode })
  return shapeBranch(branch)
}

export async function listBranches(boardId: string) {
  await loadBoard(boardId)
  const branches = await prisma.boardBranch.findMany({ where: { boardId }, orderBy: { createdAt: 'asc' } })
  return { items: branches.map((b) => shapeBranch(b)) }
}

export async function abandonBranch(boardId: string, branchName: string, userId: string) {
  await loadBoard(boardId)
  const branch = await resolveBranch(boardId, branchName)
  if (branch.name === 'main') throw new ValidationError('The main branch cannot be abandoned.')
  const updated = await prisma.boardBranch.update({ where: { id: branch.id }, data: { status: 'ABANDONED' } })
  await logEvent('BoardBranchAbandoned', 'BoardBranch', branch.id, userId, { boardId, branch: branchName })
  await publishOutbox('BoardBranch', branch.id, 'BoardBranchAbandoned', { boardId, branch: branchName })
  return shapeBranch(updated)
}
