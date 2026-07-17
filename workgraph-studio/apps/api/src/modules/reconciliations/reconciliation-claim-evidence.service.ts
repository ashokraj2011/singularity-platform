import { prisma } from '../../lib/prisma'
import { logEvent, publishOutbox } from '../../lib/audit'
import { projectSpecPackageSchema } from '../studio/studio-spec.schemas'
import { recomputePosterior } from '../rooms/rooms.service'

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
  for (const claim of validClaims) {
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
  }
  if (validClaims.length) {
    const claimIds = validClaims.map(claim => claim.id)
    await logEvent('ReconciliationClaimEvidenceFolded', 'ReconciliationRun', run.id, actorId, { claimIds, created })
    await publishOutbox('ReconciliationRun', run.id, 'ReconciliationClaimEvidenceFolded', { claimIds, created })
  }
  return { created, claimIds: validClaims.map(claim => claim.id) }
}
