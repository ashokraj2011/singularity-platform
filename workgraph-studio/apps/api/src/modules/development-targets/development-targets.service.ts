import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { currentTenantIdForDb, withTenantDbTransaction } from '../../lib/tenant-db-context'
import { logEvent, publishOutbox } from '../../lib/audit'
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors'
import { specificationPackageBodySchema, emptySpecificationPackageBody } from '../specifications/specification.schemas'
import type { PutDevelopmentTargetInput } from './development-target.schemas'

type WorkItemRef = { id: string; workCode: string; title: string | null; tenantId: string | null }

async function loadWorkItem(workItemId: string): Promise<WorkItemRef> {
  const workItem = await prisma.workItem.findUnique({
    where: { id: workItemId },
    select: { id: true, workCode: true, title: true, tenantId: true },
  })
  if (!workItem) throw new NotFoundError('WorkItem', workItemId)
  return workItem
}

// The approved specification a handoff builds against. When the caller doesn't pin one, the
// active version = highest-versioned APPROVED row (mirrors the spec service's active resolution).
async function resolveApprovedVersion(workItemId: string, specificationVersionId?: string) {
  if (specificationVersionId) {
    const version = await prisma.specificationVersion.findUnique({ where: { id: specificationVersionId } })
    if (!version || version.workItemId !== workItemId) throw new NotFoundError('SpecificationVersion', specificationVersionId)
    if (version.status !== 'APPROVED') {
      throw new ValidationError(`Specification version ${version.version} is ${version.status}; only an APPROVED version can be handed off to developers.`)
    }
    return version
  }
  const active = await prisma.specificationVersion.findFirst({
    where: { workItemId, status: 'APPROVED' },
    orderBy: { version: 'desc' },
  })
  if (!active) throw new ValidationError('This Work Item has no approved specification version to hand off. Approve a specification first.')
  return active
}

function requirementIdsOf(pkg: Prisma.JsonValue | null | undefined): string[] {
  const parsed = specificationPackageBodySchema.safeParse(pkg ?? {})
  const body = parsed.success ? parsed.data : emptySpecificationPackageBody()
  return body.requirements.map((r) => r.id)
}

function serialize(target: {
  id: string
  workItemId: string
  specificationVersionId: string
  repository: string
  component: string | null
  baseBranch: string
  baseCommitSha: string
  requirementIds: Prisma.JsonValue
  requiredEvidence: Prisma.JsonValue
  forbiddenPaths: Prisma.JsonValue
  reconciliationPolicy: Prisma.JsonValue
  dueAt: Date | null
  status: string
  publishedAt: Date | null
  createdAt: Date
  updatedAt: Date
}) {
  return { ...target }
}

export async function getDevelopmentTarget(workItemId: string) {
  await loadWorkItem(workItemId)
  const target = await prisma.developmentTarget.findUnique({ where: { workItemId } })
  const active = await prisma.specificationVersion.findFirst({
    where: { workItemId, status: 'APPROVED' },
    orderBy: { version: 'desc' },
    select: { id: true, version: true, contentHash: true },
  })
  return { target: target ? serialize(target) : null, activeSpecificationVersion: active }
}

export async function putDevelopmentTarget(
  workItemId: string,
  input: PutDevelopmentTargetInput,
  actorId: string,
) {
  const workItem = await loadWorkItem(workItemId)
  const spec = await resolveApprovedVersion(workItemId, input.specificationVersionId)

  // Requirement scope defaults to every requirement in the approved spec; if the caller narrows
  // it, the ids must all exist in that spec (no dangling scope).
  const specRequirementIds = requirementIdsOf(spec.package)
  const requirementIds = input.requirementIds.length ? input.requirementIds : specRequirementIds
  const unknown = requirementIds.filter((id) => !specRequirementIds.includes(id))
  if (unknown.length) {
    throw new ValidationError(`Requirement ids not present in approved specification v${spec.version}: ${unknown.join(', ')}`)
  }
  // Required-evidence entries must also point at in-scope requirements.
  const evidenceOffenders = input.requiredEvidence.filter((e) => !requirementIds.includes(e.requirementId)).map((e) => e.requirementId)
  if (evidenceOffenders.length) {
    throw new ValidationError(`Required-evidence entries reference out-of-scope requirements: ${[...new Set(evidenceOffenders)].join(', ')}`)
  }

  const tenantId = workItem.tenantId ?? currentTenantIdForDb() ?? undefined
  // Reconfiguring an existing target returns it to DRAFT — a changed base/scope must be
  // re-published before developers and reconciliation treat it as current.
  const data = {
    specificationVersionId: spec.id,
    repository: input.repository,
    component: input.component ?? null,
    baseBranch: input.baseBranch,
    baseCommitSha: input.baseCommitSha,
    requirementIds: requirementIds as unknown as Prisma.InputJsonValue,
    requiredEvidence: input.requiredEvidence as unknown as Prisma.InputJsonValue,
    forbiddenPaths: input.forbiddenPaths as unknown as Prisma.InputJsonValue,
    reconciliationPolicy: input.reconciliationPolicy as unknown as Prisma.InputJsonValue,
    dueAt: input.dueAt ? new Date(input.dueAt) : null,
    status: 'DRAFT',
    publishedAt: null,
  }
  const saved = await withTenantDbTransaction(prisma, (tx) => tx.developmentTarget.upsert({
    where: { workItemId },
    create: { workItemId, tenantId: workItem.tenantId, ...data },
    update: data,
  }), tenantId)

  return serialize(saved)
}

export async function publishDevelopmentTarget(workItemId: string, actorId: string) {
  const workItem = await loadWorkItem(workItemId)
  const target = await prisma.developmentTarget.findUnique({ where: { workItemId } })
  if (!target) throw new NotFoundError('DevelopmentTarget', workItemId)
  // The pinned spec must still be APPROVED at publish time (it could have been superseded).
  const spec = await prisma.specificationVersion.findUnique({ where: { id: target.specificationVersionId }, select: { version: true, status: true, contentHash: true } })
  if (!spec || spec.status !== 'APPROVED') {
    throw new ConflictError('The specification this handoff targets is no longer approved. Re-point the handoff at the current approved version and try again.')
  }
  const tenantId = workItem.tenantId ?? undefined
  const publishedAt = new Date()
  const published = await withTenantDbTransaction(prisma, (tx) => tx.developmentTarget.update({
    where: { workItemId },
    data: { status: 'PUBLISHED', publishedAt },
  }), tenantId)

  const payload = { developmentTargetId: published.id, specificationVersionId: target.specificationVersionId, repository: target.repository, contentHash: spec.contentHash }
  await withTenantDbTransaction(prisma, (tx) => tx.workItemEvent.create({
    data: { workItemId: workItem.id, eventType: 'DEVELOPER_PACKAGE_PUBLISHED', actorId, payload: payload as Prisma.InputJsonValue, tenantId: workItem.tenantId },
  }), tenantId)
  await logEvent('DeveloperPackagePublished', 'WorkItem', workItem.id, actorId, payload)
  await publishOutbox('WorkItem', workItem.id, 'DeveloperPackagePublished', payload)

  return serialize(published)
}

/**
 * Read-only developer package (spec §5): everything an implementer needs to build against the
 * approved spec — the spec summary + requirement scope + base commit + the submission manifest
 * template they fill in. Composed on read; not stored.
 */
export async function getDeveloperPackage(workItemId: string) {
  const workItem = await loadWorkItem(workItemId)
  const target = await prisma.developmentTarget.findUnique({ where: { workItemId } })
  if (!target) throw new NotFoundError('DevelopmentTarget', workItemId)
  const spec = await prisma.specificationVersion.findUnique({ where: { id: target.specificationVersionId } })
  if (!spec) throw new NotFoundError('SpecificationVersion', target.specificationVersionId)

  const inScope = (target.requirementIds as string[] | null) ?? []
  return {
    workItem: { id: workItem.id, workCode: workItem.workCode, title: workItem.title ?? workItem.workCode },
    specification: {
      versionId: spec.id,
      version: spec.version,
      status: spec.status,
      contentHash: spec.contentHash,
      package: spec.package,
    },
    handoff: {
      repository: target.repository,
      component: target.component,
      baseBranch: target.baseBranch,
      baseCommitSha: target.baseCommitSha,
      requirementIds: inScope,
      requiredEvidence: target.requiredEvidence,
      forbiddenPaths: target.forbiddenPaths,
      reconciliationPolicy: target.reconciliationPolicy,
      status: target.status,
      publishedAt: target.publishedAt,
    },
    // The manifest the implementer returns (see submissions module) — pre-filled with the
    // exact spec version + hash + repo + scoped requirement claims to complete.
    submissionManifestTemplate: {
      schemaVersion: '1.0',
      kind: 'singularity.implementation-submission',
      workItemCode: workItem.workCode,
      specificationVersion: spec.version,
      specificationHash: spec.contentHash,
      repository: target.repository,
      baseCommit: target.baseCommitSha,
      headCommit: '<fill-in>',
      claims: inScope.map((requirementId) => ({ requirementId, status: 'IMPLEMENTED', evidence: [] as unknown[] })),
      deviations: [] as unknown[],
    },
  }
}
