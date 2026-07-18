/**
 * Specification Projects are the persisted initiative root. They own portfolio guardrails and
 * the shared upstream (analysis -> requirements -> design) used by their Work Items.
 */
import { randomBytes } from 'crypto'
import type { Prisma, SpecificationProjectStatus } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { currentTenantIdForDb, withTenantDbTransaction } from '../../lib/tenant-db-context'
import { config } from '../../config'
import { logEvent, publishOutbox } from '../../lib/audit'
import { ConflictError, NotFoundError } from '../../lib/errors'

export interface CreateProjectInput {
  name: string
  mission?: string
  primaryCapability: CapabilityRef
  tokenBudget: number
  costBudgetUsd?: number
  businessValue?: number
  customerImpact?: number
  strategicAlignment?: number
  urgency?: number
  deliveryRisk?: number
  technicalRisk?: number
  regulatoryRisk?: number
  confidence?: number
  effort?: number
  targetDate?: string
  reviewCadenceDays?: number
  sponsorId?: string
  productOwnerId?: string
  successMetrics?: string[]
  tags?: string[]
}
export interface UpdateProjectInput {
  name?: string
  mission?: string | null
  primaryCapability?: CapabilityRef
  tokenBudget?: number
  costBudgetUsd?: number | null
  businessValue?: number | null
  customerImpact?: number | null
  strategicAlignment?: number | null
  urgency?: number | null
  deliveryRisk?: number | null
  technicalRisk?: number | null
  regulatoryRisk?: number | null
  confidence?: number | null
  effort?: number | null
  targetDate?: string | null
  reviewCadenceDays?: number
  lastReviewedAt?: string | null
  sponsorId?: string | null
  productOwnerId?: string | null
  successMetrics?: string[]
  tags?: string[]
}

export interface CapabilityRef {
  id: string
  name: string
  impactArea?: string
}

type CapabilityLinkInput = CapabilityRef & { role: 'PRIMARY' }
type CapabilityReassignmentBlockers = {
  workItems: number
  generationPlans: number
  lockedSpecificationVersions: number
}

function tenantId(): string {
  return currentTenantIdForDb() ?? config.WORKGRAPH_DEFAULT_TENANT_ID
}

function tenantTx<T>(callback: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return withTenantDbTransaction(prisma, callback, tenantId())
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
  primaryCapabilityId: true,
  primaryCapabilityName: true,
  tokenBudget: true,
  tokenUsed: true,
  costBudgetUsd: true,
  costUsedUsd: true,
  businessValue: true,
  customerImpact: true,
  strategicAlignment: true,
  urgency: true,
  deliveryRisk: true,
  technicalRisk: true,
  regulatoryRisk: true,
  confidence: true,
  effort: true,
  targetDate: true,
  reviewCadenceDays: true,
  lastReviewedAt: true,
  sponsorId: true,
  productOwnerId: true,
  successMetrics: true,
  tags: true,
  createdAt: true,
  updatedAt: true,
  capabilityLinks: {
    select: { id: true, capabilityId: true, capabilityName: true, role: true, impactArea: true },
    orderBy: { role: 'asc' },
  },
  impactAssessments: {
    select: {
      id: true, capabilityId: true, capabilityName: true, agentTemplateId: true,
      agentTemplateName: true, status: true, summary: true, recommendations: true,
      risks: true, dependencies: true, suggestedClaims: true, traceId: true,
      tokensUsed: true, estimatedCostUsd: true, error: true, assessedAt: true, updatedAt: true,
    },
    orderBy: { updatedAt: 'desc' },
  },
  claims: { select: { updatedAt: true }, orderBy: { updatedAt: 'desc' }, take: 1 },
  workItems: { select: { updatedAt: true }, orderBy: { updatedAt: 'desc' }, take: 1 },
  _count: { select: { workItems: true, claims: true } },
} satisfies Prisma.SpecificationProjectSelect

export function shapeProject<T extends {
  _count: { workItems: number; claims?: number }
  createdAt?: Date | string
  updatedAt?: Date | string
  targetDate?: Date | string | null
  reviewCadenceDays?: number
  businessValue?: number | null
  customerImpact?: number | null
  strategicAlignment?: number | null
  urgency?: number | null
  deliveryRisk?: number | null
  technicalRisk?: number | null
  regulatoryRisk?: number | null
  confidence?: number | null
  effort?: number | null
  tokenBudget?: number
  tokenUsed?: number
  claims?: Array<{ updatedAt: Date | string }>
  workItems?: Array<{ updatedAt: Date | string }>
  impactAssessments?: Array<{ status: string; updatedAt?: Date | string }>
}>(p: T) {
  const { _count, claims = [], workItems = [], ...rest } = p
  const now = Date.now()
  const createdAt = dateMs(p.createdAt) ?? now
  const latestActivityAt = Math.max(
    dateMs(p.updatedAt) ?? createdAt,
    dateMs(claims[0]?.updatedAt) ?? 0,
    dateMs(workItems[0]?.updatedAt) ?? 0,
    dateMs(p.impactAssessments?.[0]?.updatedAt) ?? 0,
  )
  const ageDays = wholeDays(now - createdAt)
  const inactiveDays = wholeDays(now - latestActivityAt)
  const targetMs = dateMs(p.targetDate)
  const reviewCadenceDays = p.reviewCadenceDays ?? 30
  const agingStatus = targetMs != null && targetMs < now
    ? 'OVERDUE'
    : inactiveDays >= reviewCadenceDays * 2
      ? 'STALE'
      : inactiveDays >= reviewCadenceDays
        ? 'REVIEW_DUE'
        : 'CURRENT'
  const assessmentStates = (p.impactAssessments ?? []).map((item) => item.status)
  const impactAssessmentStatus = assessmentStates.includes('FAILED')
    ? 'ATTENTION'
    : assessmentStates.some((state) => state === 'RUNNING')
      ? 'RUNNING'
      : assessmentStates.some((state) => state === 'PENDING')
        ? 'PENDING'
        : assessmentStates.length > 0 && assessmentStates.every((state) => state === 'COMPLETED')
          ? 'COMPLETED'
          : 'NONE'
  const valueScore = average([p.businessValue, p.customerImpact, p.strategicAlignment, p.urgency])
  const riskScore = average([p.deliveryRisk, p.technicalRisk, p.regulatoryRisk])
  const confidence = p.confidence ?? 3
  const effort = Math.max(1, p.effort ?? 3)
  const priorityScore = valueScore == null
    ? null
    : Math.round(((valueScore * (confidence / 5)) / (effort * (1 + ((riskScore ?? 0) / 5)))) * 100) / 100
  const tokenBudget = p.tokenBudget ?? 0
  const tokenUsed = p.tokenUsed ?? 0
  const shapedRest = { ...rest }
  const shapedRecord = shapedRest as Record<string, unknown>
  const primaryCapabilityId = typeof shapedRecord.primaryCapabilityId === 'string' ? shapedRecord.primaryCapabilityId : undefined
  const primaryCapabilityName = typeof shapedRecord.primaryCapabilityName === 'string'
    ? shapedRecord.primaryCapabilityName
    : primaryCapabilityId
  if (primaryCapabilityId && Array.isArray(shapedRecord.capabilityLinks)) {
    shapedRecord.capabilityLinks = shapedRecord.capabilityLinks.filter((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return false
      const record = item as Record<string, unknown>
      return record.capabilityId === primaryCapabilityId && record.role === 'PRIMARY'
    })
  }
  if (primaryCapabilityId && Array.isArray(shapedRecord.impactAssessments)) {
    shapedRecord.impactAssessments = shapedRecord.impactAssessments.filter((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return false
      return (item as Record<string, unknown>).capabilityId === primaryCapabilityId
    })
  }
  return {
    ...shapedRest,
    assignedCapability: primaryCapabilityId
      ? { id: primaryCapabilityId, name: primaryCapabilityName ?? primaryCapabilityId }
      : null,
    workItemCount: _count.workItems,
    claimCount: _count.claims ?? 0,
    ageDays,
    inactiveDays,
    agingStatus,
    latestActivityAt: new Date(latestActivityAt),
    valueScore,
    riskScore,
    priorityScore,
    tokenBudgetPercent: tokenBudget > 0 ? Math.min(100, Math.round((tokenUsed / tokenBudget) * 100)) : 100,
    impactAssessmentStatus,
  }
}

function dateMs(value: Date | string | null | undefined): number | null {
  if (!value) return null
  const result = value instanceof Date ? value.getTime() : Date.parse(value)
  return Number.isFinite(result) ? result : null
}

function wholeDays(milliseconds: number): number {
  return Math.max(0, Math.floor(milliseconds / 86_400_000))
}

function average(values: Array<number | null | undefined>): number | null {
  const present = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  if (present.length === 0) return null
  return Math.round((present.reduce((sum, value) => sum + value, 0) / present.length) * 10) / 10
}

export async function listProjects(filter: { status?: SpecificationProjectStatus } = {}) {
  const projects = await tenantTx(tx => tx.specificationProject.findMany({
    where: { tenantId: tenantId(), ...(filter.status ? { status: filter.status } : {}) },
    select: projectListSelect,
    orderBy: { createdAt: 'desc' },
  }))
  return { items: projects.map(shapeProject) }
}

export async function getProject(id: string) {
  const project = await tenantTx(tx => tx.specificationProject.findFirst({ where: { id, tenantId: tenantId() }, select: projectListSelect }))
  if (!project) throw new NotFoundError('SpecificationProject', id)
  return shapeProject(project)
}

export async function createProject(input: CreateProjectInput, userId: string) {
  const code = await generateProjectCode()
  const capabilityLinks = singleCapabilityLink(input.primaryCapability)
  const project = await tenantTx(async (tx) => {
    const created = await tx.specificationProject.create({
      data: {
        code,
        name: input.name,
        mission: input.mission ?? null,
        primaryCapabilityId: input.primaryCapability.id,
        primaryCapabilityName: input.primaryCapability.name,
        tokenBudget: input.tokenBudget,
        costBudgetUsd: input.costBudgetUsd ?? null,
        businessValue: input.businessValue ?? null,
        customerImpact: input.customerImpact ?? null,
        strategicAlignment: input.strategicAlignment ?? null,
        urgency: input.urgency ?? null,
        deliveryRisk: input.deliveryRisk ?? null,
        technicalRisk: input.technicalRisk ?? null,
        regulatoryRisk: input.regulatoryRisk ?? null,
        confidence: input.confidence ?? null,
        effort: input.effort ?? null,
        targetDate: input.targetDate ? new Date(input.targetDate) : null,
        reviewCadenceDays: input.reviewCadenceDays ?? 30,
        sponsorId: input.sponsorId ?? null,
        productOwnerId: input.productOwnerId ?? null,
        successMetrics: (input.successMetrics ?? []) as Prisma.InputJsonValue,
        tags: input.tags ?? [],
        createdById: userId,
        tenantId: tenantId(),
      },
    })
    await tx.specificationProjectCapability.createMany({
      data: capabilityLinks.map((capability) => ({
        projectId: created.id,
        capabilityId: capability.id,
        capabilityName: capability.name,
        role: capability.role,
        impactArea: capability.impactArea ?? null,
        tenantId: tenantId(),
      })),
    })
    await tx.capabilityImpactAssessment.createMany({
      data: capabilityLinks.map((capability) => ({
        projectId: created.id,
        capabilityId: capability.id,
        capabilityName: capability.name,
        status: 'PENDING',
        tenantId: tenantId(),
      })),
    })
    return tx.specificationProject.findUniqueOrThrow({ where: { id: created.id }, select: projectListSelect })
  })
  await logEvent('SpecificationProjectCreated', 'SpecificationProject', project.id, userId)
  await publishOutbox('SpecificationProject', project.id, 'SpecificationProjectCreated', {
    code: project.code,
    name: project.name,
    primaryCapabilityId: input.primaryCapability.id,
    tokenBudget: input.tokenBudget,
  })
  return shapeProject(project)
}

export async function updateProject(id: string, input: UpdateProjectInput, userId: string) {
  await getProject(id)
  const project = await tenantTx(async (tx) => {
    const currentProject = input.primaryCapability
      ? await tx.specificationProject.findUniqueOrThrow({
        where: { id },
        select: { primaryCapabilityId: true, primaryCapabilityName: true },
      })
      : null
    if (input.primaryCapability && input.primaryCapability.id !== currentProject?.primaryCapabilityId) {
      await assertCapabilityReassignmentAllowed(tx, id)
    }
    await tx.specificationProject.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.mission !== undefined ? { mission: input.mission } : {}),
        ...(input.primaryCapability !== undefined ? {
          primaryCapabilityId: input.primaryCapability.id,
          primaryCapabilityName: input.primaryCapability.name,
        } : {}),
        ...(input.tokenBudget !== undefined ? { tokenBudget: input.tokenBudget } : {}),
        ...(input.costBudgetUsd !== undefined ? { costBudgetUsd: input.costBudgetUsd } : {}),
        ...(input.businessValue !== undefined ? { businessValue: input.businessValue } : {}),
        ...(input.customerImpact !== undefined ? { customerImpact: input.customerImpact } : {}),
        ...(input.strategicAlignment !== undefined ? { strategicAlignment: input.strategicAlignment } : {}),
        ...(input.urgency !== undefined ? { urgency: input.urgency } : {}),
        ...(input.deliveryRisk !== undefined ? { deliveryRisk: input.deliveryRisk } : {}),
        ...(input.technicalRisk !== undefined ? { technicalRisk: input.technicalRisk } : {}),
        ...(input.regulatoryRisk !== undefined ? { regulatoryRisk: input.regulatoryRisk } : {}),
        ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
        ...(input.effort !== undefined ? { effort: input.effort } : {}),
        ...(input.targetDate !== undefined ? { targetDate: input.targetDate ? new Date(input.targetDate) : null } : {}),
        ...(input.reviewCadenceDays !== undefined ? { reviewCadenceDays: input.reviewCadenceDays } : {}),
        ...(input.lastReviewedAt !== undefined ? { lastReviewedAt: input.lastReviewedAt ? new Date(input.lastReviewedAt) : null } : {}),
        ...(input.sponsorId !== undefined ? { sponsorId: input.sponsorId } : {}),
        ...(input.productOwnerId !== undefined ? { productOwnerId: input.productOwnerId } : {}),
        ...(input.successMetrics !== undefined ? { successMetrics: input.successMetrics as Prisma.InputJsonValue } : {}),
        ...(input.tags !== undefined ? { tags: input.tags } : {}),
      },
    })
    if (input.primaryCapability) {
      const current = await tx.specificationProject.findUniqueOrThrow({
        where: { id },
        select: { primaryCapabilityId: true, primaryCapabilityName: true, capabilityLinks: true },
      })
      const primary = input.primaryCapability ?? {
        id: current.primaryCapabilityId ?? '',
        name: current.primaryCapabilityName ?? current.primaryCapabilityId ?? '',
      }
      const links = primary.id ? singleCapabilityLink(primary) : []
      await tx.specificationProjectCapability.deleteMany({ where: { projectId: id } })
      await tx.specificationProjectCapability.createMany({
        data: links.map((capability) => ({
          projectId: id,
          capabilityId: capability.id,
          capabilityName: capability.name,
          role: capability.role,
          impactArea: capability.impactArea ?? null,
          tenantId: tenantId(),
        })),
      })
      for (const capability of links) {
        await tx.capabilityImpactAssessment.upsert({
          where: { projectId_capabilityId: { projectId: id, capabilityId: capability.id } },
          create: { projectId: id, capabilityId: capability.id, capabilityName: capability.name, status: 'PENDING', tenantId: tenantId() },
          update: { capabilityName: capability.name, status: 'PENDING', error: null },
        })
      }
      await tx.capabilityImpactAssessment.deleteMany({ where: { projectId: id, capabilityId: { notIn: links.map((item) => item.id) } } })
    }
    return tx.specificationProject.findUniqueOrThrow({ where: { id }, select: projectListSelect })
  })
  await logEvent('SpecificationProjectUpdated', 'SpecificationProject', id, userId)
  return shapeProject(project)
}

async function assertCapabilityReassignmentAllowed(tx: Prisma.TransactionClient, projectId: string) {
  const tenant = tenantId()
  const [workItems, generationPlans, lockedSpecificationVersions] = await Promise.all([
    tx.workItem.count({ where: { projectId, tenantId: tenant } }),
    tx.generationPlan.count({ where: { specificationProjectId: projectId, tenantId: tenant } }),
    tx.specificationVersion.count({
      where: {
        specificationProjectId: projectId,
        tenantId: tenant,
        status: { in: ['IN_REVIEW', 'LOCKED', 'GENERATING', 'ACTIVE', 'APPROVED', 'SUPERSEDED'] },
      },
    }),
  ])
  const blockers = describeCapabilityReassignmentBlockers({ workItems, generationPlans, lockedSpecificationVersions })
  if (blockers.length > 0) {
    throw new ConflictError([
      'An initiative capability cannot be changed after execution planning has started.',
      `Found ${blockers.join(', ')}.`,
      'Create a separate initiative for another capability, or capture cross-capability impact as claims and evidence.',
    ].join(' '))
  }
}

export function describeCapabilityReassignmentBlockers(counts: CapabilityReassignmentBlockers): string[] {
  return [
    counts.workItems > 0 ? `${counts.workItems} attached work item${counts.workItems === 1 ? '' : 's'}` : null,
    counts.generationPlans > 0 ? `${counts.generationPlans} generation plan${counts.generationPlans === 1 ? '' : 's'}` : null,
    counts.lockedSpecificationVersions > 0 ? `${counts.lockedSpecificationVersions} reviewed specification version${counts.lockedSpecificationVersions === 1 ? '' : 's'}` : null,
  ].filter((value): value is string => Boolean(value))
}

function singleCapabilityLink(primary: CapabilityRef): CapabilityLinkInput[] {
  return [{ ...primary, role: 'PRIMARY' }]
}

export async function setProjectArchived(id: string, archived: boolean, userId: string) {
  await getProject(id)
  const project = await tenantTx(tx => tx.specificationProject.update({
    where: { id },
    data: archived ? { status: 'ARCHIVED', archivedAt: new Date() } : { status: 'ACTIVE', archivedAt: null },
    select: projectListSelect,
  }))
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
  const items = await tenantTx(tx => tx.workItem.findMany({ where: { projectId: id, tenantId: tenantId() }, select: workItemCardSelect, orderBy: { createdAt: 'desc' } }))
  return { items }
}

async function loadWorkItem(workItemId: string) {
  const workItem = await tenantTx(tx => tx.workItem.findFirst({ where: { id: workItemId, tenantId: tenantId() }, select: { id: true, projectId: true } }))
  if (!workItem) throw new NotFoundError('WorkItem', workItemId)
  return workItem
}

export async function attachWorkItem(projectId: string, workItemId: string, userId: string) {
  await getProject(projectId)
  const workItem = await loadWorkItem(workItemId)
  if (workItem.projectId && workItem.projectId !== projectId) {
    throw new ConflictError('Work item is already attached to a different project. Detach it first.')
  }
  const updated = await tenantTx(tx => tx.workItem.update({ where: { id: workItemId }, data: { projectId }, select: workItemCardSelect }))
  await logEvent('WorkItemAttachedToProject', 'WorkItem', workItemId, userId)
  await publishOutbox('SpecificationProject', projectId, 'WorkItemAttached', { workItemId })
  return updated
}

export async function detachWorkItem(projectId: string, workItemId: string, userId: string) {
  await getProject(projectId)
  const workItem = await loadWorkItem(workItemId)
  if (workItem.projectId !== projectId) throw new ConflictError('Work item is not attached to this project.')
  const updated = await tenantTx(tx => tx.workItem.update({ where: { id: workItemId }, data: { projectId: null }, select: workItemCardSelect }))
  await logEvent('WorkItemDetachedFromProject', 'WorkItem', workItemId, userId)
  return updated
}

// The /studio landing: active projects (with counts) + the standalone (unprojected) work items.
export async function getPortfolio() {
  return tenantTx(async tx => {
    const [{ items: projects }, standalone] = await Promise.all([
      listProjects({ status: 'ACTIVE' }),
      tx.workItem.findMany({ where: { projectId: null, tenantId: tenantId() }, select: workItemCardSelect, orderBy: { createdAt: 'desc' }, take: 50 }),
    ])
    return { projects, standaloneWorkItems: standalone }
  })
}
