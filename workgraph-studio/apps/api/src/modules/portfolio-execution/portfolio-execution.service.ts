import { Prisma, type ApprovalStatus, type SpecificationChangeRequest } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { logEvent, publishOutbox } from '../../lib/audit'
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors'
import { approvalPermission, assertCanRequestApproval } from '../../lib/permissions/approval'
import { currentTenantDbClient, currentTenantIdForDb, currentTraceIdForRequest, withTenantDbTransaction } from '../../lib/tenant-db-context'
import { betaStats, poolEstimates } from '../rooms/belief'
import { projectSpecPackageSchema } from '../studio/studio-spec.schemas'
import { specificationPackageBodySchema } from '../specifications/specification.schemas'
import { specificationContentHash } from '../specifications/specification.hash'
import { validateSpecificationBody } from '../specifications/specification.validator'
import { deriveBudgetControl, executionThresholds } from './execution-thresholds'
import {
  assertObjectiveCoverageForLock,
  generateBusinessReadout,
  getSponsorGateDecision,
  requestBusinessReadoutSponsorApproval,
} from '../business-alignment/business-alignment.service'
import { requestSpecificationReview } from '../specifications/specification-review.service'
import { detectObjectiveCoverage, diffRequirements, uncoveredRequirementDelta } from '../business-alignment/business-alignment'
import { evaluatePilotReadiness, type PilotEvidence } from './pilot-readiness'

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
  const businessCoverage = await assertObjectiveCoverageForLock(projectId)
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
    const thresholds = executionThresholds()
    if (stats.mean < thresholds.claimBlockMean) blockers.push({ claimId, reason: `Posterior confidence is only ${Math.round(stats.mean * 100)}%` })
    else if (stats.mean < thresholds.claimWarningMean || disagreement > thresholds.claimDisagreementVariance) warnings.push({ claimId, reason: `Claim remains uncertain (${Math.round(stats.mean * 100)}%, variance ${disagreement.toFixed(3)})` })
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
      objectiveRefs: requirement.objectiveRefs,
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
  const sponsorGate = await getSponsorGateDecision(projectId)
  if (sponsorGate.required && !project.sponsorId) throw new ValidationError('This initiative exceeds the sponsor threshold but has no sponsor assigned')
  if (sponsorGate.required && project.sponsorId === actorId) throw new ValidationError('Compile must be initiated by someone other than the assigned sponsor so the sponsor gate remains independent')
  if (latest?.contentHash === contentHash && !['REJECTED', 'CHANGES_REQUESTED'].includes(String(latest.status))) {
    if (latest.status === 'APPROVED') {
      return { version: latest, contentHash, blockers, warnings, waivers, validation, businessCoverage, sponsorGate, unchanged: true }
    }
    const technicalApproval = await requestSpecificationReview(latest.id, {
      assignmentMode: 'ROLE_BASED', roleKey: 'APPROVER', capabilityId: project.primaryCapabilityId ?? undefined,
      adminOverride: false, comment: 'Technical review for compiled execution contract',
    }, actorId, project.tenantId ?? tenantId())
    let sponsorReadout = null
    let sponsorApproval = null
    if (sponsorGate.required) {
      sponsorReadout = await db().businessReadout.findFirst({
        where: { specificationVersionId: latest.id, tenantId: tenantId(), kind: 'SPONSOR', status: { in: ['DRAFT', 'PENDING_SPONSOR', 'SIGNED'] } },
        orderBy: { createdAt: 'desc' },
      }) ?? await generateBusinessReadout(projectId, { kind: 'SPONSOR', specificationVersionId: latest.id }, actorId)
      sponsorApproval = await requestBusinessReadoutSponsorApproval(sponsorReadout.id, actorId)
    }
    return { version: latest, contentHash, blockers, warnings, waivers, validation, businessCoverage, sponsorGate, technicalApproval, sponsorReadout, sponsorApproval, resumed: true }
  }
  let approvedChangeRequest: SpecificationChangeRequest | null = null
  if (latest && ['APPROVED', 'LOCKED', 'ACTIVE'].includes(String(latest.status))) {
    approvedChangeRequest = await db().specificationChangeRequest.findFirst({
      where: {
        projectId,
        specificationVersionId: latest.id,
        tenantId: tenantId(),
        status: 'APPROVED',
        resultingVersionId: null,
      },
      orderBy: { decidedAt: 'desc' },
    })
    if (!approvedChangeRequest) {
      throw new ValidationError('Post-lock specification changes require a sponsor-approved consequence-priced ChangeRequest')
    }
    const previous = specificationPackageBodySchema.safeParse(latest.package)
    if (!previous.success) throw new ValidationError('The prior specification package is malformed and cannot be amended')
    const actual = diffRequirements(previous.data.requirements, body.requirements)
    const declared = approvedChangeRequest.requirementDeltas && typeof approvedChangeRequest.requirementDeltas === 'object' && !Array.isArray(approvedChangeRequest.requirementDeltas)
      ? approvedChangeRequest.requirementDeltas as Record<string, unknown>
      : {}
    const missing = uncoveredRequirementDelta(actual, {
      added: stringArray(declared.added),
      changed: stringArray(declared.changed),
      removed: stringArray(declared.removed),
    })
    if (missing.length) throw new ValidationError(`Approved ChangeRequest does not cover actual requirement changes: ${missing.join(', ')}`)
  }
  const version = await withTenantDbTransaction(prisma, async tx => {
    const created = await tx.specificationVersion.create({
      data: {
        specificationProjectId: projectId,
        version: (latest?.version ?? 0) + 1,
        status: 'DRAFT',
        package: body as unknown as Prisma.InputJsonValue,
        contentHash,
        createdById: actorId,
        supersedesId: latest?.id,
        tenantId: project.tenantId,
      },
    })
    await tx.specificationProject.update({ where: { id: projectId }, data: { status: 'IN_REVIEW' } })
    if (approvedChangeRequest) {
      await tx.specificationChangeRequest.update({ where: { id: approvedChangeRequest.id }, data: { resultingVersionId: created.id } })
    }
    return created
  }, project.tenantId ?? undefined)
  const technicalApproval = await requestSpecificationReview(version.id, {
    assignmentMode: 'ROLE_BASED',
    roleKey: 'APPROVER',
    capabilityId: project.primaryCapabilityId ?? undefined,
    adminOverride: false,
    comment: 'Technical review for compiled execution contract',
  }, actorId, project.tenantId ?? tenantId())
  let sponsorReadout = null
  let sponsorApproval = null
  if (sponsorGate.required) {
    sponsorReadout = await generateBusinessReadout(projectId, { kind: 'SPONSOR', specificationVersionId: version.id }, actorId)
    sponsorApproval = await requestBusinessReadoutSponsorApproval(sponsorReadout.id, actorId)
  }
  await logEvent('SpecificationCompiledForReview', 'SpecificationProject', projectId, actorId, { versionId: version.id, contentHash, blockers, warnings, waivers, businessCoverage, technicalApprovalId: technicalApproval.id, sponsorGate, sponsorReadoutId: sponsorReadout?.id, sponsorApprovalId: sponsorApproval && 'id' in sponsorApproval ? sponsorApproval.id : null })
  await publishOutbox('SpecificationProject', projectId, 'SpecificationCompiledForReview', { versionId: version.id, contentHash, technicalApprovalId: technicalApproval.id, sponsorApprovalId: sponsorApproval && 'id' in sponsorApproval ? sponsorApproval.id : null })
  return { version: { ...version, status: 'IN_REVIEW' }, contentHash, blockers, warnings, waivers, validation, businessCoverage, sponsorGate, technicalApproval, sponsorReadout, sponsorApproval }
}

async function getProjectEconomicsInternal(projectId: string) {
  const project = await projectOrThrow(projectId)
  const [envelope, tenantEnvelope, ledger, plans, budgetEvents] = await Promise.all([
    db().projectBudgetEnvelope.findUnique({ where: { projectId } }),
    db().tenantBudgetEnvelope.findUnique({ where: { tenantId: tenantId() } }),
    db().projectTokenLedgerEntry.findMany({ where: { projectId, tenantId: tenantId() }, orderBy: { createdAt: 'desc' }, take: 500 }),
    db().generationPlan.findMany({ where: { specificationProjectId: projectId }, include: { rows: true, amendments: { orderBy: { generation: 'desc' } } }, orderBy: { updatedAt: 'desc' } }),
    db().projectBudgetEvent.findMany({ where: { projectId, tenantId: tenantId() }, orderBy: { createdAt: 'desc' }, take: 200 }),
  ])
  const estimated = plans.flatMap(plan => plan.rows).reduce((sum, row) => sum + (row.estimatedCostHigh ?? row.estimatedCostLow ?? 0), 0)
  const tokens = ledger.reduce((sum, entry) => sum + entry.totalTokens, 0)
  const cost = ledger.reduce((sum, entry) => sum + (entry.estimatedCostUsd ?? 0), 0)
  const tokenLimit = envelope?.tokenLimit ?? project.tokenBudget
  const budgetHigh = envelope?.budgetHigh ?? project.costBudgetUsd
  const rows = plans.flatMap(plan => plan.rows)
  const actualCost = rows.reduce((sum, row) => sum + (row.actualCostUsd ?? 0), 0)
  const actualHours = rows.reduce((sum, row) => sum + (row.actualHours ?? 0), 0)
  const slippedRows = rows.filter(row => row.projectedFinishAt && row.actualFinishAt && row.actualFinishAt > row.projectedFinishAt).length
  const budgetDecision = await evaluateProjectBudgetInternal(projectId)
  return {
    project: { id: project.id, tokenBudget: project.tokenBudget, tokenUsed: project.tokenUsed, costBudgetUsd: project.costBudgetUsd, costUsedUsd: project.costUsedUsd },
    envelope,
    tenantEnvelope,
    budgetDecision,
    budgetEvents,
    rollup: {
      estimatedPlanCostHigh: estimated,
      ledgerTokens: tokens,
      ledgerCostUsd: cost,
      tokenPercent: tokenLimit ? Math.round(tokens / tokenLimit * 1000) / 10 : null,
      costPercent: budgetHigh ? Math.round(cost / budgetHigh * 1000) / 10 : null,
      actualCostUsd: actualCost,
      actualHours,
      slippedRows,
    },
    ledger,
    plans,
  }
}

async function upsertProjectBudgetEnvelopeInternal(projectId: string, input: Record<string, unknown>, actorId: string) {
  const project = await projectOrThrow(projectId)
  const defaults = executionThresholds()
  const warningPercent = integerOrNull(input.warningPercent) ?? defaults.budgetWarningPercent
  const hardCapPercent = integerOrNull(input.hardCapPercent) ?? defaults.budgetHardCapPercent
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
      stageBudgets: json(input.stageBudgets && typeof input.stageBudgets === 'object' ? input.stageBudgets : {}),
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
      ...(input.stageBudgets && typeof input.stageBudgets === 'object' ? { stageBudgets: json(input.stageBudgets) } : {}),
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
  const entry = await db().projectTokenLedgerEntry.upsert({
    where: { evidenceKey: input.evidenceKey },
    update: {},
    create: { ...input, metadata: json(input.metadata ?? {}), tenantId: project.tenantId },
  })
  const rollup = await db().projectTokenLedgerEntry.aggregate({
    where: { projectId: input.projectId, tenantId: tenantId() },
    _sum: { totalTokens: true, estimatedCostUsd: true },
  })
  await db().specificationProject.update({
    where: { id: input.projectId },
    data: { tokenUsed: rollup._sum.totalTokens ?? 0, costUsedUsd: rollup._sum.estimatedCostUsd ?? 0 },
  })
  await evaluateProjectBudgetInternal(input.projectId, { stage: input.stage ?? undefined, traceId: input.traceId ?? undefined, record: true })
  return entry
}

type TraceNode = { id: string; type: string; label: string; status?: string | null; href?: string; detail?: string; data?: Record<string, unknown> }
type TraceEdge = { from: string; to: string; kind: string }

function stringRefs(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(stringRefs)
  if (value && typeof value === 'object') return Object.values(value as Record<string, unknown>).flatMap(stringRefs)
  return []
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : []
}

async function getProjectTraceabilityInternal(projectId: string) {
  const project = await projectOrThrow(projectId)
  const [draft, claims, dossiers, plans, archives, boards, versions, objectives] = await Promise.all([
    db().projectSpecification.findUnique({ where: { projectId } }),
    db().claim.findMany({ where: { projectId, tenantId: tenantId() }, include: { evidence: true } }),
    db().decisionDossier.findMany({ where: { projectId, tenantId: tenantId() }, include: { options: true } }),
    db().generationPlan.findMany({
      where: { specificationProjectId: projectId, tenantId: tenantId() },
      include: { rows: { include: { workItem: { include: { implementationSubmissions: true, reconciliationRuns: true, specificationBindings: true, finalizationRecords: true } } } } },
      orderBy: { createdAt: 'asc' },
    }),
    db().conceptArchive.findMany({ where: { studio: { projectId }, tenantId: tenantId() }, include: { cards: true, cells: true } }),
    db().board.findMany({ where: { projectId, tenantId: tenantId() }, include: { events: { orderBy: { eventSeq: 'asc' }, take: 1000 } } }),
    db().specificationVersion.findMany({ where: { specificationProjectId: projectId, tenantId: tenantId() }, orderBy: { version: 'asc' } }),
    db().businessObjective.findMany({ where: { tenantId: tenantId(), OR: [{ studioProjectId: projectId }, { projectLinks: { some: { projectId, tenantId: tenantId() } } }] } }),
  ])
  const parsedDraft = projectSpecPackageSchema.safeParse(draft?.package ?? {})
  const requirements = parsedDraft.success ? parsedDraft.data.requirements : []
  const nodes = new Map<string, TraceNode>()
  const edges: TraceEdge[] = []
  const edgeKeys = new Set<string>()
  const addNode = (node: TraceNode) => { if (!nodes.has(node.id)) nodes.set(node.id, node) }
  const addEdge = (from: string, to: string, kind: string) => {
    const key = `${from}:${to}:${kind}`
    if (!edgeKeys.has(key)) { edgeKeys.add(key); edges.push({ from, to, kind }) }
  }
  addNode({ id: `project:${project.id}`, type: 'initiative', label: project.name, status: project.status, href: `/synthesis/hub?projectId=${project.id}` })

  for (const objective of objectives) {
    const objectiveId = `objective:${objective.id}`
    addNode({ id: objectiveId, type: 'business-objective', label: objective.title, status: objective.status, href: `/synthesis/business?project=${projectId}&objective=${objective.id}`, data: { valueScore: objective.valueScore, targetMetric: objective.targetMetric } })
    addEdge(`project:${project.id}`, objectiveId, 'funds')
  }

  for (const board of boards) {
    addNode({ id: `board:${board.id}`, type: 'board', label: board.name, href: `/synthesis/ideas?projectId=${projectId}&boardId=${board.id}` })
    addEdge(`project:${project.id}`, `board:${board.id}`, 'explores')
  }
  const boardEvents = boards.flatMap(board => board.events.map(event => ({ board, event })))
  for (const archive of archives) {
    for (const card of archive.cards) {
      const cardId = `card:${card.id}`
      addNode({ id: cardId, type: 'option-source', label: card.title, status: card.status, href: `/synthesis/ideas?projectId=${projectId}&cardId=${card.id}`, detail: card.summary })
      addEdge(`project:${project.id}`, cardId, 'contains')
      for (const claimId of stringArray(card.claimRefs)) addEdge(cardId, `claim:${claimId}`, 'promoted-to')
    }
    for (const cell of archive.cells.filter(item => item.killed)) {
      const cellId = `killed-cell:${cell.id}`
      addNode({ id: cellId, type: 'rejected-option', label: cell.cellKey, status: 'KILLED', href: `/synthesis/options?projectId=${projectId}`, detail: cell.killReason ?? 'Rejected during portfolio selection' })
      addEdge(`project:${project.id}`, cellId, 'considered')
      if (cell.killClaimId) addEdge(cellId, `claim:${cell.killClaimId}`, 'rejected-by')
    }
  }
  for (const claim of claims) {
    const claimId = `claim:${claim.id}`
    addNode({ id: claimId, type: 'claim', label: claim.statement, status: claim.status, href: `/synthesis/rooms?projectId=${projectId}&claim=${claim.id}`, data: { mean: betaStats(claim).mean, evidenceCount: claim.evidence.length } })
    addEdge(`project:${project.id}`, claimId, 'asserts')
    const provenanceRefs = new Set(stringRefs(claim.provenance))
    for (const { board, event } of boardEvents) {
      const objectIds = stringArray(event.objectIds)
      if (provenanceRefs.has(event.id) || objectIds.some(id => provenanceRefs.has(id)) || objectIds.includes(claim.entityId ?? '')) {
        const eventId = `board-event:${event.id}`
        addNode({ id: eventId, type: 'board-object', label: `${board.name}: ${event.eventType}`, href: `/synthesis/ideas?projectId=${projectId}&boardId=${board.id}`, data: { eventSeq: event.eventSeq.toString(), objectIds } })
        addEdge(eventId, claimId, 'originated')
      }
    }
  }
  for (const requirement of requirements) {
    const requirementId = `requirement:${requirement.id}`
    addNode({ id: requirementId, type: 'requirement', label: requirement.statement, status: requirement.priority, href: `/synthesis/spec?projectId=${projectId}&requirement=${requirement.id}` })
    for (const claimId of requirement.claimRefs) addEdge(`claim:${claimId}`, requirementId, 'supports')
    for (const objectiveId of requirement.objectiveRefs) addEdge(`objective:${objectiveId}`, requirementId, 'justifies')
  }
  for (const dossier of dossiers) {
    const decisionId = `decision:${dossier.id}`
    addNode({ id: decisionId, type: 'decision', label: dossier.title, status: dossier.status, href: `/synthesis/decisions?projectId=${projectId}&decision=${dossier.id}` })
    for (const claimId of stringArray(dossier.claimRefs)) addEdge(`claim:${claimId}`, decisionId, 'informs')
    for (const option of dossier.options) {
      const optionId = `decision-option:${option.id}`
      addNode({ id: optionId, type: option.status === 'REJECTED' ? 'rejected-option' : 'decision-option', label: option.title, status: option.status, href: `/synthesis/decisions?projectId=${projectId}&decision=${dossier.id}`, detail: option.summary })
      addEdge(optionId, decisionId, option.status === 'ACCEPTED' ? 'selected-by' : 'considered-by')
      if (option.conceptCardId) addEdge(`card:${option.conceptCardId}`, optionId, 'became')
      for (const claimId of stringArray(option.claimRefs)) addEdge(`claim:${claimId}`, optionId, 'supports')
    }
  }
  for (const version of versions) {
    const versionId = `specification:${version.id}`
    addNode({ id: versionId, type: 'specification', label: `Specification v${version.version}`, status: version.status, href: `/synthesis/generate?projectId=${projectId}`, data: { contentHash: version.contentHash } })
    addEdge(`project:${project.id}`, versionId, 'compiled')
  }
  for (const plan of plans) {
    const planId = `plan:${plan.id}`
    addNode({ id: planId, type: 'generation-plan', label: `Generation plan ${plan.id.slice(0, 8)}`, status: plan.status, href: `/synthesis/generate?projectId=${projectId}&planId=${plan.id}` })
    if (plan.specificationVersionId) addEdge(`specification:${plan.specificationVersionId}`, planId, 'generated')
    for (const row of plan.rows) {
      const rowId = `plan-row:${row.id}`
      addNode({ id: rowId, type: 'plan-row', label: row.title, status: row.state, href: `/synthesis/generate?projectId=${projectId}&planId=${plan.id}` })
      addEdge(planId, rowId, 'contains')
      for (const ref of stringArray(row.requirementIds)) addEdge(`requirement:${ref}`, rowId, 'implemented-by')
      for (const ref of stringArray(row.decisionRefs)) addEdge(`decision:${ref}`, rowId, 'authorized')
      for (const ref of stringArray(row.claimRefs)) addEdge(`claim:${ref}`, rowId, 'motivates')
      if (!row.workItem) continue
      const workItemId = `work-item:${row.workItem.id}`
      addNode({ id: workItemId, type: 'work-item', label: `${row.workItem.workCode}: ${row.workItem.title}`, status: row.workItem.status, href: `/work-items?selected=${row.workItem.id}` })
      addEdge(rowId, workItemId, 'materialized')
      for (const submission of row.workItem.implementationSubmissions) {
        const submissionId = `submission:${submission.id}`
        addNode({ id: submissionId, type: 'submission', label: submission.headCommitSha ? `Check-in ${submission.headCommitSha.slice(0, 8)}` : `Submission ${submission.id.slice(0, 8)}`, status: submission.status, href: `/work-items?selected=${row.workItem.id}` })
        addEdge(workItemId, submissionId, 'checked-in')
      }
      for (const run of row.workItem.reconciliationRuns) {
        const runId = `reconciliation:${run.id}`
        addNode({ id: runId, type: 'reconciliation', label: `Reconciliation ${run.id.slice(0, 8)}`, status: run.status, href: run.traceId ? `/audit/trace/${encodeURIComponent(run.traceId)}` : `/work-items?selected=${row.workItem.id}` })
        addEdge(`submission:${run.submissionId}`, runId, 'verified-by')
      }
      for (const finalization of row.workItem.finalizationRecords) {
        const finalId = `finalization:${finalization.id}`
        addNode({ id: finalId, type: 'finalization', label: `Finalization ${finalization.finalizationGeneration}`, status: finalization.status, href: `/work-items?selected=${row.workItem.id}` })
        addEdge(workItemId, finalId, 'completed-by')
      }
    }
  }
  const connectedWorkItems = [...nodes.values()].filter(node => node.type === 'work-item').length
  const workItemsWithCompleteLineage = new Set(
    plans.flatMap(plan => plan.rows)
      .filter(row => row.workItemId && stringArray(row.requirementIds).length && stringArray(row.decisionRefs).length && stringArray(row.claimRefs).length)
      .map(row => row.workItemId!),
  ).size
  return {
    project: { id: project.id, code: project.code, name: project.name, status: project.status },
    nodes: [...nodes.values()],
    edges,
    summary: {
      boards: boards.length,
      concepts: archives.reduce((sum, archive) => sum + archive.cards.length, 0),
      rejectedOptions: [...nodes.values()].filter(node => node.type === 'rejected-option').length,
      claims: claims.length,
      requirements: requirements.length,
      objectives: objectives.length,
      fundedRequirements: requirements.filter(requirement => requirement.objectiveRefs.length > 0).length,
      decisions: dossiers.length,
      workItems: connectedWorkItems,
      reconciliations: [...nodes.values()].filter(node => node.type === 'reconciliation').length,
      completeChains: workItemsWithCompleteLineage,
    },
  }
}

async function getProjectLearningInternal(projectId: string) {
  await projectOrThrow(projectId)
  const [signals, changeRequests, claims] = await Promise.all([
    db().claimDriftSignal.findMany({ where: { projectId, tenantId: tenantId() }, include: { claim: true, reconciliationRun: true }, orderBy: { createdAt: 'desc' }, take: 500 }),
    db().specificationChangeRequest.findMany({ where: { projectId, tenantId: tenantId() }, include: { driftSignal: { include: { claim: true } }, specificationVersion: true }, orderBy: { createdAt: 'desc' }, take: 200 }),
    db().claim.findMany({ where: { projectId, tenantId: tenantId() }, select: { id: true, statement: true, alpha: true, beta: true, status: true } }),
  ])
  return {
    signals,
    changeRequests,
    claims: claims.map(claim => ({ ...claim, mean: betaStats(claim).mean })),
    summary: {
      materialDrops: signals.filter(signal => signal.direction === 'DOWN' && Math.abs(signal.delta) >= signal.threshold).length,
      materialGains: signals.filter(signal => signal.direction === 'UP' && Math.abs(signal.delta) >= signal.threshold).length,
      openChangeRequests: changeRequests.filter(request => ['RECOMMENDED', 'OPEN', 'APPROVED'].includes(request.status)).length,
    },
  }
}

async function transitionChangeRequestInternal(changeRequestId: string, status: 'OPEN' | 'APPROVED' | 'REJECTED' | 'APPLIED', actorId: string, comment?: string) {
  const request = await db().specificationChangeRequest.findFirst({ where: { id: changeRequestId, tenantId: tenantId() } })
  if (!request) throw new NotFoundError('SpecificationChangeRequest', changeRequestId)
  const allowedTransitions: Record<string, string[]> = {
    RECOMMENDED: ['OPEN'],
    OPEN: ['APPROVED', 'REJECTED'],
    APPROVED: ['APPLIED'],
    REJECTED: [],
    APPLIED: [],
  }
  if (!(allowedTransitions[request.status] ?? []).includes(status)) throw new ConflictError(`Specification change request cannot transition from ${request.status} to ${status}`)
  if (['APPROVED', 'REJECTED'].includes(status) && request.requestedById === actorId) throw new ConflictError('A change-request author cannot approve or reject their own request')
  const updated = await db().specificationChangeRequest.update({
    where: { id: request.id },
    data: {
      status,
      ...(status === 'APPROVED' || status === 'REJECTED' ? { decidedById: actorId, decidedAt: new Date() } : {}),
      ...(status === 'APPLIED' ? { appliedAt: new Date() } : {}),
      metadata: json({ ...(request.metadata && typeof request.metadata === 'object' && !Array.isArray(request.metadata) ? request.metadata as Record<string, unknown> : {}), comment: comment ?? null }),
    },
  })
  if (status === 'APPROVED') await db().specificationProject.update({ where: { id: request.projectId }, data: { status: 'CHANGE_REQUESTED' } })
  await logEvent('SpecificationChangeRequestTransitioned', 'SpecificationChangeRequest', request.id, actorId, { projectId: request.projectId, status, traceId: request.traceId ?? currentTraceIdForRequest(), comment })
  return updated
}

type BudgetEvaluationInput = { stage?: string; traceId?: string; record?: boolean }

async function evaluateProjectBudgetInternal(projectId: string, input: BudgetEvaluationInput = {}) {
  const project = await projectOrThrow(projectId)
  const [envelope, tenantEnvelope, stageLedger, projectLedger, tenantLedger] = await Promise.all([
    db().projectBudgetEnvelope.findUnique({ where: { projectId } }),
    db().tenantBudgetEnvelope.findUnique({ where: { tenantId: tenantId() } }),
    db().projectTokenLedgerEntry.aggregate({ where: { projectId, tenantId: tenantId(), ...(input.stage ? { stage: input.stage } : {}) }, _sum: { totalTokens: true, estimatedCostUsd: true } }),
    db().projectTokenLedgerEntry.aggregate({ where: { projectId, tenantId: tenantId() }, _sum: { totalTokens: true, estimatedCostUsd: true } }),
    db().projectTokenLedgerEntry.aggregate({ where: { tenantId: tenantId() }, _sum: { totalTokens: true, estimatedCostUsd: true } }),
  ])
  const stageBudgets = envelope?.stageBudgets && typeof envelope.stageBudgets === 'object' && !Array.isArray(envelope.stageBudgets) ? envelope.stageBudgets as Record<string, unknown> : {}
  const hasStageBudget = Boolean(input.stage && stageBudgets[input.stage] && typeof stageBudgets[input.stage] === 'object')
  const stageBudget = hasStageBudget ? stageBudgets[input.stage!] as Record<string, unknown> : {}
  const projectTokenLimit = hasStageBudget ? integerOrNull(stageBudget.tokenLimit) : envelope?.tokenLimit ?? project.tokenBudget
  const projectCostLimit = hasStageBudget ? numberOrNull(stageBudget.costLimitUsd) : envelope?.budgetHigh ?? project.costBudgetUsd
  const scopedLedger = hasStageBudget ? stageLedger : projectLedger
  const projectTokens = scopedLedger._sum.totalTokens ?? 0
  const projectCost = scopedLedger._sum.estimatedCostUsd ?? 0
  const projectPercent = Math.max(projectTokenLimit ? projectTokens / projectTokenLimit * 100 : 0, projectCostLimit ? projectCost / projectCostLimit * 100 : 0)
  const defaults = executionThresholds()
  const projectWarningPercent = envelope?.warningPercent ?? defaults.budgetWarningPercent
  const projectHardCapPercent = envelope?.hardCapPercent ?? defaults.budgetHardCapPercent
  const projectDecision = deriveBudgetControl(projectPercent, projectWarningPercent, projectHardCapPercent)
  const tenantTokens = tenantLedger._sum.totalTokens ?? 0
  const tenantCost = tenantLedger._sum.estimatedCostUsd ?? 0
  const tenantPercent = Math.max(tenantEnvelope?.tokenLimit ? tenantTokens / tenantEnvelope.tokenLimit * 100 : 0, tenantEnvelope?.costLimitUsd ? tenantCost / tenantEnvelope.costLimitUsd * 100 : 0)
  const tenantWarningPercent = tenantEnvelope?.warningPercent ?? defaults.budgetWarningPercent
  const tenantHardCapPercent = tenantEnvelope?.hardCapPercent ?? defaults.budgetHardCapPercent
  const tenantDecision = deriveBudgetControl(tenantPercent, tenantWarningPercent, tenantHardCapPercent)
  const severity = ['HARD_CAP', 'EXCEEDED', 'WARNING', 'HEALTHY']
  const tenantControls = severity.indexOf(tenantDecision.status) < severity.indexOf(projectDecision.status)
  const effective = tenantControls ? tenantDecision : projectDecision
  const scopeType = tenantControls ? 'TENANT' : hasStageBudget ? 'STAGE' : 'PROJECT'
  const effectiveWarningPercent = tenantControls ? tenantWarningPercent : projectWarningPercent
  const effectiveHardCapPercent = tenantControls ? tenantHardCapPercent : projectHardCapPercent
  if (input.record && effective.status !== 'HEALTHY') {
    const scopeId = tenantControls ? tenantId() : hasStageBudget ? input.stage! : projectId
    const evidenceKey = `budget:${projectId}:${scopeType}:${scopeId}:${effective.status}:${Math.floor(Math.max(projectPercent, tenantPercent))}`
    await db().projectBudgetEvent.upsert({
      where: { evidenceKey },
      update: {},
      create: { projectId, evidenceKey, scopeType, scopeId, stage: scopeType === 'STAGE' ? input.stage : null, status: effective.status, percentUsed: Math.max(projectPercent, tenantPercent), tokenUsed: projectTokens, costUsedUsd: projectCost, thresholdPercent: effective.status === 'WARNING' ? effectiveWarningPercent : effective.status === 'HARD_CAP' ? effectiveHardCapPercent : 100, action: effective.action, traceId: input.traceId ?? currentTraceIdForRequest(), metadata: json({ projectPercent, tenantPercent, controllingScope: scopeType }), tenantId: project.tenantId },
    })
  }
  return {
    effective: { ...effective, recommendedModelAlias: effective.status === 'WARNING' ? tenantEnvelope?.economyModelAlias ?? process.env.WORKGRAPH_ECONOMY_MODEL_ALIAS ?? null : null, humanActionsAllowed: true, raiseAvailable: ['EXCEEDED', 'HARD_CAP'].includes(effective.status) },
    project: { status: projectDecision.status, percentUsed: projectPercent, tokens: projectTokens, costUsd: projectCost, tokenLimit: projectTokenLimit, costLimitUsd: projectCostLimit },
    tenant: { status: tenantDecision.status, percentUsed: tenantPercent, tokens: tenantTokens, costUsd: tenantCost, tokenLimit: tenantEnvelope?.tokenLimit ?? null, costLimitUsd: tenantEnvelope?.costLimitUsd ?? null },
  }
}

async function getTenantBudgetInternal() {
  const envelope = await db().tenantBudgetEnvelope.findUnique({ where: { tenantId: tenantId() } })
  const ledger = await db().projectTokenLedgerEntry.aggregate({ where: { tenantId: tenantId() }, _sum: { totalTokens: true, estimatedCostUsd: true } })
  return { envelope, usage: { totalTokens: ledger._sum.totalTokens ?? 0, costUsd: ledger._sum.estimatedCostUsd ?? 0 } }
}

async function upsertTenantBudgetInternal(input: Record<string, unknown>, actorId: string) {
  const defaults = executionThresholds()
  const warningPercent = integerOrNull(input.warningPercent) ?? defaults.budgetWarningPercent
  const hardCapPercent = integerOrNull(input.hardCapPercent) ?? defaults.budgetHardCapPercent
  if (warningPercent < 1 || warningPercent > 100 || hardCapPercent < 100 || hardCapPercent > 200 || hardCapPercent <= warningPercent) throw new ValidationError('Tenant budget thresholds are invalid')
  return db().tenantBudgetEnvelope.upsert({
    where: { tenantId: tenantId() },
    create: { tenantId: tenantId(), currency: typeof input.currency === 'string' ? input.currency : 'USD', costLimitUsd: numberOrNull(input.costLimitUsd), tokenLimit: integerOrNull(input.tokenLimit), warningPercent, hardCapPercent, economyModelAlias: typeof input.economyModelAlias === 'string' ? input.economyModelAlias : null, createdById: actorId },
    update: { currency: typeof input.currency === 'string' ? input.currency : undefined, costLimitUsd: numberOrNull(input.costLimitUsd), tokenLimit: integerOrNull(input.tokenLimit), warningPercent, hardCapPercent, economyModelAlias: typeof input.economyModelAlias === 'string' ? input.economyModelAlias : null },
  })
}

async function getProjectPilotReadinessInternal(projectId: string) {
  const project = await projectOrThrow(projectId)
  const [traceability, learning, plans, workItems, budgetEvents, slaEvents, readouts, objectives, projectSpecification, capabilityLinks, impactAssessments, validationReports, acceptedDossiers, resolvedAttentionItems, changeRequests] = await Promise.all([
    getProjectTraceabilityInternal(projectId),
    getProjectLearningInternal(projectId),
    db().generationPlan.findMany({ where: { specificationProjectId: projectId, tenantId: tenantId() }, include: { rows: true } }),
    db().workItem.findMany({ where: { projectId, tenantId: tenantId() }, include: { reconciliationRuns: true, finalizationRecords: true } }),
    db().projectBudgetEvent.findMany({ where: { projectId, tenantId: tenantId() } }),
    db().workItemEvent.count({ where: { workItem: { projectId }, eventType: 'SLA_BREACHED', tenantId: tenantId() } }),
    db().businessReadout.findMany({ where: { studioProjectId: projectId, tenantId: tenantId() } }),
    db().businessObjective.findMany({ where: { tenantId: tenantId(), OR: [{ studioProjectId: projectId }, { projectLinks: { some: { projectId } } }] } }),
    db().projectSpecification.findUnique({ where: { projectId } }),
    db().specificationProjectCapability.findMany({ where: { projectId, tenantId: tenantId(), role: { not: 'PROPOSED' } } }),
    db().capabilityImpactAssessment.findMany({ where: { projectId, tenantId: tenantId(), status: 'COMPLETED' } }),
    db().artifactValidationReport.findMany({ where: { projectId, tenantId: tenantId() }, select: { tensions: true } }),
    db().decisionDossier.findMany({ where: { projectId, tenantId: tenantId(), status: 'ACCEPTED' }, select: { resolvesTensions: true } }),
    db().attentionItem.count({ where: { projectId, tenantId: tenantId(), status: 'RESOLVED' } }),
    db().specificationChangeRequest.findMany({ where: { projectId, tenantId: tenantId(), status: { in: ['APPROVED', 'APPLIED'] } }, select: { requirementDeltas: true, costDelta: true, scheduleDelta: true, milestoneImpacts: true } }),
  ])
  const workItemIds = workItems.map(item => item.id)
  const [approvedWaivers, finalizationEvents, failedReconciliationDriftSignals] = await Promise.all([
    workItemIds.length ? db().governanceWaiver.count({ where: { workItemId: { in: workItemIds }, status: 'APPROVED' } }) : 0,
    workItemIds.length ? db().workItemEvent.findMany({ where: { workItemId: { in: workItemIds }, eventType: 'WORK_ITEM_FINALIZED' }, select: { workItemId: true, actorId: true } }) : [],
    db().claimDriftSignal.count({ where: { projectId, tenantId: tenantId(), delta: { not: 0 }, reconciliationRun: { status: { in: ['FAILED', 'PARTIAL', 'ERROR'] } } } }),
  ])
  const origin = {
    specGenerated: workItems.filter(item => item.originType === 'SPEC_GENERATED').length,
    adHoc: workItems.filter(item => item.originType === 'AD_HOC' || item.originType === 'CAPABILITY_LOCAL').length,
  }
  const verified = workItems.filter(item => item.reconciliationRuns.some(run => run.status === 'VERIFIED_PASS' && run.reconciliationState === 'VERIFIED')).length
  const finalized = workItems.filter(item => item.finalizationRecords.some(record => record.status === 'COMPLETED')).length
  const actualRows = plans.flatMap(plan => plan.rows).filter(row => row.actualFinishAt || row.actualHours != null || row.actualCostUsd != null).length
  const estimatedActualRows = plans.flatMap(plan => plan.rows).filter(row =>
    (row.estimatedHours != null || row.estimatedCostLow != null || row.estimatedCostHigh != null || row.estimatedTokens != null)
    && (row.actualFinishAt != null || row.actualHours != null || row.actualCostUsd != null),
  ).length
  const finalizationsByWorkItem = new Map<string, number>()
  for (const event of finalizationEvents) finalizationsByWorkItem.set(event.workItemId, (finalizationsByWorkItem.get(event.workItemId) ?? 0) + 1)
  const parsedSpec = projectSpecification ? projectSpecPackageSchema.safeParse(projectSpecification.package) : null
  const objectiveCoverage = detectObjectiveCoverage(
    objectives.map(objective => ({ id: objective.id, title: objective.title, status: objective.status, valueScore: objective.valueScore })),
    parsedSpec?.success ? parsedSpec.data.requirements.map(requirement => ({ id: requirement.id, statement: requirement.statement, priority: requirement.priority, objectiveRefs: requirement.objectiveRefs })) : [],
    'portfolio',
  )
  const tensionIds = new Set(validationReports.flatMap(report => jsonRecords(report.tensions).map(tension => String(tension.id ?? '')).filter(Boolean)))
  const resolvedTensionIds = new Set(acceptedDossiers.flatMap(dossier => jsonStrings(dossier.resolvesTensions)))
  const adjudicatedTensions = [...tensionIds].filter(id => resolvedTensionIds.has(id)).length
  const morningBriefs = readouts.filter(readout => readout.kind === 'MORNING' && jsonRecords(readout.citations).length > 0 && /\bSpend:/i.test(readout.renderedMarkdown)).length
  const consequenceChangeRequests = changeRequests.filter(change =>
    Object.keys(jsonRecord(change.requirementDeltas)).length > 0
    && (Object.keys(jsonRecord(change.costDelta)).length > 0 || Object.keys(jsonRecord(change.scheduleDelta)).length > 0 || jsonRecords(change.milestoneImpacts).length > 0),
  ).length
  const capabilityIds = new Set(capabilityLinks.map(link => link.capabilityId))
  if (project.primaryCapabilityId) capabilityIds.add(project.primaryCapabilityId)
  const assessedCapabilityIds = new Set(impactAssessments.map(assessment => assessment.capabilityId))
  const evidence: PilotEvidence = {
    ideas: traceability.summary.concepts + traceability.summary.boards,
    claims: traceability.summary.claims,
    acceptedDecisions: acceptedDossiers.length,
    lockedSpecifications: traceability.nodes.filter(node => node.type === 'specification' && ['LOCKED', 'ACTIVE', 'APPROVED'].includes(String(node.status))).length,
    appliedPlans: plans.filter(plan => plan.status === 'APPLIED').length,
    workItems: traceability.summary.workItems,
    completeChains: traceability.summary.completeChains,
    verifiedWorkItems: verified,
    finalizedWorkItems: finalized,
    learningSignals: learning.signals.length,
    ownedFinalizationTransitions: finalizationEvents.filter(event => Boolean(event.actorId)).length,
    duplicateFinalizationTransitions: [...finalizationsByWorkItem.values()].filter(count => count > 1).length,
    staleReconciliations: workItems.flatMap(item => item.reconciliationRuns).filter(run => run.reconciliationState === 'STALE').length,
    approvedWaivers,
    failedReconciliationDriftSignals,
    estimateActualRows: estimatedActualRows,
    adHocWorkItems: origin.adHoc,
    budgetWarnings: budgetEvents.filter(event => event.status === 'WARNING').length,
    objectiveCoverageErrors: objectiveCoverage.errors.length,
    signedSponsorReadouts: readouts.filter(readout => readout.kind === 'SPONSOR' && readout.status === 'SIGNED' && readout.signedAt).length,
    consequenceChangeRequests,
    weeklyReadouts: readouts.filter(readout => readout.kind === 'WEEKLY').length,
    capabilityLinks: capabilityIds.size,
    assessedCapabilityLinks: [...capabilityIds].filter(id => assessedCapabilityIds.has(id)).length,
    adjudicatedTensions,
    resolvedAttentionItems,
    actionableMorningBriefs: morningBriefs,
    slaBreaches: slaEvents,
  }
  const readiness = evaluatePilotReadiness(projectId, evidence)
  return { projectId, ...readiness, metrics: { origin, verified, finalized, actualRows, specGeneratedToAdHocRatio: origin.adHoc ? origin.specGenerated / origin.adHoc : null, acceptance: evidence }, traceability: traceability.summary, learning: learning.summary }
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function jsonRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(item => item && typeof item === 'object' && !Array.isArray(item)) as Record<string, unknown>[] : []
}

function jsonStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : []
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
export const getProjectTraceability = (projectId: string) => tenantOperation(() => getProjectTraceabilityInternal(projectId))
export const getProjectLearning = (projectId: string) => tenantOperation(() => getProjectLearningInternal(projectId))
export const transitionChangeRequest = (changeRequestId: string, status: 'OPEN' | 'APPROVED' | 'REJECTED' | 'APPLIED', actorId: string, comment?: string) => tenantOperation(() => transitionChangeRequestInternal(changeRequestId, status, actorId, comment))
export const evaluateProjectBudget = (projectId: string, input?: BudgetEvaluationInput) => tenantOperation(() => evaluateProjectBudgetInternal(projectId, input))
export const getTenantBudget = () => tenantOperation(() => getTenantBudgetInternal())
export const upsertTenantBudget = (input: Record<string, unknown>, actorId: string) => tenantOperation(() => upsertTenantBudgetInternal(input, actorId))
export const getProjectPilotReadiness = (projectId: string) => tenantOperation(() => getProjectPilotReadinessInternal(projectId))
