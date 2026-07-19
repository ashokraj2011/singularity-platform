/**
 * Synthesis Studio — the fenced message-append path (R1A Foundations). Mirrors
 * board.service.appendEvent: lock the thread row FOR UPDATE, allocate headSeq+1, insert,
 * advance the fence — a gap-free per-thread seq (@@unique([threadId,seq]) is the safety
 * net). coalesceKey makes client retries idempotent. Everything runs inside a tenant DB
 * transaction so the SET LOCAL app.tenant_id matches the row filter (RLS-ready).
 */
import type { Prisma, WorkspaceMessage } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { currentTenantIdForDb, withTenantDbTransaction } from '../../lib/tenant-db-context'
import { config } from '../../config'
import { NotFoundError, ConflictError } from '../../lib/errors'

const tenantId = (): string => currentTenantIdForDb() ?? config.WORKGRAPH_DEFAULT_TENANT_ID
const shapeMessage = (m: WorkspaceMessage) => ({ ...m, seq: Number(m.seq) })

interface ThreadFenceRow { id: string; headSeq: bigint; status: string }

export interface AppendMessageInput {
  role: 'USER' | 'ASSISTANT' | 'SYSTEM'
  authorType: 'HUMAN' | 'AGENT' | 'SYSTEM'
  authorId?: string | null
  agentRole?: string | null
  content: Record<string, unknown>
  contextManifestId?: string | null
  proposalId?: string | null
  correlation?: Record<string, unknown>
  tokens?: Record<string, unknown>
  receipts?: unknown[]
  coalesceKey?: string
  expectedHeadSeq?: number
}

export async function appendMessage(workspaceId: string, threadId: string, input: AppendMessageInput) {
  const tid = tenantId()
  const result = await withTenantDbTransaction(prisma, async (tx) => {
    // Fence: lock the thread row so exactly one appender allocates the next seq.
    const rows = await tx.$queryRaw<ThreadFenceRow[]>`
      SELECT "id", "headSeq", "status" FROM "workspace_threads"
      WHERE "id" = ${threadId} AND "workspaceId" = ${workspaceId} AND "tenantId" = ${tid} FOR UPDATE`
    const thread = rows[0]
    if (!thread) throw new NotFoundError('WorkspaceThread', threadId)
    if (thread.status !== 'ACTIVE') throw new ConflictError(`Thread ${threadId} is ${thread.status} — cannot append.`)
    const head = Number(thread.headSeq)

    // Idempotent retry: the same coalesceKey already landed → return it, no new row.
    if (input.coalesceKey) {
      const prior = await tx.workspaceMessage.findFirst({ where: { threadId, coalesceKey: input.coalesceKey } })
      if (prior) return { message: prior, deduped: true }
    }
    // Optional read-only-past guard (client's view cursor must match head).
    if (input.expectedHeadSeq !== undefined && input.expectedHeadSeq !== head) {
      throw new ConflictError(`Stale thread head (expected ${input.expectedHeadSeq}, actual ${head}).`)
    }

    const nextSeq = BigInt(head + 1)
    const message = await tx.workspaceMessage.create({
      data: {
        tenantId: tid, workspaceId, threadId, seq: nextSeq,
        role: input.role, authorType: input.authorType,
        authorId: input.authorId ?? null, agentRole: input.agentRole ?? null,
        content: (input.content ?? {}) as Prisma.InputJsonValue,
        contextManifestId: input.contextManifestId ?? null,
        proposalId: input.proposalId ?? null,
        correlation: (input.correlation ?? {}) as Prisma.InputJsonValue,
        tokens: (input.tokens ?? {}) as Prisma.InputJsonValue,
        receipts: (input.receipts ?? []) as Prisma.InputJsonValue,
        coalesceKey: input.coalesceKey ?? null,
      },
    })
    await tx.workspaceThread.update({ where: { id: threadId }, data: { headSeq: nextSeq } })
    await tx.synthesisWorkspace.update({ where: { id: workspaceId }, data: { lastActivityAt: new Date() } })
    return { message, deduped: false }
  }, tid)
  return { message: shapeMessage(result.message), deduped: result.deduped }
}

export async function listMessages(workspaceId: string, threadId: string, opts: { afterSeq?: number } = {}) {
  const items = await prisma.workspaceMessage.findMany({
    where: { workspaceId, threadId, tenantId: tenantId(), ...(opts.afterSeq !== undefined ? { seq: { gt: BigInt(opts.afterSeq) } } : {}) },
    orderBy: { seq: 'asc' },
    take: 500,
  })
  return { items: items.map(shapeMessage) }
}
