import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { currentTenantIdForDb, withTenantDbTransaction } from '../../lib/tenant-db-context'
import { publishOutbox } from '../../lib/audit'
import { ConflictError, NotFoundError } from '../../lib/errors'
import { parseMentions } from './comment'

async function loadWorkItem(workItemId: string) {
  const workItem = await prisma.workItem.findUnique({ where: { id: workItemId }, select: { id: true, tenantId: true } })
  if (!workItem) throw new NotFoundError('WorkItem', workItemId)
  return workItem
}

export interface CreateCommentInput {
  body: string
  anchorKind?: string
  anchorId?: string
  parentId?: string
}

export async function listComments(workItemId: string, filter: { anchorKind?: string; anchorId?: string } = {}) {
  await loadWorkItem(workItemId)
  const items = await prisma.specComment.findMany({
    where: { workItemId, ...(filter.anchorKind ? { anchorKind: filter.anchorKind } : {}), ...(filter.anchorId ? { anchorId: filter.anchorId } : {}) },
    orderBy: { createdAt: 'asc' },
  })
  return { items }
}

export async function createComment(workItemId: string, input: CreateCommentInput, authorId: string) {
  const workItem = await loadWorkItem(workItemId)
  const mentions = parseMentions(input.body)
  const tenantId = workItem.tenantId ?? currentTenantIdForDb() ?? undefined

  const created = await withTenantDbTransaction(prisma, (tx) => tx.specComment.create({
    data: {
      workItemId,
      anchorKind: input.anchorKind ?? null,
      anchorId: input.anchorId ?? null,
      body: input.body,
      authorId,
      mentions: mentions as unknown as Prisma.InputJsonValue,
      parentId: input.parentId ?? null,
      tenantId: workItem.tenantId,
    },
  }), tenantId)

  // Best-effort notification signal for @mentions (consumers can turn these into inbox items).
  if (mentions.length) await publishOutbox('WorkItem', workItemId, 'CommentMention', { commentId: created.id, mentions, authorId, anchorKind: input.anchorKind ?? null, anchorId: input.anchorId ?? null })
  return created
}

export async function resolveComment(workItemId: string, commentId: string, resolved: boolean, actorId: string) {
  const workItem = await loadWorkItem(workItemId)
  const comment = await prisma.specComment.findUnique({ where: { id: commentId } })
  if (!comment || comment.workItemId !== workItemId) throw new NotFoundError('SpecComment', commentId)
  const tenantId = workItem.tenantId ?? undefined
  return withTenantDbTransaction(prisma, (tx) => tx.specComment.update({
    where: { id: commentId },
    data: resolved ? { resolvedAt: new Date(), resolvedById: actorId } : { resolvedAt: null, resolvedById: null },
  }), tenantId)
}

export async function deleteComment(workItemId: string, commentId: string, actorId: string) {
  const workItem = await loadWorkItem(workItemId)
  const comment = await prisma.specComment.findUnique({ where: { id: commentId } })
  if (!comment || comment.workItemId !== workItemId) throw new NotFoundError('SpecComment', commentId)
  if (comment.authorId !== actorId) throw new ConflictError('Only the author can delete this comment.')
  const tenantId = workItem.tenantId ?? undefined
  await withTenantDbTransaction(prisma, (tx) => tx.specComment.delete({ where: { id: commentId } }), tenantId)
  return { deleted: true }
}
