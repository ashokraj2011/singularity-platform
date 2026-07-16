/**
 * Specification Projects — the studio's optional project-level root. A project groups the shared
 * upstream (analysis → requirements → design); Work Items reference it via projectId but stay
 * standalone-capable (null projectId = solo item with its own spec). This service is the backend
 * for the top-level /studio front door (Portfolio → Project). Distinct from Initiative, which
 * groups workflow RUNS, not specifications.
 */
import { randomBytes } from 'crypto'
import type { Prisma, SpecificationProjectStatus } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { currentTenantIdForDb } from '../../lib/tenant-db-context'
import { config } from '../../config'
import { logEvent, publishOutbox } from '../../lib/audit'
import { ConflictError, NotFoundError } from '../../lib/errors'

export interface CreateProjectInput {
  name: string
  mission?: string
}
export interface UpdateProjectInput {
  name?: string
  mission?: string | null
}

function tenantId(): string {
  return currentTenantIdForDb() ?? config.WORKGRAPH_DEFAULT_TENANT_ID
}

// Compact, human-facing project code — mirrors WorkItem's WRK- codes.
async function generateProjectCode(): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const code = `PRJ-${randomBytes(3).toString('hex').slice(0, 5).toUpperCase()}`
    if (!(await prisma.specificationProject.findFirst({ where: { code, tenantId: tenantId() }, select: { id: true } }))) return code
  }
  return `PRJ-${Date.now().toString(36).slice(-5).toUpperCase()}`
}

const projectListSelect = {
  id: true,
  code: true,
  name: true,
  mission: true,
  status: true,
  createdById: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { workItems: true } },
} satisfies Prisma.SpecificationProjectSelect

export function shapeProject<T extends { _count: { workItems: number } }>(p: T) {
  const { _count, ...rest } = p
  return { ...rest, workItemCount: _count.workItems }
}

export async function listProjects(filter: { status?: SpecificationProjectStatus } = {}) {
  const projects = await prisma.specificationProject.findMany({
    where: { tenantId: tenantId(), ...(filter.status ? { status: filter.status } : {}) },
    select: projectListSelect,
    orderBy: { createdAt: 'desc' },
  })
  return { items: projects.map(shapeProject) }
}

export async function getProject(id: string) {
  const project = await prisma.specificationProject.findFirst({ where: { id, tenantId: tenantId() }, select: projectListSelect })
  if (!project) throw new NotFoundError('SpecificationProject', id)
  return shapeProject(project)
}

export async function createProject(input: CreateProjectInput, userId: string) {
  const code = await generateProjectCode()
  const project = await prisma.specificationProject.create({
    data: {
      code,
      name: input.name,
      mission: input.mission ?? null,
      createdById: userId,
      tenantId: tenantId(),
    },
    select: projectListSelect,
  })
  await logEvent('SpecificationProjectCreated', 'SpecificationProject', project.id, userId)
  await publishOutbox('SpecificationProject', project.id, 'SpecificationProjectCreated', { code: project.code, name: project.name })
  return shapeProject(project)
}

export async function updateProject(id: string, input: UpdateProjectInput, userId: string) {
  await getProject(id)
  const project = await prisma.specificationProject.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.mission !== undefined ? { mission: input.mission } : {}),
    },
    select: projectListSelect,
  })
  await logEvent('SpecificationProjectUpdated', 'SpecificationProject', id, userId)
  return shapeProject(project)
}

export async function setProjectArchived(id: string, archived: boolean, userId: string) {
  await getProject(id)
  const project = await prisma.specificationProject.update({
    where: { id },
    data: archived ? { status: 'ARCHIVED', archivedAt: new Date() } : { status: 'ACTIVE', archivedAt: null },
    select: projectListSelect,
  })
  await logEvent(archived ? 'SpecificationProjectArchived' : 'SpecificationProjectReactivated', 'SpecificationProject', id, userId)
  return shapeProject(project)
}

const workItemCardSelect = {
  id: true,
  workCode: true,
  title: true,
  status: true,
  urgency: true,
  projectId: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.WorkItemSelect

export async function listProjectWorkItems(id: string) {
  await getProject(id)
  const items = await prisma.workItem.findMany({ where: { projectId: id, tenantId: tenantId() }, select: workItemCardSelect, orderBy: { createdAt: 'desc' } })
  return { items }
}

async function loadWorkItem(workItemId: string) {
  const workItem = await prisma.workItem.findFirst({ where: { id: workItemId, tenantId: tenantId() }, select: { id: true, projectId: true } })
  if (!workItem) throw new NotFoundError('WorkItem', workItemId)
  return workItem
}

export async function attachWorkItem(projectId: string, workItemId: string, userId: string) {
  await getProject(projectId)
  const workItem = await loadWorkItem(workItemId)
  if (workItem.projectId && workItem.projectId !== projectId) {
    throw new ConflictError('Work item is already attached to a different project. Detach it first.')
  }
  const updated = await prisma.workItem.update({ where: { id: workItemId }, data: { projectId }, select: workItemCardSelect })
  await logEvent('WorkItemAttachedToProject', 'WorkItem', workItemId, userId)
  await publishOutbox('SpecificationProject', projectId, 'WorkItemAttached', { workItemId })
  return updated
}

export async function detachWorkItem(projectId: string, workItemId: string, userId: string) {
  await getProject(projectId)
  const workItem = await loadWorkItem(workItemId)
  if (workItem.projectId !== projectId) throw new ConflictError('Work item is not attached to this project.')
  const updated = await prisma.workItem.update({ where: { id: workItemId }, data: { projectId: null }, select: workItemCardSelect })
  await logEvent('WorkItemDetachedFromProject', 'WorkItem', workItemId, userId)
  return updated
}

// The /studio landing: active projects (with counts) + the standalone (unprojected) work items.
export async function getPortfolio() {
  const [{ items: projects }, standalone] = await Promise.all([
    listProjects({ status: 'ACTIVE' }),
    prisma.workItem.findMany({ where: { projectId: null, tenantId: tenantId() }, select: workItemCardSelect, orderBy: { createdAt: 'desc' }, take: 50 }),
  ])
  return { projects, standaloneWorkItems: standalone }
}
