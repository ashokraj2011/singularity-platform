/**
 * Synthesis Studio — context manifest builder (R1A 1.3). Resolves a thread's context refs
 * FRESH, freezes the resolved snapshots, computes the summary + canonical hash, and persists
 * an immutable ContextManifest. Callers persist this BEFORE an agent turn so the run is gated
 * by exactly what the manifest declares (the immutable hash is the audit anchor).
 *
 * RLS: the ref read and the manifest write each run in a tenant transaction; the (HTTP)
 * resolution runs BETWEEN them, outside any transaction.
 */
import type { Prisma } from '@prisma/client'
import type { Request } from 'express'
import { prisma } from '../../lib/prisma'
import { currentTenantIdForDb, withTenantDbTransaction } from '../../lib/tenant-db-context'
import { config } from '../../config'
import { NotFoundError } from '../../lib/errors'
import { assertWorkspace } from './workspace.service'
import { resolveContextRef } from './context-reference.resolver'
import { summarizeManifest, hashManifest, type ResolvedRefSnapshot } from './context-manifest'

const tenantId = (): string => currentTenantIdForDb() ?? config.WORKGRAPH_DEFAULT_TENANT_ID
const inTenantTx = <T>(cb: () => Promise<T>): Promise<T> => withTenantDbTransaction(prisma, cb, tenantId())

export async function buildManifest(workspaceId: string, threadId: string, req: Request) {
  await assertWorkspace(workspaceId)
  const tid = tenantId()
  // A thread reads its own refs plus workspace-wide refs (threadId null).
  const refs = await inTenantTx(() => prisma.contextReference.findMany({
    where: { workspaceId, tenantId: tid, OR: [{ threadId }, { threadId: null }] },
    orderBy: { createdAt: 'asc' },
  }))
  // HTTP resolution — outside the transaction.
  const items: ResolvedRefSnapshot[] = await Promise.all(
    refs.map((r) => resolveContextRef({ entityType: r.entityType, entityId: r.entityId, referenceMode: r.referenceMode, versionId: r.versionId, contentHash: r.contentHash }, req)),
  )
  const summary = summarizeManifest(items)
  const manifestHash = hashManifest(items)
  const manifest = await inTenantTx(() => prisma.contextManifest.create({
    data: {
      tenantId: tid, workspaceId, threadId,
      items: items as unknown as Prisma.InputJsonValue,
      tokenEstimate: summary.tokenEstimate,
      pinnedCount: summary.pinnedCount,
      followingCount: summary.followingCount,
      classificationSummary: summary.classificationSummary as Prisma.InputJsonValue,
      manifestHash,
    },
  }))
  return { manifest: { ...manifest, items, summary } }
}

export async function getManifest(workspaceId: string, manifestId: string) {
  const m = await inTenantTx(() => prisma.contextManifest.findFirst({ where: { id: manifestId, workspaceId, tenantId: tenantId() } }))
  if (!m) throw new NotFoundError('ContextManifest', manifestId)
  return m
}
