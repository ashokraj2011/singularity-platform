import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { currentTenantIdForDb, withTenantDbTransaction } from '../../lib/tenant-db-context'
import { logEvent, publishOutbox } from '../../lib/audit'
import { ConflictError, NotFoundError } from '../../lib/errors'
import type { RegisterSubmissionInput, SubmissionManifest } from './submission.schemas'
import {
  validateSubmissionManifest,
  type SubmissionValidationContext,
  type SubmissionValidationResult,
} from './submission.validator'

type WorkItemRef = { id: string; workCode: string; title: string | null; tenantId: string | null }

export type ScopedSubmissionContext = {
  developmentScopeId: string
  handoffGenerationId: string
}

async function loadWorkItem(workItemId: string): Promise<WorkItemRef> {
  const workItem = await prisma.workItem.findUnique({
    where: { id: workItemId },
    select: { id: true, workCode: true, title: true, tenantId: true },
  })
  if (!workItem) throw new NotFoundError('WorkItem', workItemId)
  return workItem
}

// The published handoff a submission is measured against, plus the approved spec it pins. Both
// must exist and be current for a submission to be meaningful; absence is a clear 4xx, not a crash.
async function loadHandoffContext(workItemId: string) {
  const target = await prisma.developmentTarget.findUnique({ where: { workItemId } })
  if (!target) throw new NotFoundError('DevelopmentTarget', workItemId)
  if (target.status !== 'PUBLISHED') {
    throw new ConflictError('The developer handoff for this Work Item is not published yet. Publish it before registering implementation submissions.')
  }
  const spec = await prisma.specificationVersion.findUnique({
    where: { id: target.specificationVersionId },
    select: { id: true, version: true, status: true, contentHash: true },
  })
  if (!spec) throw new NotFoundError('SpecificationVersion', target.specificationVersionId)
  const ctx: SubmissionValidationContext = {
    specificationHash: spec.contentHash,
    repository: target.repository,
    baseCommitSha: target.baseCommitSha,
    requirementIds: ((target.requirementIds as string[] | null) ?? []),
  }
  return { target, spec, ctx }
}

async function loadScopedHandoffContext(workItemId: string, context: ScopedSubmissionContext) {
  const handoff = await prisma.handoffGeneration.findFirst({
    where: {
      id: context.handoffGenerationId,
      developmentScopeId: context.developmentScopeId,
      status: 'PUBLISHED',
    },
    include: {
      developmentScope: {
        include: { specificationBinding: true },
      },
    },
  })
  if (!handoff || handoff.developmentScope.workItemId !== workItemId) {
    throw new NotFoundError('HandoffGeneration', context.handoffGenerationId)
  }
  const scope = handoff.developmentScope
  if (scope.status === 'CANCELLED') throw new ConflictError('The DevelopmentScope is cancelled')
  if (scope.currentHandoffGenerationId !== handoff.id) {
    throw new ConflictError('The handoff generation is stale; publish the current generation before submitting')
  }
  const binding = scope.specificationBinding
  if (!binding || binding.status !== 'CURRENT') {
    throw new ConflictError('The DevelopmentScope has no current specification binding')
  }
  const spec = await prisma.specificationVersion.findUnique({
    where: { id: binding.specificationVersionId },
    select: { id: true, version: true, status: true, contentHash: true },
  })
  if (!spec) throw new NotFoundError('SpecificationVersion', binding.specificationVersionId)
  const ctx: SubmissionValidationContext = {
    specificationHash: binding.resolvedContentHash || spec.contentHash,
    repository: handoff.repository,
    baseCommitSha: handoff.baseCommitSha,
    requirementIds: Array.isArray(handoff.requirementIds) ? handoff.requirementIds.filter((id): id is string => typeof id === 'string') : [],
  }
  return { handoff, scope, binding, spec, ctx }
}

function serialize(row: {
  id: string
  workItemId: string
  specificationVersionId: string
  specificationHash: string
  repository: string
  baseCommitSha: string
  headCommitSha: string
  pullRequestNumber: number | null
  manifest: Prisma.JsonValue
  claims: Prisma.JsonValue
  deviations: Prisma.JsonValue
  source: string
  status: string
  createdAt: Date
}) {
  return { ...row }
}

export async function listSubmissions(workItemId: string) {
  await loadWorkItem(workItemId)
  const rows = await prisma.implementationSubmission.findMany({
    where: { workItemId },
    orderBy: { createdAt: 'desc' },
  })
  return { items: rows.map(serialize) }
}

export async function getSubmission(workItemId: string, submissionId: string) {
  await loadWorkItem(workItemId)
  const row = await prisma.implementationSubmission.findUnique({ where: { id: submissionId } })
  if (!row || row.workItemId !== workItemId) throw new NotFoundError('ImplementationSubmission', submissionId)
  return serialize(row)
}

/**
 * Register one implementation attempt (spec §7). Immutable per head commit: a repeat of the same
 * (repository, headCommit) returns the existing record rather than creating a duplicate, so a
 * webhook that fires twice is idempotent and the reconciliation history is never rewritten. The
 * submission is always recorded; a failed identity check records it as REJECTED (not dropped).
 */
export async function registerSubmission(
  workItemId: string,
  input: RegisterSubmissionInput,
  actorId: string,
  scopedContext?: ScopedSubmissionContext,
) {
  const workItem = await loadWorkItem(workItemId)
  const scoped = scopedContext ? await loadScopedHandoffContext(workItemId, scopedContext) : null
  const legacy = scoped ? null : await loadHandoffContext(workItemId)
  const repository = scoped?.handoff.repository ?? legacy!.target.repository
  const specificationVersionId = scoped?.binding.specificationVersionId ?? legacy!.target.specificationVersionId
  const ctx = scoped?.ctx ?? legacy!.ctx

  const { source, ...manifest } = input
  const validation = validateSubmissionManifest(manifest as SubmissionManifest, ctx)

  // Immutable per head commit — return the prior record untouched if this SHA was already seen.
  const existing = await prisma.implementationSubmission.findUnique({
    where: { workItemId_repository_headCommitSha: { workItemId, repository, headCommitSha: manifest.headCommit } },
  })
  if (existing) {
    if (scoped && (existing.developmentScopeId !== scoped.scope.id || existing.handoffGenerationId !== scoped.handoff.id || existing.specificationBindingId !== scoped.binding.id)) {
      throw new ConflictError('This commit is already registered against a different DevelopmentScope or handoff generation')
    }
    return { submission: serialize(existing), validation, alreadyRegistered: true }
  }

  const status = validation.errorCount > 0 ? 'REJECTED' : 'RECEIVED'
  const tenantId = workItem.tenantId ?? currentTenantIdForDb() ?? undefined

  let created
  try {
    created = await withTenantDbTransaction(prisma, (tx) => tx.implementationSubmission.create({
      data: {
        workItemId,
        specificationVersionId,
        specificationBindingId: scoped?.binding.id ?? null,
        developmentScopeId: scoped?.scope.id ?? null,
        handoffGenerationId: scoped?.handoff.id ?? null,
        specificationHash: manifest.specificationHash,
        repository,
        baseCommitSha: manifest.baseCommit,
        headCommitSha: manifest.headCommit,
        pullRequestNumber: manifest.pullRequestNumber ?? null,
        manifest: manifest as unknown as Prisma.InputJsonValue,
        claims: manifest.claims as unknown as Prisma.InputJsonValue,
        deviations: manifest.deviations as unknown as Prisma.InputJsonValue,
        source,
        status,
        tenantId: workItem.tenantId,
      },
    }), tenantId)
  } catch (err) {
    // Lost a race on the unique (workItemId, repository, headCommit) — fetch and return the winner.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const winner = await prisma.implementationSubmission.findUnique({
        where: { workItemId_repository_headCommitSha: { workItemId, repository, headCommitSha: manifest.headCommit } },
      })
      if (winner) return { submission: serialize(winner), validation, alreadyRegistered: true }
    }
    throw err
  }

  const payload = {
    submissionId: created.id,
    specificationVersionId,
    specificationVersion: scoped?.spec.version ?? legacy!.spec.version,
    specificationBindingId: scoped?.binding.id ?? null,
    developmentScopeId: scoped?.scope.id ?? null,
    handoffGenerationId: scoped?.handoff.id ?? null,
    repository,
    headCommit: manifest.headCommit,
    pullRequestNumber: manifest.pullRequestNumber ?? null,
    source,
    status,
    valid: validation.passed,
  }
  await withTenantDbTransaction(prisma, (tx) => tx.workItemEvent.create({
    data: { workItemId: workItem.id, eventType: 'IMPLEMENTATION_SUBMITTED', actorId, payload: payload as Prisma.InputJsonValue, tenantId: workItem.tenantId },
  }), tenantId)
  await logEvent('ImplementationSubmitted', 'WorkItem', workItem.id, actorId, payload)
  await publishOutbox('WorkItem', workItem.id, 'ImplementationSubmitted', payload)

  return { submission: serialize(created), validation, alreadyRegistered: false }
}

/** Re-run the deterministic checks against the current handoff/spec (read-only, no mutation). */
export async function validateSubmission(workItemId: string, submissionId: string): Promise<SubmissionValidationResult> {
  await loadWorkItem(workItemId)
  const row = await prisma.implementationSubmission.findUnique({ where: { id: submissionId } })
  if (!row || row.workItemId !== workItemId) throw new NotFoundError('ImplementationSubmission', submissionId)
  const { ctx } = await loadHandoffContext(workItemId)
  return validateSubmissionManifest(row.manifest as unknown as SubmissionManifest, ctx)
}
