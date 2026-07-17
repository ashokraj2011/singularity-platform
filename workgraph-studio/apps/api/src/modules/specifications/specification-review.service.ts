import { Prisma, type ApprovalStatus } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { logEvent, publishOutbox } from '../../lib/audit'
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors'
import { approvalPermission, assertCanRequestApproval, validateApprovalRouting, type ApprovalRouting } from '../../lib/permissions/approval'
import { withTenantDbTransaction } from '../../lib/tenant-db-context'
import { specificationPackageBodySchema } from './specification.schemas'
import { specificationContentHash } from './specification.hash'
import { validateSpecificationBody } from './specification.validator'

export type SpecificationReviewRouting = ApprovalRouting & {
  comment?: string
  quorumRequired?: number
  adminOverride?: boolean
}

function isPositive(status: ApprovalStatus | string): boolean {
  return status === 'APPROVED' || status === 'APPROVED_WITH_CONDITIONS'
}

async function loadReviewSubject(versionId: string, tenantId: string) {
  const version = await prisma.specificationVersion.findFirst({
    where: { id: versionId, tenantId },
    include: {
      workItem: { select: { id: true, tenantId: true, parentCapabilityId: true } },
      specificationProject: { select: { id: true, tenantId: true, primaryCapabilityId: true } },
    },
  })
  if (!version) throw new NotFoundError('SpecificationVersion', versionId)
  if (!version.workItemId && !version.specificationProjectId) {
    throw new ConflictError('Specification version has no owning WorkItem or specification project')
  }
  return version
}

export async function listSpecificationReviews(versionId: string, tenantId: string) {
  await loadReviewSubject(versionId, tenantId)
  return prisma.approvalRequest.findMany({
    where: { subjectType: 'SpecificationVersion', subjectId: versionId, tenantId },
    include: { decisions: { orderBy: { decidedAt: 'asc' } } },
    orderBy: { createdAt: 'desc' },
  })
}

export async function requestSpecificationReview(
  versionId: string,
  routingInput: SpecificationReviewRouting,
  actorId: string,
  tenantId: string,
) {
  const version = await loadReviewSubject(versionId, tenantId)
  if (!['DRAFT', 'CHANGES_REQUESTED', 'CHANGE_REQUESTED'].includes(String(version.status))) {
    throw new ConflictError(`Specification version is ${version.status} and cannot be submitted for review`)
  }
  const body = specificationPackageBodySchema.safeParse(version.package)
  if (!body.success) throw new ValidationError('Specification package is malformed and cannot be reviewed')
  const validation = validateSpecificationBody(body.data)
  if (!validation.passed) {
    throw new ValidationError(`Specification has ${validation.errorCount} blocking issue(s) and cannot be reviewed`)
  }

  const capabilityId = routingInput.capabilityId
    ?? version.workItem?.parentCapabilityId
    ?? version.specificationProject?.primaryCapabilityId
    ?? undefined
  const routing: ApprovalRouting = {
    assignedToId: routingInput.assignedToId,
    assignmentMode: routingInput.assignmentMode ?? (routingInput.assignedToId ? 'DIRECT_USER' : 'ROLE_BASED'),
    teamId: routingInput.teamId,
    roleKey: routingInput.roleKey ?? (routingInput.assignedToId ? undefined : 'APPROVER'),
    skillKey: routingInput.skillKey,
    capabilityId,
    dueAt: routingInput.dueAt,
  }
  try {
    validateApprovalRouting(routing)
  } catch (error) {
    throw new ValidationError(error instanceof Error ? error.message : 'Invalid specification review routing')
  }
  if (routing.assignedToId && routing.assignedToId === version.createdById) {
    throw new ValidationError('Specification authors and reviewers must be independent users')
  }
  await assertCanRequestApproval(actorId, capabilityId, approvalPermission('workflow'), tenantId)

  const review = await withTenantDbTransaction(prisma, async tx => {
    const current = await tx.specificationVersion.findFirst({ where: { id: versionId, tenantId } })
    if (!current) throw new NotFoundError('SpecificationVersion', versionId)
    if (!['DRAFT', 'CHANGES_REQUESTED', 'CHANGE_REQUESTED'].includes(String(current.status))) {
      throw new ConflictError(`Specification version is ${current.status} and cannot be submitted for review`)
    }
    const pending = await tx.approvalRequest.findFirst({
      where: { subjectType: 'SpecificationVersion', subjectId: versionId, tenantId, status: 'PENDING' },
    })
    if (pending) return { request: pending, created: false }
    const request = await tx.approvalRequest.create({
      data: {
        subjectType: 'SpecificationVersion',
        subjectId: versionId,
        requestedById: actorId,
        assignedToId: routing.assignedToId,
        assignmentMode: routing.assignmentMode,
        teamId: routing.teamId,
        roleKey: routing.roleKey,
        skillKey: routing.skillKey,
        capabilityId: routing.capabilityId,
        dueAt: routing.dueAt,
        quorumRequired: routingInput.quorumRequired ?? 1,
        adminOverride: routingInput.adminOverride ?? false,
        tenantId,
        formData: {
          specificationVersionId: versionId,
          workItemId: version.workItemId,
          specificationProjectId: version.specificationProjectId,
          comment: routingInput.comment,
        } as Prisma.InputJsonValue,
      },
    })
    await tx.specificationVersion.update({ where: { id: versionId }, data: { status: 'IN_REVIEW' } })
    if (version.workItemId) {
      await tx.workItemEvent.create({
        data: {
          workItemId: version.workItemId,
          actorId,
          tenantId,
          eventType: 'SPEC_REVIEW_REQUESTED',
          payload: { specificationVersionId: versionId, approvalRequestId: request.id } as Prisma.InputJsonValue,
        },
      })
    }
    return { request, created: true }
  }, tenantId)

  if (review.created) {
    await logEvent('SpecificationReviewRequested', 'SpecificationVersion', versionId, actorId, { approvalRequestId: review.request.id })
    await publishOutbox('SpecificationVersion', versionId, 'SpecificationReviewRequested', { approvalRequestId: review.request.id })
  }
  return review.request
}

export async function assertApprovedSpecificationReview(
  approvalRequestId: string,
  versionId: string,
  actorId: string,
  tenantId: string,
): Promise<void> {
  const request = await prisma.approvalRequest.findFirst({
    where: { id: approvalRequestId, tenantId, subjectType: 'SpecificationVersion', subjectId: versionId },
    include: { decisions: { where: { decidedById: actorId } } },
  })
  if (!request) throw new NotFoundError('ApprovalRequest', approvalRequestId)
  if (!isPositive(request.status)) throw new ConflictError('Specification review has not reached an approved decision')
  if (request.decisions.length === 0) throw new ConflictError('Approval decision actor does not match this specification review')
}

export async function applyProjectSpecificationApproval(
  versionId: string,
  approvalRequestId: string,
  actorId: string,
  comment: string | undefined,
  tenantId: string,
) {
  const version = await loadReviewSubject(versionId, tenantId)
  if (!version.specificationProjectId) throw new ValidationError('Specification version is not owned by a specification project')
  if (version.createdById && version.createdById === actorId) throw new ConflictError('Specification authors cannot approve their own version')
  await assertApprovedSpecificationReview(approvalRequestId, versionId, actorId, tenantId)
  const parsed = specificationPackageBodySchema.safeParse(version.package)
  if (!parsed.success) throw new ValidationError('Specification package is malformed')
  const validation = validateSpecificationBody(parsed.data)
  if (!validation.passed) throw new ValidationError(`Specification has ${validation.errorCount} blocking issue(s)`)
  const contentHash = specificationContentHash(parsed.data)
  const approved = await withTenantDbTransaction(prisma, async tx => {
    await tx.specificationVersion.updateMany({
      where: { specificationProjectId: version.specificationProjectId, status: 'APPROVED', id: { not: versionId } },
      data: { status: 'SUPERSEDED' },
    })
    const row = await tx.specificationVersion.update({
      where: { id: versionId },
      data: { status: 'APPROVED', contentHash, approvedById: actorId, approvedAt: new Date(), approvalComment: comment ?? null },
    })
    await tx.specificationProject.update({ where: { id: version.specificationProjectId! }, data: { status: 'ACTIVE' } })
    return row
  }, tenantId)
  await logEvent('SpecificationApproved', 'SpecificationVersion', versionId, actorId, { approvalRequestId, contentHash })
  await publishOutbox('SpecificationVersion', versionId, 'SpecificationApproved', { approvalRequestId, contentHash })
  return approved
}

export async function applySpecificationReviewRejection(
  versionId: string,
  approvalRequestId: string,
  actorId: string,
  decision: 'REJECTED' | 'NEEDS_MORE_INFORMATION',
  comment: string | undefined,
  tenantId: string,
) {
  const version = await loadReviewSubject(versionId, tenantId)
  const request = await prisma.approvalRequest.findFirst({
    where: { id: approvalRequestId, tenantId, subjectType: 'SpecificationVersion', subjectId: versionId, status: decision },
    include: { decisions: { where: { decidedById: actorId } } },
  })
  if (!request || request.decisions.length === 0) throw new ConflictError('Specification rejection is not backed by the current approval decision')
  const status = decision === 'REJECTED' ? 'REJECTED' : 'CHANGES_REQUESTED'
  const updated = await prisma.specificationVersion.update({ where: { id: versionId }, data: { status } })
  await logEvent('SpecificationReviewRejected', 'SpecificationVersion', versionId, actorId, { approvalRequestId, decision, comment })
  await publishOutbox('SpecificationVersion', versionId, 'SpecificationReviewRejected', { approvalRequestId, decision, comment })
  return updated
}
