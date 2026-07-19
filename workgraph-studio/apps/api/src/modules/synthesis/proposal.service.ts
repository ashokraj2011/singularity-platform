/**
 * Synthesis Studio — universal (v2) proposals (R1A Proposals phase). A v2 StudioProposal
 * carries independently-reviewable ProposalItems — the mutation boundary. Humans accept /
 * reject / edit each item; ACCEPT runs the typed-tool apply-registry behind a per-item
 * content-hash stale fence. The legacy concept-archive path (v1) is untouched.
 *
 * RLS: DB work runs in tenant transactions so the forced proposal_items table enforces
 * isolation. decideProposalItems uses a transaction PER item (not one big tx) so a failed
 * apply is recorded and the batch continues — one item's error never poisons the others.
 */
import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { currentTenantIdForDb, withTenantDbTransaction } from '../../lib/tenant-db-context'
import { config } from '../../config'
import { NotFoundError, ConflictError } from '../../lib/errors'
import { getProject } from '../studio/studio-projects.service'
import { isItemStale, canDecideItem, settleProposalStatus, type ItemStatus } from './proposal-contract'
import { applyProposalItem } from './proposal-apply-registry'

const tenantId = (): string => currentTenantIdForDb() ?? config.WORKGRAPH_DEFAULT_TENANT_ID
const inTenantTx = <T>(cb: () => Promise<T>): Promise<T> => withTenantDbTransaction(prisma, cb, tenantId())

// A v2 proposal still needs a Studio (the project's proposal inbox). Lazily create it.
// (Runs inside the caller's tx.)
async function getOrCreateStudioId(projectId: string, userId: string): Promise<string> {
  const existing = await prisma.studio.findFirst({ where: { projectId, tenantId: tenantId() }, select: { id: true } })
  if (existing) return existing.id
  const project = await getProject(projectId) // tenant-scoped 404
  const studio = await prisma.studio.create({ data: { projectId, name: `${project.name} Studio`, createdById: userId, tenantId: tenantId() } })
  return studio.id
}

export interface ProposalItemInput {
  kind: string
  title?: string
  targetEntityType?: string
  targetEntityId?: string
  targetVersionId?: string
  baseContentHash?: string
  diff?: Record<string, unknown>
  citations?: unknown[]
  evidenceTier?: string
  uncertainty?: number
  reversibility?: string
  cost?: Record<string, unknown>
  requiredApproval?: string
}
export interface CreateProposalInput {
  workspaceId: string
  workItemId?: string | null
  agentRole?: string
  contract?: Record<string, unknown>
  items: ProposalItemInput[]
}

export async function createWorkspaceProposal(input: CreateProposalInput, userId: string) {
  return inTenantTx(async () => {
    const ws = await prisma.synthesisWorkspace.findFirst({ where: { id: input.workspaceId, tenantId: tenantId() }, select: { id: true, specificationProjectId: true } })
    if (!ws) throw new NotFoundError('SynthesisWorkspace', input.workspaceId)
    const studioId = await getOrCreateStudioId(ws.specificationProjectId, userId)
    return prisma.studioProposal.create({
      data: {
        tenantId: tenantId(), studioId, contractVersion: 2,
        workspaceId: input.workspaceId, workItemId: input.workItemId ?? null,
        scopeType: 'WORKSPACE', scopeRef: { workspaceId: input.workspaceId } as Prisma.InputJsonValue,
        kind: 'BATCH', payload: {} as Prisma.InputJsonValue,
        authorType: input.agentRole ? 'AGENT' : 'HUMAN', authorId: userId, agentRole: input.agentRole ?? null,
        contract: (input.contract ?? {}) as Prisma.InputJsonValue,
        items: {
          create: input.items.map((it, i) => ({
            tenantId: tenantId(), ordinal: i, kind: it.kind, title: it.title ?? null,
            targetEntityType: it.targetEntityType ?? null, targetEntityId: it.targetEntityId ?? null,
            targetVersionId: it.targetVersionId ?? null, baseContentHash: it.baseContentHash ?? null,
            diff: (it.diff ?? {}) as Prisma.InputJsonValue, citations: (it.citations ?? []) as Prisma.InputJsonValue,
            evidenceTier: it.evidenceTier ?? null, uncertainty: it.uncertainty ?? null,
            reversibility: it.reversibility ?? null,
            ...(it.cost ? { cost: it.cost as Prisma.InputJsonValue } : {}),
            requiredApproval: it.requiredApproval ?? null,
          })),
        },
      },
      include: { items: { orderBy: { ordinal: 'asc' } } },
    })
  })
}

export async function listProposals(workspaceId: string) {
  return { items: await inTenantTx(() => prisma.studioProposal.findMany({ where: { workspaceId, tenantId: tenantId(), contractVersion: 2 }, orderBy: { createdAt: 'desc' }, include: { items: { orderBy: { ordinal: 'asc' } } } })) }
}
export async function getProposal(proposalId: string) {
  const p = await inTenantTx(() => prisma.studioProposal.findFirst({ where: { id: proposalId, tenantId: tenantId(), contractVersion: 2 }, include: { items: { orderBy: { ordinal: 'asc' } } } }))
  if (!p) throw new NotFoundError('StudioProposal', proposalId)
  return p
}

export interface ItemDecisionInput {
  itemId: string
  decision: 'ACCEPT' | 'REJECT' | 'EDIT'
  editedDiff?: Record<string, unknown>
  currentContentHash?: string // caller supplies the target's current hash for the stale fence
}

/**
 * Decide items — resilient per item: a bad itemId or already-decided item aborts (client
 * error), but a STALE fence or a failed apply is RECORDED on that item and the batch
 * continues (so accept-selected works). Each write is its OWN tenant transaction, so a
 * failed apply never poisons the rest of the batch.
 */
export async function decideProposalItems(proposalId: string, decisions: ItemDecisionInput[], actor: string) {
  const proposal = await inTenantTx(() => prisma.studioProposal.findFirst({ where: { id: proposalId, tenantId: tenantId(), contractVersion: 2 }, include: { items: true } }))
  if (!proposal) throw new NotFoundError('StudioProposal', proposalId)
  const byId = new Map(proposal.items.map((i) => [i.id, i]))

  for (const d of decisions) {
    const item = byId.get(d.itemId)
    if (!item) throw new NotFoundError('ProposalItem', d.itemId)
    if (!canDecideItem(item.status as ItemStatus)) throw new ConflictError(`Item ${d.itemId} is already ${item.status}.`)

    if (d.decision === 'REJECT') {
      await inTenantTx(() => prisma.proposalItem.update({ where: { id: item.id }, data: { status: 'REJECTED', decidedById: actor } }))
      continue
    }
    if (isItemStale(item.baseContentHash, d.currentContentHash)) {
      await inTenantTx(() => prisma.proposalItem.update({ where: { id: item.id }, data: { status: 'STALE', decidedById: actor } }))
      continue
    }
    const editedDiff = d.decision === 'EDIT' ? (d.editedDiff ?? {}) : undefined
    try {
      const result = await applyProposalItem(
        { id: item.id, kind: item.kind, targetEntityType: item.targetEntityType, targetEntityId: item.targetEntityId, diff: item.diff, editedDiff: editedDiff ?? item.editedDiff },
        { actor },
      )
      await inTenantTx(() => prisma.proposalItem.update({
        where: { id: item.id },
        data: { status: 'APPLIED', decidedById: actor, appliedReceipt: result.receipt as Prisma.InputJsonValue, ...(editedDiff ? { editedDiff: editedDiff as Prisma.InputJsonValue } : {}) },
      }))
    } catch (err) {
      // Human accepted, but the mutation failed (unsupported verb, guard, etc.). Record it
      // — accepted-but-not-applied — rather than aborting the whole batch or silently mutating.
      await inTenantTx(() => prisma.proposalItem.update({
        where: { id: item.id },
        data: { status: 'ACCEPTED', decidedById: actor, appliedReceipt: { verb: item.kind, error: (err as Error).message } as Prisma.InputJsonValue, ...(editedDiff ? { editedDiff: editedDiff as Prisma.InputJsonValue } : {}) },
      }))
    }
  }

  const fresh = await inTenantTx(() => prisma.proposalItem.findMany({ where: { proposalId }, select: { status: true } }))
  const settled = settleProposalStatus(fresh.map((i) => i.status as ItemStatus))
  return inTenantTx(() => prisma.studioProposal.update({
    where: { id: proposalId },
    data: { status: settled, ...(settled !== 'PENDING' ? { decidedAt: new Date(), decidedById: actor } : {}) },
    include: { items: { orderBy: { ordinal: 'asc' } } },
  }))
}

/** Rebase a STALE/PENDING item onto a fresh base so it can be decided again. */
export async function rebaseProposalItem(proposalId: string, itemId: string, patch: { diff?: Record<string, unknown>; baseContentHash?: string }) {
  return inTenantTx(async () => {
    const item = await prisma.proposalItem.findFirst({ where: { id: itemId, proposalId, tenantId: tenantId() } })
    if (!item) throw new NotFoundError('ProposalItem', itemId)
    if (item.status !== 'STALE' && item.status !== 'PENDING') throw new ConflictError(`Only STALE/PENDING items can be rebased (item is ${item.status}).`)
    return prisma.proposalItem.update({
      where: { id: item.id },
      data: {
        status: 'PENDING', rebaseOfItemId: item.id,
        ...(patch.diff ? { diff: patch.diff as Prisma.InputJsonValue } : {}),
        ...(patch.baseContentHash ? { baseContentHash: patch.baseContentHash } : {}),
      },
    })
  })
}
