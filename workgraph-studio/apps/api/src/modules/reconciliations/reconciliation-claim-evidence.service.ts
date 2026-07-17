import { prisma } from '../../lib/prisma'
import { logEvent, publishOutbox } from '../../lib/audit'
import { projectSpecPackageSchema } from '../studio/studio-spec.schemas'
import { recomputePosterior } from '../rooms/rooms.service'
import { betaStats } from '../rooms/belief'
import { executionThresholds } from '../portfolio-execution/execution-thresholds'

/** Close the epistemic loop: verified code outcomes become EXPERIMENT evidence on the
 * project claims that justified each requirement. Evidence keys make retries idempotent. */
export async function foldReconciliationIntoClaims(reconciliationRunId: string, actorId: string) {
  const run = await prisma.reconciliationRun.findUnique({
    where: { id: reconciliationRunId },
    include: {
      verdicts: true,
      workItem: { select: { projectId: true, tenantId: true } },
      handoffGeneration: { select: { reconciliationPolicy: true } },
    },
  })
  if (!run?.workItem.projectId || run.mode !== 'DYNAMIC') return { created: 0, claimIds: [] as string[] }
  const projectSpec = await prisma.projectSpecification.findUnique({ where: { projectId: run.workItem.projectId } })
  const parsed = projectSpecPackageSchema.safeParse(projectSpec?.package ?? {})
  const requirementClaims = new Map<string, string[]>()
  if (parsed.success) {
    for (const requirement of parsed.data.requirements) requirementClaims.set(requirement.id, requirement.claimRefs)
  }
  const policy = run.handoffGeneration?.reconciliationPolicy && typeof run.handoffGeneration.reconciliationPolicy === 'object' && !Array.isArray(run.handoffGeneration.reconciliationPolicy)
    ? run.handoffGeneration.reconciliationPolicy as Record<string, unknown>
    : {}
  const fallbackClaims = Array.isArray(policy.claimRefs) ? policy.claimRefs.map(String) : []
  const outcomes = new Map<string, boolean[]>()
  for (const verdict of run.verdicts) {
    const claimIds = requirementClaims.get(verdict.requirementId) ?? fallbackClaims
    for (const claimId of claimIds) {
      const values = outcomes.get(claimId) ?? []
      values.push(Boolean(verdict.verified && verdict.verdict === 'PASS' && run.status === 'VERIFIED_PASS'))
      outcomes.set(claimId, values)
    }
  }
  const validClaims = await prisma.claim.findMany({
    where: { id: { in: [...outcomes.keys()] }, projectId: run.workItem.projectId, tenantId: run.workItem.tenantId },
    select: { id: true },
  })
  let created = 0
  let changeRequests = 0
  const materialDriftThreshold = executionThresholds().materialDrift
  for (const claim of validClaims) {
    const existingSignal = await prisma.claimDriftSignal.findUnique({
      where: { reconciliationRunId_claimId: { reconciliationRunId: run.id, claimId: claim.id } },
    })
    // The evidence and drift pair is immutable for one reconciliation/claim.
    // A redelivery must not recalculate "before" from the already-updated posterior.
    if (existingSignal) continue
    const before = await prisma.claim.findUnique({ where: { id: claim.id }, select: { alpha: true, beta: true, statement: true } })
    if (!before) continue
    const beforeMean = betaStats(before).mean
    const supports = (outcomes.get(claim.id) ?? []).every(Boolean)
    const evidenceKey = `recon:${run.id}:${claim.id}`
    const existing = await prisma.evidence.findUnique({ where: { evidenceKey }, select: { id: true } })
    if (!existing) {
      await prisma.evidence.create({
        data: {
          claimId: claim.id,
          tier: 'EXPERIMENT',
          supports,
          weight: 10,
          evidenceKey,
          sourceUri: `/audit/trace/${run.traceId ?? run.id}`,
          note: `Dynamic reconciliation ${run.status} for WorkItem ${run.workItemId}`,
          createdById: actorId,
          tenantId: run.tenantId,
        },
      })
      created += 1
    }
    await recomputePosterior(claim.id)
    const after = await prisma.claim.findUnique({ where: { id: claim.id }, select: { alpha: true, beta: true } })
    const afterMean = after ? betaStats(after).mean : beforeMean
    const delta = afterMean - beforeMean
    const direction = delta > 0.0001 ? 'UP' : delta < -0.0001 ? 'DOWN' : 'UNCHANGED'
    const signal = await prisma.claimDriftSignal.create({
      data: { projectId: run.workItem.projectId, claimId: claim.id, reconciliationRunId: run.id, beforeMean, afterMean, delta, direction, threshold: materialDriftThreshold, traceId: run.traceId, tenantId: run.tenantId, status: Math.abs(delta) >= materialDriftThreshold ? 'MATERIAL' : 'OBSERVED' },
    })
    if (delta <= -materialDriftThreshold) {
      const currentVersion = await prisma.specificationVersion.findFirst({ where: { specificationProjectId: run.workItem.projectId, tenantId: run.tenantId }, orderBy: { version: 'desc' }, select: { id: true } })
      const existing = await prisma.specificationChangeRequest.findFirst({ where: { driftSignalId: signal.id, projectId: run.workItem.projectId } })
      if (!existing) {
        await prisma.specificationChangeRequest.create({
          data: {
            projectId: run.workItem.projectId,
            driftSignalId: signal.id,
            specificationVersionId: currentVersion?.id,
            title: `Revisit claim: ${before.statement.slice(0, 180)}`,
            reason: `Verified implementation evidence lowered confidence from ${Math.round(beforeMean * 100)}% to ${Math.round(afterMean * 100)}%. Review affected requirements before the next generation.`,
            traceId: run.traceId,
            requestedById: actorId,
            metadata: { reconciliationRunId: run.id, workItemId: run.workItemId, claimId: claim.id } as any,
            tenantId: run.tenantId,
          },
        })
        changeRequests += 1
      }
    }
  }
  if (validClaims.length) {
    const claimIds = validClaims.map(claim => claim.id)
    await logEvent('ReconciliationClaimEvidenceFolded', 'ReconciliationRun', run.id, actorId, { claimIds, created, changeRequests, traceId: run.traceId ?? undefined })
    await publishOutbox('ReconciliationRun', run.id, 'ReconciliationClaimEvidenceFolded', { claimIds, created, changeRequests, traceId: run.traceId ?? undefined, actorId })
  }
  return { created, changeRequests, claimIds: validClaims.map(claim => claim.id) }
}
