import { Prisma, type ApprovalStatus } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { logEvent, publishOutbox } from '../../lib/audit'
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors'
import { approvalPermission, assertCanRequestApproval } from '../../lib/permissions/approval'
import { currentTenantDbClient, currentTenantIdForDb, withTenantDbTransaction } from '../../lib/tenant-db-context'
import { betaStats, poolEstimates } from '../rooms/belief'
import { projectSpecPackageSchema } from '../studio/studio-spec.schemas'
import { specificationPackageBodySchema } from '../specifications/specification.schemas'
import { specificationContentHash } from '../specifications/specification.hash'
import { validateSpecificationBody } from '../specifications/specification.validator'

const tenantId = () => currentTenantIdForDb() ?? 'default'
const json = (value: unknown) => value as Prisma.InputJsonValue
const db = () => currentTenantDbClient() ?? prisma

function tenantOperation<T>(operation: () => Promise<T>): Promise<T> {
  return withTenantDbTransaction(prisma, async () => operation(), tenantId())
}

async function projectOrThrow(projectId: string) {
  const project = await db().specificationProject.findFirst({ where: { id: projectId, tenantId: tenantId() } })
  if (!project) throw new NotFoundError('SpecificationProject', projectId)
  return project
}

async function listDecisionDossiersInternal(projectId: string) {
  await projectOrThrow(projectId)
  return db().decisionDossier.findMany({
    where: { projectId, tenantId: tenantId() },
    include: { options: { orderBy: { createdAt: 'asc' } } },
    orderBy: { updatedAt: 'desc' },
  })
}

async function createDecisionDossierInternal(
  projectId: string,
  input: { title: string; problem: string; claimRefs?: string[]; resolvesTensions?: string[]; options?: Array<Record<string, unknown>> },
  actorId: string,
) {
  const project = await projectOrThrow(projectId)
  const claimRefs = [...new Set(input.claimRefs ?? [])]
  if (claimRefs.length) {
    const found = await db().claim.count({ where: { id: { in: claimRefs }, projectId, tenantId: tenantId() } })
    if (found !== claimRefs.length) throw new ValidationError('Every decision claim reference must belong to this initiative')
  }
  const dossier = await db().decisionDossier.create({
    data: {
      projectId,
      title: input.title,
      problem: input.problem,
      claimRefs: json(claimRefs),
      resolvesTensions: json(input.resolvesTensions ?? []),
      createdById: actorId,
      tenantId: project.tenantId,
      options: {
        create: (input.options ?? []).map(option => ({
          title: String(option.title ?? '').trim(),
          summary: String(option.summary ?? '').trim(),
          conceptCardId: typeof option.conceptCardId === 'string' ? option.conceptCardId : null,
          claimRefs: json(Array.isArray(option.claimRefs) ? option.claimRefs : []),
          tradeoffs: json(Array.isArray(option.tradeoffs) ? option.tradeoffs : []),
          estimatedHours: numberOrNull(option.estimatedHours),
          estimatedCostLow: numberOrNull(option.estimatedCostLow),
          estimatedCostHigh: numberOrNull(option.estimatedCostHigh),
          estimatedTokens: integerOrNull(option.estimatedTokens),
          riskScore: integerOrNull(option.riskScore),
          createdById: actorId,
          tenantId: project.tenantId,
        })),
      },
    },
    include: { options: true },
  })
  await logEvent('DecisionDossierCreated', 'DecisionDossier', dossier.id, actorId, { projectId })
  await publishOutbox('DecisionDossier', dossier.id, 'DecisionDossierCreated', { projectId, actorId })
  return dossier
}

async function addDecisionOptionInternal(dossierId: string, input: Record<string, unknown>, actorId: string) {
  const dossier = await db().decisionDossier.findFirst({ where: { id: dossierId, tenantId: tenantId() } })
  if (!dossier) throw new NotFoundError('DecisionDossier', dossierId)
  if (!['DRAFT', 'CHANGES_REQUESTED'].includes(dossier.status)) throw new ConflictError(`Decision options cannot change while dossier is ${dossier.status}`)
  const option = await db().decisionOption.create({
    data: {
      dossierId,
      title: String(input.title ?? '').trim(),
      summary: String(input.summary ?? '').trim(),
      conceptCardId: typeof input.conceptCardId === 'string' ? input.conceptCardId : null,
      claimRefs: json(Array.isArray(input.claimRefs) ? input.claimRefs : []),
      tradeoffs: json(Array.isArray(input.tradeoffs) ? input.tradeoffs : []),
      estimatedHours: numberOrNull(input.estimatedHours),
      estimatedCostLow: numberOrNull(input.estimatedCostLow),
      estimatedCostHigh: numberOrNull(input.estimatedCostHigh),
      estimatedTokens: integerOrNull(input.estimatedTokens),
      riskScore: integerOrNull(input.riskScore),
      createdById: actorId,
      tenantId: dossier.tenantId,
    },
  })
  await db().decisionDossier.update({ where: { id: dossierId }, data: { revision: { increment: 1 } } })
  return option
}

async function requestDecisionReviewInternal(dossierId: string, selectedOptionId: string, actorId: string) {
  const dossier = await db().decisionDossier.findFirst({
    where: { id: dossierId, tenantId: tenantId() },
    include: { project: true, options: true },
  })
  if (!dossier) throw new NotFoundError('DecisionDossier', dossierId)
  if (!['DRAFT', 'CHANGES_REQUESTED'].includes(dossier.status)) throw new ConflictError(`Decision dossier is ${dossier.status}`)
  if (dossier.options.length < 2) throw new ValidationError('A governed decision requires at least two durable options')
  if (!dossier.options.some(option => option.id === selectedOptionId)) throw new ValidationError('Selected option does not belong to this decision dossier')
  if (!dossier.project.primaryCapabilityId) throw new ValidationError('Decision review requires a primary capability on the initiative')
  await assertCanRequestApproval(actorId, dossier.project.primaryCapabilityId, approvalPermission('workflow'), dossier.tenantId)
  const request = await withTenantDbTransaction(prisma, async tx => {
    const pending = await tx.approvalRequest.findFirst({ where: { subjectType: 'DecisionDossier', subjectId: dossierId, status: 'PENDING', tenantId: dossier.tenantId } })
    if (pending) return pending
    const created = await tx.approvalRequest.create({
      data: {
        subjectType: 'DecisionDossier',
        subjectId: dossierId,
        requestedById: actorId,
        assignmentMode: 'ROLE_BASED',
        roleKey: 'APPROVER',
        capabilityId: dossier.project.primaryCapabilityId,
        adminOverride: false,
        tenantId: dossier.tenantId,
        formData: { selectedOptionId, projectId: dossier.projectId } as Prisma.InputJsonValue,
      },
    })
    await tx.decisionDossier.update({ where: { id: dossierId }, data: { status: 'IN_REVIEW', approvalRequestId: created.id } })
    return created
  }, dossier.tenantId ?? undefined)
  await logEvent('DecisionReviewRequested', 'DecisionDossier', dossierId, actorId, { approvalRequestId: request.id, selectedOptionId })
  return request
}

async function applyDecisionApprovalInternal(
  approvalRequestId: string,
  decision: ApprovalStatus,
  actorId: string,
  comment?: string,
) {
  const request = await db().approvalRequest.findFirst({ where: { id: approvalRequestId, tenantId: tenantId(), subjectType: 'DecisionDossier' } })
  if (!request) throw new NotFoundError('ApprovalRequest', approvalRequestId)
  const dossier = await db().decisionDossier.findFirst({ where: { id: request.subjectId, tenantId: tenantId() }, include: { options: true } })
  if (!dossier) throw new NotFoundError('DecisionDossier', request.subjectId)
  if (dossier.createdById === actorId) throw new ConflictError('Decision authors cannot approve their own dossier')
  const form = request.formData && typeof request.formData === 'object' && !Array.isArray(request.formData) ? request.formData as Record<string, unknown> : {}
  const selectedOptionId = typeof form.selectedOptionId === 'string' ? form.selectedOptionId : undefined
  if (decision === 'APPROVED' || decision === 'APPROVED_WITH_CONDITIONS') {
    if (!selectedOptionId || !dossier.options.some(option => option.id === selectedOptionId)) throw new ValidationError('Approved decision has no valid selected option')
    const updated = await withTenantDbTransaction(prisma, async tx => {
      await tx.decisionOption.updateMany({ where: { dossierId: dossier.id }, data: { status: 'REJECTED' } })
      await tx.decisionOption.update({ where: { id: selectedOptionId }, data: { status: 'ACCEPTED' } })
      return tx.decisionDossier.update({
        where: { id: dossier.id },
        data: { status: 'ACCEPTED', acceptedOptionId: selectedOptionId, decidedById: actorId, decidedAt: new Date() },
        include: { options: true },
      })
    }, dossier.tenantId ?? undefined)
    await logEvent('DecisionAccepted', 'DecisionDossier', dossier.id, actorId, { selectedOptionId, approvalRequestId, comment })
    await publishOutbox('DecisionDossier', dossier.id, 'DecisionAccepted', { selectedOptionId, approvalRequestId })
    return updated
  }
  const status = decision === 'REJECTED' ? 'REJECTED' : 'CHANGES_REQUESTED'
  return db().decisionDossier.update({ where: { id: dossier.id }, data: { status } })
}

async function compileProjectSpecificationInternal(
  projectId: string,
  input: { waiverReasons?: Record<string, string> },
  actorId: string,
) {
  const project = await projectOrThrow(projectId)
  const [draft, claims, decisions, latest] = await Promise.all([
    db().projectSpecification.findUnique({ where: { projectId } }),
    db().claim.findMany({ where: { projectId, tenantId: tenantId() }, include: { estimates: true } }),
    db().decisionDossier.findMany({ where: { projectId, status: 'ACCEPTED', tenantId: tenantId() }, include: { options: true } }),
    db().specificationVersion.findFirst({ where: { specificationProjectId: projectId }, orderBy: { version: 'desc' } }),
  ])
  const source = projectSpecPackageSchema.parse(draft?.package ?? {})
  if (!source.requirements.length) throw new ValidationError('Compile requires at least one project requirement')
  const requiredClaimIds = new Set([
    ...source.requirements.flatMap(requirement => requirement.claimRefs),
    ...decisions.flatMap(decision => Array.isArray(decision.claimRefs) ? decision.claimRefs.map(String) : []),
  ])
  const waivers = input.waiverReasons ?? {}
  const blockers: Array<{ claimId: string; reason: string }> = []
  const warnings: Array<{ claimId: string; reason: string }> = []
  for (const claimId of requiredClaimIds) {
    const claim = claims.find(row => row.id === claimId)
    if (!claim) { blockers.push({ claimId, reason: 'Referenced claim is missing' }); continue }
    const stats = betaStats({ alpha: claim.alpha, beta: claim.beta })
    const disagreement = poolEstimates(claim.estimates.map(estimate => ({ probability: estimate.probability, weight: estimate.weight }))).variance
    if (stats.mean < 0.35) blockers.push({ claimId, reason: `Posterior confidence is only ${Math.round(stats.mean * 100)}%` })
    else if (stats.mean < 0.65 || disagreement > 0.05) warnings.push({ claimId, reason: `Claim remains uncertain (${Math.round(stats.mean * 100)}%, variance ${disagreement.toFixed(3)})` })
  }
  const unwaived = blockers.filter(blocker => !waivers[blocker.claimId]?.trim())
  if (unwaived.length) throw new ValidationError(`Specification lock is blocked by belief health: ${unwaived.map(item => `${item.claimId} (${item.reason})`).join(', ')}`)

  const acceptanceCriteria = source.requirements.flatMap(requirement => requirement.acceptanceCriteria.map((statement, index) => ({
    id: `AC-${requirement.id}-${index + 1}`,
    requirementIds: [requirement.id],
    given: [],
    when: [],
    then: [statement],
  })))
  const testObligations = source.requirements.map(requirement => ({
    id: `TEST-${requirement.id}`,
    verifies: [requirement.id],
    kind: 'dynamic',
    description: `Dynamically verify ${requirement.id}`,
    requiredEvidence: ['TEST_RESULT'],
    minimumCases: [],
  }))
  const body = specificationPackageBodySchema.parse({
    summary: project.mission ?? project.name,
    analysis: {
      problem: source.analysis.problem,
      goals: source.analysis.goals.map(goal => goal.metric ? `${goal.text} (${goal.metric})` : goal.text),
      stakeholders: source.analysis.stakeholders.map(stakeholder => ({ role: stakeholder.role ?? stakeholder.name, name: stakeholder.name, interest: stakeholder.concern })),
      assumptions: source.analysis.assumptions,
      constraints: source.analysis.constraints,
    },
    sources: claims.filter(claim => requiredClaimIds.has(claim.id)).map(claim => ({ id: claim.id, kind: 'CLAIM', label: claim.statement, ref: `/synthesis/rooms?claim=${claim.id}` })),
    requirements: source.requirements.map(requirement => ({
      id: requirement.id,
      statement: requirement.statement,
      priority: requirement.priority,
      rationale: requirement.rationale,
      sourceIds: requirement.claimRefs,
      acceptanceCriterionIds: acceptanceCriteria.filter(item => item.requirementIds.includes(requirement.id)).map(item => item.id),
      testObligationIds: [`TEST-${requirement.id}`],
    })),
    acceptanceCriteria,
    testObligations,
    decisions: [
      ...source.decisions,
      ...decisions.map(decision => {
        const selected = decision.options.find(option => option.id === decision.acceptedOptionId)
        return { id: decision.id, title: decision.title, status: 'ACCEPTED', context: decision.problem, decision: selected?.summary ?? '', alternatives: decision.options.filter(option => option.id !== selected?.id).map(option => option.title) }
      }),
    ],
  })
  const validation = validateSpecificationBody(body)
  if (!validation.passed) throw new ValidationError(`Compiled specification has ${validation.errorCount} blocking issue(s)`)
  const contentHash = specificationContentHash(body)
  const version = await withTenantDbTransaction(prisma, async tx => {
    const created = await tx.specificationVersion.create({
      data: {
        specificationProjectId: projectId,
        version: (latest?.version ?? 0) + 1,
        status: 'LOCKED',
        package: body as unknown as Prisma.InputJsonValue,
        contentHash,
        createdById: actorId,
        supersedesId: latest?.id,
        tenantId: project.tenantId,
      },
    })
    await tx.specificationProject.update({ where: { id: projectId }, data: { status: 'LOCKED' } })
    return created
  }, project.tenantId ?? undefined)
  await logEvent('SpecificationCompiledAndLocked', 'SpecificationProject', projectId, actorId, { versionId: version.id, contentHash, blockers, warnings, waivers })
  await publishOutbox('SpecificationProject', projectId, 'SpecificationCompiledAndLocked', { versionId: version.id, contentHash })
  return { version, contentHash, blockers, warnings, waivers, validation }
}

async function getProjectEconomicsInternal(projectId: string) {
  const project = await projectOrThrow(projectId)
  const [envelope, ledger, plans] = await Promise.all([
    db().projectBudgetEnvelope.findUnique({ where: { projectId } }),
    db().projectTokenLedgerEntry.findMany({ where: { projectId, tenantId: tenantId() }, orderBy: { createdAt: 'desc' }, take: 500 }),
    db().generationPlan.findMany({ where: { specificationProjectId: projectId }, include: { rows: true }, orderBy: { updatedAt: 'desc' } }),
  ])
  const estimated = plans.flatMap(plan => plan.rows).reduce((sum, row) => sum + (row.estimatedCostHigh ?? row.estimatedCostLow ?? 0), 0)
  const tokens = ledger.reduce((sum, entry) => sum + entry.totalTokens, 0)
  const cost = ledger.reduce((sum, entry) => sum + (entry.estimatedCostUsd ?? 0), 0)
  const tokenLimit = envelope?.tokenLimit ?? project.tokenBudget
  const budgetHigh = envelope?.budgetHigh ?? project.costBudgetUsd
  return {
    project: { id: project.id, tokenBudget: project.tokenBudget, tokenUsed: project.tokenUsed, costBudgetUsd: project.costBudgetUsd, costUsedUsd: project.costUsedUsd },
    envelope,
    rollup: {
      estimatedPlanCostHigh: estimated,
      ledgerTokens: tokens,
      ledgerCostUsd: cost,
      tokenPercent: tokenLimit ? Math.round(tokens / tokenLimit * 1000) / 10 : null,
      costPercent: budgetHigh ? Math.round(cost / budgetHigh * 1000) / 10 : null,
    },
    ledger,
    plans,
  }
}

async function upsertProjectBudgetEnvelopeInternal(projectId: string, input: Record<string, unknown>, actorId: string) {
  const project = await projectOrThrow(projectId)
  const warningPercent = integerOrNull(input.warningPercent) ?? 80
  const hardCapPercent = integerOrNull(input.hardCapPercent) ?? 120
  if (warningPercent < 1 || warningPercent > 100 || hardCapPercent < 100 || hardCapPercent > 200 || hardCapPercent <= warningPercent) {
    throw new ValidationError('Budget thresholds must satisfy 1 <= warning <= 100 < hard cap <= 200')
  }
  const envelope = await db().projectBudgetEnvelope.upsert({
    where: { projectId },
    create: {
      projectId,
      currency: typeof input.currency === 'string' ? input.currency : 'USD',
      budgetLow: numberOrNull(input.budgetLow),
      budgetHigh: numberOrNull(input.budgetHigh),
      tokenLimit: integerOrNull(input.tokenLimit),
      warningPercent,
      hardCapPercent,
      createdById: actorId,
      tenantId: project.tenantId,
    },
    update: {
      currency: typeof input.currency === 'string' ? input.currency : undefined,
      budgetLow: numberOrNull(input.budgetLow),
      budgetHigh: numberOrNull(input.budgetHigh),
      tokenLimit: integerOrNull(input.tokenLimit),
      warningPercent,
      hardCapPercent,
    },
  })
  await logEvent('ProjectBudgetEnvelopeUpdated', 'SpecificationProject', projectId, actorId, { envelopeId: envelope.id })
  return envelope
}

async function recordProjectTokenLedgerInternal(input: {
  projectId: string
  evidenceKey: string
  workflowInstanceId?: string | null
  workflowNodeId?: string | null
  artifactId?: string | null
  stage?: string | null
  provider?: string | null
  model?: string | null
  inputTokens?: number
  outputTokens?: number
  totalTokens: number
  estimatedCostUsd?: number | null
  traceId?: string | null
  metadata?: Record<string, unknown>
}) {
  const project = await projectOrThrow(input.projectId)
  return db().projectTokenLedgerEntry.upsert({
    where: { evidenceKey: input.evidenceKey },
    update: {},
    create: { ...input, metadata: json(input.metadata ?? {}), tenantId: project.tenantId },
  })
}

function numberOrNull(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

function integerOrNull(value: unknown): number | null {
  const parsed = numberOrNull(value)
  return parsed === null ? null : Math.round(parsed)
}

export const listDecisionDossiers = (projectId: string) => tenantOperation(() => listDecisionDossiersInternal(projectId))
export const createDecisionDossier = (projectId: string, input: Parameters<typeof createDecisionDossierInternal>[1], actorId: string) => tenantOperation(() => createDecisionDossierInternal(projectId, input, actorId))
export const addDecisionOption = (dossierId: string, input: Record<string, unknown>, actorId: string) => tenantOperation(() => addDecisionOptionInternal(dossierId, input, actorId))
export const requestDecisionReview = (dossierId: string, selectedOptionId: string, actorId: string) => tenantOperation(() => requestDecisionReviewInternal(dossierId, selectedOptionId, actorId))
export const applyDecisionApproval = (approvalRequestId: string, decision: ApprovalStatus, actorId: string, comment?: string) => tenantOperation(() => applyDecisionApprovalInternal(approvalRequestId, decision, actorId, comment))
export const compileProjectSpecification = (projectId: string, input: Parameters<typeof compileProjectSpecificationInternal>[1], actorId: string) => tenantOperation(() => compileProjectSpecificationInternal(projectId, input, actorId))
export const getProjectEconomics = (projectId: string) => tenantOperation(() => getProjectEconomicsInternal(projectId))
export const upsertProjectBudgetEnvelope = (projectId: string, input: Record<string, unknown>, actorId: string) => tenantOperation(() => upsertProjectBudgetEnvelopeInternal(projectId, input, actorId))
export const recordProjectTokenLedger = (input: Parameters<typeof recordProjectTokenLedgerInternal>[0]) => tenantOperation(() => recordProjectTokenLedgerInternal(input))
