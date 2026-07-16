/**
 * Studio Board — semantic merge service (PR-6). Merge is "PR review for a timeline":
 * a three-way semantic diff (fork base vs branch head vs main head), SPATIAL noise
 * auto-merges, MATERIAL changes land as a reviewable proposal batch, and each accepted
 * item is replayed onto main as a structural event tagged causedBy MERGE (authorship +
 * time provenance preserved). Conflicts are surfaced, never auto-resolved. An identical
 * stateHash short-circuits to "nothing to merge".
 */
import { prisma } from '../../lib/prisma'
import { config } from '../../config'
import { currentTenantIdForDb } from '../../lib/tenant-db-context'
import { logEvent, publishOutbox } from '../../lib/audit'
import { NotFoundError, ValidationError } from '../../lib/errors'
import { materializeBoardState, appendEvent, type AppendEventInput } from './board.service'
import { diffStates, summarizeDiff, type DiffItem } from './board-merge'
import type { ObjectMap, BoardObject } from './board-events'

// Fork base = the branch's own state at seq 0 (≡ parent state at the fork point).
async function threeWay(boardId: string, fromBranch: string, toBranch: string) {
  const base = await materializeBoardState(boardId, fromBranch, 0)
  const branch = await materializeBoardState(boardId, fromBranch)
  const main = await materializeBoardState(boardId, toBranch)
  return { base, branch, main }
}

export async function diffBranches(boardId: string, fromBranch: string, toBranch = 'main') {
  const { base, branch, main } = await threeWay(boardId, fromBranch, toBranch)
  if (branch.stateHash === main.stateHash) {
    return { from: fromBranch, to: toBranch, identical: true, summary: { total: 0, spatial: 0, material: 0, conflicts: 0 }, items: [] as DiffItem[] }
  }
  const { items } = diffStates(base.state, branch.state, main.state)
  return { from: fromBranch, to: toBranch, identical: false, summary: summarizeDiff(items), items }
}

// The structural event that replays a branch object's change onto the target.
function mergeEvent(objectId: string, change: DiffItem['change'], branchObj: BoardObject | undefined, fromBranch: string): AppendEventInput {
  const causedBy = [{ kind: 'MERGE', fromBranch, objectId }]
  switch (change) {
    case 'ADDED':
      return { eventType: 'OBJECT_CREATED', objectIds: [objectId], payload: { object: branchObj }, causedBy }
    case 'REMOVED':
      return { eventType: 'OBJECT_DELETED', objectIds: [objectId], causedBy }
    case 'CONTENT_CHANGED':
      return { eventType: 'OBJECT_EDITED', objectIds: [objectId], payload: { patch: contentPatch(branchObj) }, causedBy }
    case 'MOVED':
      return { eventType: 'OBJECT_MOVED', objectIds: [objectId], payload: { to: asRec(branchObj)['position'] ?? {} }, causedBy }
    case 'RESTYLED':
      return { eventType: 'OBJECT_EDITED', objectIds: [objectId], payload: { patch: { style: asRec(branchObj)['style'] ?? null } }, causedBy }
  }
}
function asRec(o: BoardObject | undefined): Record<string, unknown> { return (o ?? {}) as Record<string, unknown> }
function contentPatch(o: BoardObject | undefined): Record<string, unknown> {
  const { position, x, y, z, style, cluster, clusterId, deleted, id, ...rest } = asRec(o)
  void position; void x; void y; void z; void style; void cluster; void clusterId; void deleted; void id
  return rest
}

async function applyItems(boardId: string, fromBranch: string, toBranch: string, branchState: ObjectMap, items: DiffItem[], userId: string, targetHeadSeq: number) {
  for (const [index, it] of items.entries()) {
    if (it.conflict) throw new ValidationError(`Cannot merge ${it.objectId}: the target branch changed the same material object.`)
    await appendEvent(boardId, toBranch, { ...mergeEvent(it.objectId, it.change, branchState[it.objectId], fromBranch), expectedHeadSeq: targetHeadSeq + index }, { actorType: 'SYSTEM', actorId: userId })
  }
}

/**
 * Auto-merge SPATIAL changes onto the target and return the MATERIAL proposal batch
 * (conflicts included, flagged) for human review. Does NOT apply material changes.
 */
export async function mergeBranch(boardId: string, fromBranch: string, toBranch: string, userId: string) {
  const { base, branch, main } = await threeWay(boardId, fromBranch, toBranch)
  if (branch.stateHash === main.stateHash) {
    return { from: fromBranch, to: toBranch, identical: true, autoMerged: 0, batch: [] as DiffItem[], summary: { total: 0, spatial: 0, material: 0, conflicts: 0 } }
  }
  const { items } = diffStates(base.state, branch.state, main.state)
  const spatial = items.filter((i) => i.klass === 'SPATIAL')
  const material = items.filter((i) => i.klass === 'MATERIAL')
  await applyItems(boardId, fromBranch, toBranch, branch.state, spatial, userId, main.headEventSeq)
  await logEvent('BoardBranchMerged', 'BoardBranch', branch.branchId, userId, { boardId, from: fromBranch, to: toBranch, autoMerged: spatial.length, pending: material.length })
  await publishOutbox('BoardBranch', branch.branchId, 'BoardBranchMerged', { boardId, from: fromBranch, to: toBranch, autoMerged: spatial.length })
  return { from: fromBranch, to: toBranch, identical: false, autoMerged: spatial.length, batch: material, summary: summarizeDiff(items) }
}

/** Accept material batch items: replay the branch's version of each onto the target. */
export async function applyMergeItems(boardId: string, fromBranch: string, objectIds: string[], toBranch: string, userId: string) {
  if (!objectIds.length) throw new ValidationError('No objectIds to apply.')
  const { base, branch, main } = await threeWay(boardId, fromBranch, toBranch)
  const { items } = diffStates(base.state, branch.state, main.state)
  const chosen = items.filter((i) => objectIds.includes(i.objectId))
  if (!chosen.length) throw new ValidationError('None of the requested objects have a branch change to apply.')
  await applyItems(boardId, fromBranch, toBranch, branch.state, chosen, userId, main.headEventSeq)
  await logEvent('BoardMergeItemsApplied', 'BoardBranch', branch.branchId, userId, { boardId, from: fromBranch, to: toBranch, count: chosen.length })
  return { applied: chosen.map((i) => ({ objectId: i.objectId, change: i.change })) }
}

/** Close the merge: mark the source branch MERGED. */
export async function completeMerge(boardId: string, fromBranch: string, userId: string) {
  const tenantId = currentTenantIdForDb() ?? config.WORKGRAPH_DEFAULT_TENANT_ID
  const board = await prisma.board.findFirst({ where: { id: boardId, tenantId }, select: { id: true } })
  if (!board) throw new NotFoundError('Board', boardId)
  const branch = await prisma.boardBranch.findFirst({ where: { boardId, name: fromBranch, tenantId }, select: { id: true, name: true, status: true, mergedAt: true } })
  if (!branch) throw new NotFoundError('BoardBranch', `${boardId}/${fromBranch}`)
  if (branch.name === 'main') throw new ValidationError('The main branch cannot be merged away.')
  if (branch.status === 'MERGED') return { id: branch.id, name: branch.name, status: branch.status, mergedAt: branch.mergedAt }
  if (branch.status !== 'ACTIVE') throw new ValidationError(`Branch ${fromBranch} is ${branch.status} and cannot be completed.`)
  const remaining = await diffBranches(boardId, fromBranch, 'main')
  if (!remaining.identical) {
    throw new ValidationError('Merge is not complete: branch changes remain. Apply or resolve the remaining changes before closing the branch.')
  }
  const updatedResult = await prisma.boardBranch.updateMany({ where: { id: branch.id, status: 'ACTIVE' }, data: { status: 'MERGED', mergedAt: new Date() } })
  if (updatedResult.count !== 1) throw new ValidationError('Merge completion lost its branch-state fence; reload and retry.')
  const updated = await prisma.boardBranch.findUniqueOrThrow({ where: { id: branch.id } })
  await logEvent('BoardBranchMergeCompleted', 'BoardBranch', branch.id, userId, { boardId, from: fromBranch })
  await publishOutbox('BoardBranch', branch.id, 'BoardBranchMergeCompleted', { boardId, from: fromBranch })
  return { id: updated.id, name: updated.name, status: updated.status, mergedAt: updated.mergedAt }
}
