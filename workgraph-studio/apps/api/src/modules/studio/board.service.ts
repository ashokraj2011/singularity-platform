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
  purpose: string | null; createdAt: Date
}
function shapeBranch(b: BranchRow) {
  return {
    id: b.id, name: b.name, mode: b.mode, status: b.status,
    parentBranchId: b.parentBranchId,
    forkEventSeq: b.forkEventSeq === null ? null : Number(b.forkEventSeq),
    headEventSeq: Number(b.headEventSeq), purpose: b.purpose, createdAt: b.createdAt,
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

  const { event, coalesced } = await withTenantDbTransaction(prisma, async (tx) => {
    // Fence: lock the branch row so exactly one appender allocates the next seq.
    const rows = await tx.$queryRaw<BranchRow[]>`
      SELECT "id", "name", "mode", "status", "parentBranchId", "forkEventSeq", "headEventSeq", "purpose", "createdAt"
      FROM "board_branches" WHERE "boardId" = ${boardId} AND "name" = ${branchName} FOR UPDATE`
    const branch = rows[0]
    if (!branch) throw new NotFoundError('BoardBranch', `${boardId}/${branchName}`)
    if (branch.status !== 'ACTIVE') {
      throw new ValidationError(`Branch "${branchName}" is ${branch.status} — read-only past, fork to edit.`)
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
      return { event: updated, coalesced: true }
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
    await tx.boardBranch.update({ where: { id: branch.id }, data: { headEventSeq: nextSeq } })

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
    return { event: created, coalesced: false }
  })

  await publishOutbox('BoardEvent', event.id, event.eventType, { boardId, branch: branchName, eventSeq: Number(event.eventSeq), coalesced })
  return { ...shapeEvent(event), coalesced }
}

// ── Materialize / time-travel read ────────────────────────────────────────────
async function materializeInternal(client: Prisma.TransactionClient, branchId: string, atSeq: number): Promise<{ state: ObjectMap; eventSeq: number }> {
  const snap = await client.boardSnapshot.findFirst({
    where: { branchId, eventSeq: { lte: BigInt(atSeq) } }, orderBy: { eventSeq: 'desc' },
  })
  const base: ObjectMap = (snap?.state as unknown as ObjectMap) ?? {}
  const baseSeq = snap ? Number(snap.eventSeq) : 0
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
