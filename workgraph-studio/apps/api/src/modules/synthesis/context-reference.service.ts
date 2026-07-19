/**
 * Synthesis Studio — context reference CRUD (R1A 1.3). Add/list/remove the typed @-refs
 * on a workspace (optionally scoped to a thread). On add, the ref is resolved once (for
 * label/versionId/contentHash/authz) and the resolution is stored; the manifest re-resolves
 * fresh at run time. Every path is tenant-scoped and gated by the tenant-scoped workspace.
 */
import type { Prisma } from '@prisma/client'
import type { Request } from 'express'
import { prisma } from '../../lib/prisma'
import { currentTenantIdForDb } from '../../lib/tenant-db-context'
import { config } from '../../config'
import { NotFoundError } from '../../lib/errors'
import { assertWorkspace } from './workspace.service'
import { resolveContextRef, type ContextRefInput } from './context-reference.resolver'

const tenantId = (): string => currentTenantIdForDb() ?? config.WORKGRAPH_DEFAULT_TENANT_ID

export interface AddContextRefInput extends ContextRefInput {
  threadId?: string | null
  specificationProjectId?: string | null
  workItemId?: string | null
  span?: Record<string, unknown>
  label?: string
}

export async function addContextRef(workspaceId: string, input: AddContextRefInput, userId: string, req: Request) {
  await assertWorkspace(workspaceId)
  const resolved = await resolveContextRef(input, req)
  const ref = await prisma.contextReference.create({
    data: {
      tenantId: tenantId(),
      workspaceId,
      threadId: input.threadId ?? null,
      specificationProjectId: input.specificationProjectId ?? null,
      workItemId: input.workItemId ?? null,
      entityType: input.entityType as never,
      entityId: input.entityId,
      versionId: resolved.versionId ?? input.versionId ?? null,
      contentHash: resolved.contentHash ?? input.contentHash ?? null,
      referenceMode: input.referenceMode ?? 'FOLLOW_LATEST',
      classification: resolved.classification ?? null,
      authzDecision: { exists: resolved.exists, error: resolved.error ?? null } as Prisma.InputJsonValue,
      label: input.label ?? resolved.label ?? null,
      addedById: userId,
      resolvedAt: new Date(),
      ...(input.span ? { span: input.span as Prisma.InputJsonValue } : {}),
    },
  })
  return { ...ref, resolved }
}

export async function listContextRefs(workspaceId: string, opts: { threadId?: string } = {}) {
  await assertWorkspace(workspaceId)
  const items = await prisma.contextReference.findMany({
    where: { workspaceId, tenantId: tenantId(), ...(opts.threadId ? { threadId: opts.threadId } : {}) },
    orderBy: { createdAt: 'asc' },
  })
  return { items }
}

export async function removeContextRef(workspaceId: string, refId: string) {
  const existing = await prisma.contextReference.findFirst({ where: { id: refId, workspaceId, tenantId: tenantId() }, select: { id: true } })
  if (!existing) throw new NotFoundError('ContextReference', refId)
  await prisma.contextReference.delete({ where: { id: existing.id } })
  return { deleted: true }
}
