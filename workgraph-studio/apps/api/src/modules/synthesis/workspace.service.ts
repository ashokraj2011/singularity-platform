/**
 * Synthesis Studio — Working Session persistence (R1A Foundations). A SynthesisWorkspace
 * is a persistent session anchored on an existing SpecificationProject (optionally a
 * WorkItem); threads are linear conversations. Every read scopes to a CONCRETE tenant,
 * and the anchor project is validated through the tenant-scoped getProject() — so a
 * cross-tenant workspace can be neither created nor read.
 */
import type { Prisma, WorkspaceThread } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { currentTenantIdForDb } from '../../lib/tenant-db-context'
import { config } from '../../config'
import { logEvent } from '../../lib/audit'
import { NotFoundError } from '../../lib/errors'
import { getProject } from '../studio/studio-projects.service'

const tenantId = (): string => currentTenantIdForDb() ?? config.WORKGRAPH_DEFAULT_TENANT_ID
// seq/headSeq are BigInt; there is no global BigInt JSON serializer, so shape to Number
// for the response (mirrors board.service.shapeEvent).
const shapeThread = (t: WorkspaceThread) => ({ ...t, headSeq: Number(t.headSeq) })

export interface CreateWorkspaceInput {
  specificationProjectId: string
  workItemId?: string | null
  title: string
  purpose?: string
}

export async function createWorkspace(input: CreateWorkspaceInput, userId: string) {
  await getProject(input.specificationProjectId) // tenant-scoped 404 — the anchor guard
  const ws = await prisma.synthesisWorkspace.create({
    data: {
      tenantId: tenantId(),
      specificationProjectId: input.specificationProjectId,
      workItemId: input.workItemId ?? null,
      title: input.title,
      purpose: input.purpose ?? null,
      openedById: userId,
    },
  })
  await logEvent('SynthesisWorkspaceOpened', 'SynthesisWorkspace', ws.id, userId)
  return ws
}

export async function getWorkspace(workspaceId: string) {
  const ws = await prisma.synthesisWorkspace.findFirst({
    where: { id: workspaceId, tenantId: tenantId() },
    include: { threads: { orderBy: { createdAt: 'asc' } } },
  })
  if (!ws) throw new NotFoundError('SynthesisWorkspace', workspaceId)
  return { ...ws, threads: ws.threads.map(shapeThread) }
}

export async function listWorkspaces(projectId: string) {
  await getProject(projectId)
  const items = await prisma.synthesisWorkspace.findMany({
    where: { specificationProjectId: projectId, tenantId: tenantId() },
    orderBy: { lastActivityAt: 'desc' },
    take: 200,
  })
  return { items }
}

/** Tenant-scoped workspace existence guard, shared by the thread/message paths. */
export async function assertWorkspace(workspaceId: string) {
  const ws = await prisma.synthesisWorkspace.findFirst({ where: { id: workspaceId, tenantId: tenantId() }, select: { id: true } })
  if (!ws) throw new NotFoundError('SynthesisWorkspace', workspaceId)
  return ws
}

export interface CreateThreadInput {
  kind?: 'WORKING_SESSION' | 'ASK_SIDECAR'
  agentRole?: string
  title?: string
  contextScope?: Record<string, unknown>
}

export async function createThread(workspaceId: string, input: CreateThreadInput, userId: string) {
  await assertWorkspace(workspaceId)
  const thread = await prisma.workspaceThread.create({
    data: {
      tenantId: tenantId(),
      workspaceId,
      kind: input.kind ?? 'WORKING_SESSION',
      agentRole: input.agentRole ?? null,
      title: input.title ?? null,
      contextScope: (input.contextScope ?? {}) as Prisma.InputJsonValue,
      createdById: userId,
    },
  })
  return shapeThread(thread)
}

export async function listThreads(workspaceId: string) {
  await assertWorkspace(workspaceId)
  const items = await prisma.workspaceThread.findMany({ where: { workspaceId, tenantId: tenantId() }, orderBy: { createdAt: 'asc' } })
  return { items: items.map(shapeThread) }
}
