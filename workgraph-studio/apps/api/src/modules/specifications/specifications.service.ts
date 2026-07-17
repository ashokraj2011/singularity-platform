import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { currentTenantIdForDb, withTenantDbTransaction } from '../../lib/tenant-db-context'
import { logEvent, publishOutbox } from '../../lib/audit'
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors'
import {
  specificationPackageBodySchema,
  emptySpecificationPackageBody,
  type SpecificationPackage,
  type SpecificationPackageBody,
} from './specification.schemas'
import { specificationContentHash } from './specification.hash'
import { validateSpecificationBody, type SpecValidationResult } from './specification.validator'
import { getProjectSpec } from '../studio/studio-spec.service'
import type { ProjectSpecPackage } from '../studio/studio-spec.schemas'
import { assertApprovedSpecificationReview } from './specification-review.service'

type WorkItemRef = { id: string; workCode: string; title: string; tenantId: string | null }

async function loadWorkItem(workItemId: string): Promise<WorkItemRef> {
  const workItem = await prisma.workItem.findUnique({
    where: { id: workItemId },
    select: { id: true, workCode: true, title: true, tenantId: true },
  })
  if (!workItem) throw new NotFoundError('WorkItem', workItemId)
  return workItem
}

async function loadVersion(workItemId: string, versionId: string) {
  const version = await prisma.specificationVersion.findUnique({ where: { id: versionId } })
  if (!version || version.workItemId !== workItemId) throw new NotFoundError('SpecificationVersion', versionId)
  return version
}

// The stored `package` JSON keeps the body fields at top level plus a workItem/version header.
// Parse the body back out (dropping the header) so we can re-validate/edit/hash it cleanly.
function bodyOf(pkg: Prisma.JsonValue | null | undefined): SpecificationPackageBody {
  const parsed = specificationPackageBodySchema.safeParse(pkg ?? {})
  return parsed.success ? parsed.data : emptySpecificationPackageBody()
}

function composePackage(
  workItem: WorkItemRef,
  version: { id: string; number: number; status: string; revision: number; contentHash?: string | null },
  body: SpecificationPackageBody,
): SpecificationPackage {
  return {
    schemaVersion: '1.0',
    workItem: { id: workItem.id, workCode: workItem.workCode, title: workItem.title ?? workItem.workCode },
    version: {
      id: version.id,
      number: version.number,
      status: version.status,
      revision: version.revision,
      ...(version.contentHash ? { contentHash: version.contentHash } : {}),
    },
    ...body,
  }
}

function summarize(version: {
  id: string
  version: number
  revision: number
  status: string
  contentHash: string | null
  approvedById: string | null
  approvedAt: Date | null
  createdAt: Date
  package: Prisma.JsonValue
}) {
  const body = bodyOf(version.package)
  return {
    id: version.id,
    version: version.version,
    revision: version.revision,
    status: version.status,
    contentHash: version.contentHash,
    requirementCount: body.requirements.length,
    acceptanceCriteriaCount: body.acceptanceCriteria.length,
    testObligationCount: body.testObligations.length,
    openQuestionCount: body.openQuestions.filter((q) => !q.answered).length,
    approvedById: version.approvedById,
    approvedAt: version.approvedAt,
    createdAt: version.createdAt,
  }
}

export function assertIndependentSpecificationApprover(createdById: string | null, actorId: string): void {
  if (createdById && createdById === actorId) {
    throw new ConflictError('Specification authors cannot approve their own version; an independent reviewer is required.')
  }
}

async function emitWorkItemEvent(
  workItem: WorkItemRef,
  eventType: 'SPEC_DRAFT_CREATED' | 'SPEC_DRAFT_EDITED' | 'SPEC_VALIDATION_COMPLETED' | 'SPEC_APPROVED',
  actorId: string,
  auditType: string,
  payload: Record<string, unknown>,
) {
  const tenantId = workItem.tenantId ?? undefined
  await withTenantDbTransaction(prisma, (tx) => tx.workItemEvent.create({
    data: { workItemId: workItem.id, eventType, actorId, payload: payload as Prisma.InputJsonValue, tenantId: workItem.tenantId },
  }), tenantId)
  await logEvent(auditType, 'WorkItem', workItem.id, actorId, payload)
  await publishOutbox('WorkItem', workItem.id, auditType, payload)
}

export async function listSpecificationVersions(workItemId: string) {
  await loadWorkItem(workItemId)
  const rows = await prisma.specificationVersion.findMany({
    where: { workItemId },
    orderBy: { version: 'desc' },
  })
  // Active approved version = highest-versioned APPROVED row (no denormalized pointer yet).
  const activeVersionId = rows.find((row) => row.status === 'APPROVED')?.id ?? null
  return { items: rows.map(summarize), activeVersionId }
}

export async function getSpecificationVersion(workItemId: string, versionId: string): Promise<SpecificationPackage> {
  const workItem = await loadWorkItem(workItemId)
  const version = await loadVersion(workItemId, versionId)
  return composePackage(workItem, { id: version.id, number: version.version, status: version.status, revision: version.revision, contentHash: version.contentHash }, bodyOf(version.package))
}

export async function createSpecificationDraft(
  workItemId: string,
  input: { basedOnVersionId?: string; sourceIds?: string[] },
  actorId: string,
): Promise<SpecificationPackage> {
  const workItem = await loadWorkItem(workItemId)
  const highest = await prisma.specificationVersion.findFirst({ where: { workItemId }, orderBy: { version: 'desc' }, select: { version: true } })
  const nextVersion = (highest?.version ?? 0) + 1

  let body = emptySpecificationPackageBody()
  if (input.basedOnVersionId) {
    const base = await loadVersion(workItemId, input.basedOnVersionId)
    body = bodyOf(base.package)
  }
  if (input.sourceIds?.length) {
    const existing = new Set(body.sources.map((s) => s.id))
    for (const id of input.sourceIds) {
      if (!existing.has(id)) body.sources.push({ id, kind: 'DOCUMENT', label: '' })
    }
  }

  const versionId = randomUUID()
  const pkg = composePackage(workItem, { id: versionId, number: nextVersion, status: 'DRAFT', revision: 1 }, body)
  const tenantId = workItem.tenantId ?? currentTenantIdForDb() ?? undefined
  const created = await withTenantDbTransaction(prisma, (tx) => tx.specificationVersion.create({
    data: {
      id: versionId,
      workItemId,
      version: nextVersion,
      revision: 1,
      status: 'DRAFT',
      package: pkg as unknown as Prisma.InputJsonValue,
      createdById: actorId,
      supersedesId: input.basedOnVersionId ?? null,
      tenantId: workItem.tenantId,
    },
  }), tenantId)

  await emitWorkItemEvent(workItem, 'SPEC_DRAFT_CREATED', actorId, 'SpecDraftCreated', { specificationVersionId: created.id, version: nextVersion })
  return composePackage(workItem, { id: created.id, number: created.version, status: created.status, revision: created.revision }, body)
}

export async function updateSpecificationDraft(
  workItemId: string,
  versionId: string,
  input: { expectedRevision: number; body: Partial<SpecificationPackageBody> },
  actorId: string,
): Promise<SpecificationPackage> {
  const workItem = await loadWorkItem(workItemId)
  const version = await loadVersion(workItemId, versionId)
  if (version.status !== 'DRAFT' && version.status !== 'CHANGES_REQUESTED') {
    throw new ConflictError(`Specification version ${version.version} is ${version.status} and cannot be edited.`)
  }
  if (version.revision !== input.expectedRevision) {
    throw new ConflictError(`Specification was modified by someone else (expected revision ${input.expectedRevision}, current ${version.revision}). Reload and retry.`)
  }
  // Merge the supplied sections over the current body, then re-validate the whole shape.
  const merged = specificationPackageBodySchema.parse({ ...bodyOf(version.package), ...input.body })
  const nextRevision = version.revision + 1
  const pkg = composePackage(workItem, { id: version.id, number: version.version, status: version.status, revision: nextRevision }, merged)
  const tenantId = workItem.tenantId ?? undefined
  const updated = await withTenantDbTransaction(prisma, (tx) => tx.specificationVersion.update({
    where: { id: versionId },
    data: { revision: nextRevision, package: pkg as unknown as Prisma.InputJsonValue },
  }), tenantId)
  await emitWorkItemEvent(workItem, 'SPEC_DRAFT_EDITED', actorId, 'SpecificationDraftEdited', {
    specificationVersionId: updated.id,
    version: updated.version,
    fromRevision: version.revision,
    toRevision: updated.revision,
    changedSections: Object.keys(input.body).sort(),
  })
  return composePackage(workItem, { id: updated.id, number: updated.version, status: updated.status, revision: updated.revision }, merged)
}

export async function validateSpecificationVersion(workItemId: string, versionId: string): Promise<SpecValidationResult> {
  await loadWorkItem(workItemId)
  const version = await loadVersion(workItemId, versionId)
  return validateSpecificationBody(bodyOf(version.package))
}

export async function approveSpecificationVersion(
  workItemId: string,
  versionId: string,
  input: { approvalRequestId: string; comment?: string },
  actorId: string,
): Promise<SpecificationPackage> {
  const workItem = await loadWorkItem(workItemId)
  const version = await loadVersion(workItemId, versionId)
  if (version.status === 'APPROVED') throw new ConflictError(`Specification version ${version.version} is already approved.`)
  assertIndependentSpecificationApprover(version.createdById, actorId)
  if (version.status === 'SUPERSEDED' || version.status === 'REJECTED') {
    throw new ConflictError(`Specification version ${version.version} is ${version.status} and cannot be approved.`)
  }
  await assertApprovedSpecificationReview(input.approvalRequestId, versionId, actorId, workItem.tenantId ?? 'default')
  const body = bodyOf(version.package)
  const validation = validateSpecificationBody(body)
  if (!validation.passed) {
    throw new ValidationError(`Specification has ${validation.errorCount} blocking issue(s) and cannot be approved. Run validation and resolve the errors first.`)
  }
  const contentHash = specificationContentHash(body)
  const approvedAt = new Date()
  const pkg = composePackage(workItem, { id: version.id, number: version.version, status: 'APPROVED', revision: version.revision, contentHash }, body)
  const tenantId = workItem.tenantId ?? undefined

  const approvalResult = await withTenantDbTransaction(prisma, async (tx) => {
    const previousVersions = await tx.specificationVersion.findMany({
      where: { workItemId, status: 'APPROVED', id: { not: versionId } },
      select: { id: true, version: true },
    })
    // Freeze this version and supersede any previously-approved one (single active approved version).
    await tx.specificationVersion.updateMany({
      where: { workItemId, status: 'APPROVED', id: { not: versionId } },
      data: { status: 'SUPERSEDED' },
    })
    const approvedVersion = await tx.specificationVersion.update({
      where: { id: versionId },
      data: {
        status: 'APPROVED',
        contentHash,
        approvedById: actorId,
        approvedAt,
        approvalComment: input.comment ?? null,
        package: pkg as unknown as Prisma.InputJsonValue,
      },
    })
    const dependentScopes = previousVersions.length
      ? await tx.developmentScope.findMany({
          where: {
            workItemId,
            status: { notIn: ['CANCELLED', 'REWORK_REQUIRED'] },
            specificationBinding: { specificationVersionId: { in: previousVersions.map((item) => item.id) } },
          },
          select: { id: true, currentHandoffGenerationId: true },
        })
      : []
    const flaggedScopes = dependentScopes.length
      ? await tx.developmentScope.updateMany({
          where: {
            id: { in: dependentScopes.map((scope) => scope.id) },
          },
          data: { status: 'REWORK_REQUIRED' },
        })
      : { count: 0 }
    return {
      approvedVersion,
      previousVersions,
      flaggedScopeCount: flaggedScopes.count,
      flaggedHandoffIds: dependentScopes.map((scope) => scope.currentHandoffGenerationId).filter((id): id is string => Boolean(id)),
    }
  }, tenantId)
  const approved = approvalResult.approvedVersion

  await emitWorkItemEvent(workItem, 'SPEC_APPROVED', actorId, 'SpecApproved', {
    specificationVersionId: approved.id,
    version: approved.version,
    contentHash,
    supersededVersionIds: approvalResult.previousVersions.map((item) => item.id),
    flaggedScopeCount: approvalResult.flaggedScopeCount,
    flaggedHandoffIds: approvalResult.flaggedHandoffIds,
  })
  return composePackage(workItem, { id: approved.id, number: approved.version, status: approved.status, revision: approved.revision, contentHash }, body)
}

/**
 * Inheritance: a work item attached to a Specification Project draws on the project's shared
 * upstream baseline (analysis / requirements / decisions). This returns that baseline read-only
 * so the item IDE can show it as "inherited from project", with the item's own versioned spec as
 * the local delta/override layer. Returns { project: null } for a standalone (unattached) item.
 */
export async function getInheritedProjectSpec(workItemId: string): Promise<{
  project: { id: string; code: string; name: string } | null
  spec: { revision: number; package: ProjectSpecPackage; updatedAt: Date } | null
}> {
  const workItem = await prisma.workItem.findUnique({
    where: { id: workItemId },
    select: { id: true, projectId: true, project: { select: { id: true, code: true, name: true } } },
  })
  if (!workItem) throw new NotFoundError('WorkItem', workItemId)
  if (!workItem.projectId || !workItem.project) return { project: null, spec: null }
  const spec = await getProjectSpec(workItem.projectId)
  return {
    project: workItem.project,
    spec: { revision: spec.revision, package: spec.package, updatedAt: spec.updatedAt },
  }
}
