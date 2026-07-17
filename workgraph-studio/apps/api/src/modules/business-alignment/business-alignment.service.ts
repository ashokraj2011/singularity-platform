import { createHash } from 'node:crypto'
import { Prisma, type ApprovalStatus, type BusinessMilestoneStatus } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { logEvent, publishOutbox } from '../../lib/audit'
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors'
import { approvalPermission, assertCanRequestApproval } from '../../lib/permissions/approval'
import { currentTenantDbClient, currentTenantIdForDb, currentTraceIdForRequest, withTenantDbTransaction } from '../../lib/tenant-db-context'
import { betaStats } from '../rooms/belief'
import { projectSpecPackageSchema, type ProjectSpecPackage } from '../studio/studio-spec.schemas'
import {
  buildValueDeliveredCurve,
  deriveMilestoneStatus,
  detectObjectiveCoverage,
  type ObjectiveCoverageInput,
  type RequirementCoverageInput,
} from './business-alignment'

const tenantId = () => currentTenantIdForDb() ?? 'default'
const db = () => currentTenantDbClient() ?? prisma
const json = (value: unknown) => value as Prisma.InputJsonValue

function tenantOperation<T>(operation: () => Promise<T>): Promise<T> {
  return withTenantDbTransaction(prisma, async () => operation(), tenantId())
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.map(String).filter(Boolean))] : []
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, stable(entry)]))
  return value
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')
}

async function projectOrThrow(projectId: string) {
  const project = await db().specificationProject.findFirst({ where: { id: projectId, tenantId: tenantId() } })
  if (!project) throw new NotFoundError('SpecificationProject', projectId)
  return project
}

function objectiveProjectWhere(projectId: string) {
  return {
    tenantId: tenantId(),
    OR: [
      { studioProjectId: projectId },
      { projectLinks: { some: { projectId, tenantId: tenantId() } } },
    ],
  }
}

async function listObjectivesInternal(projectId?: string) {
  if (projectId) await projectOrThrow(projectId)
  return db().businessObjective.findMany({
    where: projectId ? objectiveProjectWhere(projectId) : { tenantId: tenantId() },
    include: { projectLinks: { include: { project: { select: { id: true, code: true, name: true } } } }, primaryProject: { select: { id: true, code: true, name: true } } },
    orderBy: [{ status: 'asc' }, { valueScore: 'desc' }, { updatedAt: 'desc' }],
  })
}

type ObjectiveInput = {
  title: string
  description: string
  ownerId: string
  targetMetric: Record<string, unknown>
  valueScore: number
  valueRationale?: string | null
  budgetLineRef?: string | null
  period: Record<string, unknown>
  status?: 'ACTIVE' | 'ACHIEVED_DECLARED' | 'DROPPED' | 'DEFERRED'
  projectIds: string[]
  studioProjectId?: string | null
}

async function createObjectiveInternal(input: ObjectiveInput, actorId: string) {
  const projectIds = [...new Set([...(input.projectIds ?? []), ...(input.studioProjectId ? [input.studioProjectId] : [])])]
  if (!projectIds.length) throw new ValidationError('A business objective must be linked to at least one initiative')
  const projects = await db().specificationProject.findMany({ where: { id: { in: projectIds }, tenantId: tenantId() }, select: { id: true } })
  if (projects.length !== projectIds.length) throw new ValidationError('Every linked initiative must belong to the current tenant')
  if (input.valueScore < 1 || input.valueScore > 5) throw new ValidationError('Objective valueScore must be between 1 and 5')
  const objective = await db().businessObjective.create({
    data: {
      title: input.title,
      description: input.description,
      ownerId: input.ownerId,
      targetMetric: json(input.targetMetric),
      valueScore: input.valueScore,
      valueRationale: input.valueRationale,
      budgetLineRef: input.budgetLineRef,
      period: json(input.period),
      status: input.status ?? 'ACTIVE',
      studioProjectId: input.studioProjectId ?? projectIds[0],
      tenantId: tenantId(),
      createdById: actorId,
      projectLinks: { create: projectIds.map(projectId => ({ projectId, tenantId: tenantId(), createdById: actorId })) },
    },
    include: { projectLinks: true },
  })
  await logEvent('BusinessObjectiveCreated', 'BusinessObjective', objective.id, actorId, { projectIds, valueScore: objective.valueScore })
  await publishOutbox('BusinessObjective', objective.id, 'BusinessObjectiveCreated', { projectIds })
  return objective
}

async function updateObjectiveInternal(objectiveId: string, input: Partial<ObjectiveInput>, actorId: string) {
  const objective = await db().businessObjective.findFirst({ where: { id: objectiveId, tenantId: tenantId() } })
  if (!objective) throw new NotFoundError('BusinessObjective', objectiveId)
  if (input.valueScore != null && (input.valueScore < 1 || input.valueScore > 5)) throw new ValidationError('Objective valueScore must be between 1 and 5')
  const projectIds = input.projectIds ? [...new Set(input.projectIds)] : undefined
  if (projectIds) {
    if (!projectIds.length) throw new ValidationError('A business objective must remain linked to at least one initiative')
    const projects = await db().specificationProject.count({ where: { id: { in: projectIds }, tenantId: tenantId() } })
    if (projects !== projectIds.length) throw new ValidationError('Every linked initiative must belong to the current tenant')
  }
  const updated = await withTenantDbTransaction(prisma, async tx => {
    if (projectIds) {
      await tx.businessObjectiveProject.deleteMany({ where: { objectiveId, tenantId: tenantId() } })
      await tx.businessObjectiveProject.createMany({ data: projectIds.map(projectId => ({ objectiveId, projectId, tenantId: tenantId(), createdById: actorId })) })
    }
    return tx.businessObjective.update({
      where: { id: objectiveId },
      data: {
        title: input.title,
        description: input.description,
        ownerId: input.ownerId,
        ...(input.targetMetric ? { targetMetric: json(input.targetMetric) } : {}),
        valueScore: input.valueScore,
        valueRationale: input.valueRationale,
        budgetLineRef: input.budgetLineRef,
        ...(input.period ? { period: json(input.period) } : {}),
        status: input.status,
        studioProjectId: input.studioProjectId === undefined ? undefined : input.studioProjectId,
      },
      include: { projectLinks: true },
    })
  }, tenantId())
  await logEvent('BusinessObjectiveUpdated', 'BusinessObjective', objectiveId, actorId, { projectIds })
  return updated
}

async function loadCoverageInputs(projectId: string): Promise<{
  project: Awaited<ReturnType<typeof projectOrThrow>>
  source: ProjectSpecPackage
  objectives: ObjectiveCoverageInput[]
  requirements: RequirementCoverageInput[]
}> {
  const project = await projectOrThrow(projectId)
  const [draft, objectives] = await Promise.all([
    db().projectSpecification.findUnique({ where: { projectId } }),
    listObjectivesInternal(projectId),
  ])
  const source = projectSpecPackageSchema.parse(draft?.package ?? {})
  return {
    project,
    source,
    objectives: objectives.map(objective => ({ id: objective.id, title: objective.title, status: objective.status, valueScore: objective.valueScore })),
    requirements: source.requirements.map(requirement => ({ id: requirement.id, statement: requirement.statement, priority: requirement.priority, objectiveRefs: requirement.objectiveRefs })),
  }
}

async function getObjectiveCoverageInternal(projectId: string, mode: 'hub' | 'lock' | 'portfolio' = 'hub') {
  const input = await loadCoverageInputs(projectId)
  const result = detectObjectiveCoverage(input.objectives, input.requirements, mode)
  return { projectId, ...result, objectives: input.objectives, requirements: input.requirements }
}

async function assertObjectiveCoverageForLockInternal(projectId: string) {
  const coverage = await getObjectiveCoverageInternal(projectId, 'lock')
  if (coverage.errors.length) throw new ValidationError(`Business alignment blocks specification lock: ${coverage.errors.map(issue => issue.message).join('; ')}`)
  return coverage
}

type MilestoneInput = {
  name: string
  valueStatement: string
  targetDate: Date
  completionDefinition: { rule: 'ALL'; planRowIds?: string[]; workItemIds?: string[] }
}

async function createMilestoneInternal(projectId: string, input: MilestoneInput, actorId: string) {
  const project = await projectOrThrow(projectId)
  const planRowIds = strings(input.completionDefinition.planRowIds)
  if (planRowIds.length) {
    const count = await db().generationPlanRow.count({ where: { id: { in: planRowIds }, plan: { specificationProjectId: projectId, tenantId: tenantId() } } })
    if (count !== planRowIds.length) throw new ValidationError('Every milestone plan row must belong to this initiative')
  }
  const milestone = await db().businessMilestone.create({
    data: { studioProjectId: projectId, tenantId: project.tenantId ?? tenantId(), name: input.name, valueStatement: input.valueStatement, targetDate: input.targetDate, completionDefinition: json(input.completionDefinition), createdById: actorId },
  })
  if (planRowIds.length) await db().generationPlanRow.updateMany({ where: { id: { in: planRowIds } }, data: { milestoneId: milestone.id } })
  await logEvent('BusinessMilestoneCreated', 'BusinessMilestone', milestone.id, actorId, { projectId, planRowIds })
  return milestone
}

async function listMilestonesInternal(projectId: string) {
  await projectOrThrow(projectId)
  const milestones = await db().businessMilestone.findMany({
    where: { studioProjectId: projectId, tenantId: tenantId() },
    include: { planRows: { include: { workItem: { include: { finalizationRecords: { where: { status: 'COMPLETED' }, select: { id: true } } } } } } },
    orderBy: { targetDate: 'asc' },
  })
  return Promise.all(milestones.map(async milestone => {
    const definition = record(milestone.completionDefinition)
    const explicitWorkItemIds = strings(definition.workItemIds)
    const rows = strings(definition.planRowIds).length
      ? milestone.planRows.filter(row => strings(definition.planRowIds).includes(row.id))
      : milestone.planRows
    const workItems = new Map(rows.filter(row => row.workItem).map(row => [row.workItem!.id, row.workItem!]))
    if (explicitWorkItemIds.length) {
      const extras = await db().workItem.findMany({ where: { id: { in: explicitWorkItemIds }, projectId, tenantId: tenantId() }, include: { finalizationRecords: { where: { status: 'COMPLETED' }, select: { id: true } } } })
      extras.forEach(item => workItems.set(item.id, item))
    }
    const projectedFinishAt = rows.map(row => row.projectedFinishAt).filter((date): date is Date => Boolean(date)).sort((left, right) => right.getTime() - left.getTime())[0]
    const completed = [...workItems.values()].filter(item => item.finalizationRecords.length > 0).length
    const status = deriveMilestoneStatus({ targetDate: milestone.targetDate, projectedFinishAt, completed, total: workItems.size })
    if (status !== milestone.status) await db().businessMilestone.update({ where: { id: milestone.id }, data: { status } })
    return { ...milestone, status, projectedFinishAt, completed, total: workItems.size, percentComplete: workItems.size ? Math.round(completed / workItems.size * 100) : 0 }
  }))
}

type RiskCandidate = {
  sourceType: string
  sourceId: string
  category: string
  title: string
  description: string
  ownerId?: string | null
  severity: number
  sourceHref?: string | null
  metadata?: Record<string, unknown>
}

async function composeRisksInternal(projectId: string) {
  const project = await projectOrThrow(projectId)
  const [draft, claims, boards, verdicts, budgetEvents, driftSignals, planRows] = await Promise.all([
    db().projectSpecification.findUnique({ where: { projectId } }),
    db().claim.findMany({ where: { projectId, tenantId: tenantId() } }),
    db().board.findMany({ where: { projectId, tenantId: tenantId() }, select: { id: true } }),
    db().agentVerdict.findMany({ where: { tenantId: tenantId(), status: 'OPEN', stance: { in: ['CHALLENGE', 'FLAG'] } } }),
    db().projectBudgetEvent.findMany({ where: { projectId, tenantId: tenantId(), status: { in: ['WARNING', 'EXCEEDED', 'HARD_CAP'] } }, orderBy: { createdAt: 'desc' }, take: 10 }),
    db().claimDriftSignal.findMany({ where: { projectId, tenantId: tenantId(), status: 'OPEN' }, include: { claim: true }, orderBy: { createdAt: 'desc' }, take: 20 }),
    db().generationPlanRow.findMany({ where: { plan: { specificationProjectId: projectId, tenantId: tenantId() }, criticalPath: true }, orderBy: { projectedFinishAt: 'desc' } }),
  ])
  const source = projectSpecPackageSchema.parse(draft?.package ?? {})
  const mustClaimIds = new Set(source.requirements.filter(requirement => requirement.priority === 'MUST').flatMap(requirement => requirement.claimRefs))
  const boardIds = new Set(boards.map(board => board.id))
  const candidates: RiskCandidate[] = []
  for (const claim of claims.filter(row => mustClaimIds.has(row.id) && betaStats(row).mean < 0.65)) {
    candidates.push({ sourceType: 'CLAIM', sourceId: claim.id, category: 'EPISTEMIC', title: 'MUST requirement depends on a contested claim', description: `${claim.statement} (${Math.round(betaStats(claim).mean * 100)}% posterior confidence)`, ownerId: claim.stewardId, severity: betaStats(claim).mean < 0.35 ? 5 : 4, sourceHref: `/synthesis/rooms?projectId=${projectId}&claim=${claim.id}` })
  }
  const projectClaimIds = new Set(claims.map(claim => claim.id))
  for (const verdict of verdicts.filter(row => (row.boardId ? boardIds.has(row.boardId) : projectClaimIds.has(row.targetRef)))) {
    candidates.push({ sourceType: 'AGENT_VERDICT', sourceId: verdict.id, category: verdict.agentRole === 'SENTINEL' ? 'COMPLIANCE' : 'DESIGN', title: `${verdict.agentRole} ${verdict.stance.toLowerCase()}`, description: verdict.rationale, severity: verdict.stance === 'FLAG' ? 5 : 4, sourceHref: `/synthesis/ideas?projectId=${projectId}` })
  }
  for (const event of budgetEvents) {
    candidates.push({ sourceType: 'BUDGET_EVENT', sourceId: event.id, category: 'FINANCIAL', title: `${event.scopeType.toLowerCase()} budget ${event.status.toLowerCase()}`, description: `${event.percentUsed.toFixed(1)}% consumed; recommended action: ${event.action}`, severity: event.status === 'HARD_CAP' ? 5 : event.status === 'EXCEEDED' ? 4 : 3, sourceHref: `/synthesis/economics?projectId=${projectId}`, metadata: { traceId: event.traceId } })
  }
  for (const signal of driftSignals) {
    candidates.push({ sourceType: 'CLAIM_DRIFT', sourceId: signal.id, category: 'WORLD_MOVED', title: 'Material claim drift', description: `${signal.claim.statement} moved ${signal.delta.toFixed(3)} (${signal.direction.toLowerCase()})`, ownerId: signal.claim.stewardId, severity: Math.abs(signal.delta) >= signal.threshold * 2 ? 5 : 4, sourceHref: `/synthesis/learning?projectId=${projectId}`, metadata: { traceId: signal.traceId } })
  }
  for (const row of planRows.filter(row => row.projectedFinishAt && project.targetDate && row.projectedFinishAt > project.targetDate)) {
    candidates.push({ sourceType: 'PLAN_ROW', sourceId: row.id, category: 'DELIVERY', title: `Critical-path row ${row.rowKey} projects late`, description: `${row.title} projects to finish ${row.projectedFinishAt!.toISOString().slice(0, 10)}, after the initiative target`, severity: 4, sourceHref: `/synthesis/economics?projectId=${projectId}` })
  }
  for (const candidate of candidates) {
    await db().businessRisk.upsert({
      where: { studioProjectId_sourceType_sourceId: { studioProjectId: projectId, sourceType: candidate.sourceType, sourceId: candidate.sourceId } },
      create: { ...candidate, studioProjectId: projectId, tenantId: project.tenantId ?? tenantId(), metadata: json(candidate.metadata ?? {}) },
      update: { category: candidate.category, title: candidate.title, description: candidate.description, ownerId: candidate.ownerId, severity: candidate.severity, sourceHref: candidate.sourceHref, metadata: json(candidate.metadata ?? {}) },
    })
  }
  return db().businessRisk.findMany({ where: { studioProjectId: projectId, tenantId: tenantId() }, orderBy: [{ status: 'asc' }, { severity: 'desc' }, { updatedAt: 'desc' }] })
}

async function updateRiskInternal(riskId: string, input: { ownerId?: string | null; mitigation?: string | null; status?: 'OPEN' | 'MITIGATING' | 'ACCEPTED' | 'CLOSED' }, actorId: string) {
  const risk = await db().businessRisk.findFirst({ where: { id: riskId, tenantId: tenantId() } })
  if (!risk) throw new NotFoundError('BusinessRisk', riskId)
  const updated = await db().businessRisk.update({ where: { id: riskId }, data: input })
  await logEvent('BusinessRiskUpdated', 'BusinessRisk', riskId, actorId, { status: updated.status, mitigation: updated.mitigation })
  return updated
}

async function generateReadoutInternal(projectId: string, input: { kind: 'SPONSOR' | 'WEEKLY'; objectiveId?: string; specificationVersionId?: string; periodStart?: Date; periodEnd?: Date }, actorId: string) {
  const project = await projectOrThrow(projectId)
  const [coverageInput, milestones, risks, plans, latestSigned, versions, changeRequests, finalizations] = await Promise.all([
    loadCoverageInputs(projectId),
    listMilestonesInternal(projectId),
    composeRisksInternal(projectId),
    db().generationPlan.findMany({ where: { specificationProjectId: projectId, tenantId: tenantId() }, include: { rows: true }, orderBy: { createdAt: 'desc' } }),
    db().businessReadout.findFirst({ where: { studioProjectId: projectId, tenantId: tenantId(), kind: input.kind, status: 'SIGNED', ...(input.objectiveId ? { objectiveId: input.objectiveId } : {}) }, orderBy: { signedAt: 'desc' } }),
    db().specificationVersion.findMany({ where: { specificationProjectId: projectId, tenantId: tenantId() }, orderBy: { version: 'desc' }, take: 2 }),
    db().specificationChangeRequest.findMany({ where: { projectId, tenantId: tenantId() }, orderBy: { createdAt: 'desc' }, take: 20 }),
    db().workItemFinalizationRecord.findMany({ where: { workItem: { projectId, tenantId: tenantId() }, status: 'COMPLETED', ...(input.periodStart ? { createdAt: { gte: input.periodStart, ...(input.periodEnd ? { lte: input.periodEnd } : {}) } } : {}) }, include: { workItem: { select: { id: true, title: true } } }, orderBy: { createdAt: 'desc' }, take: 100 }),
  ])
  const selectedObjective = input.objectiveId ? coverageInput.objectives.find(objective => objective.id === input.objectiveId) : undefined
  if (input.objectiveId && !selectedObjective) throw new ValidationError('Readout objective is not linked to this initiative')
  const requirements = selectedObjective
    ? coverageInput.source.requirements.filter(requirement => requirement.objectiveRefs.includes(selectedObjective.id))
    : coverageInput.source.requirements
  const objectiveById = new Map(coverageInput.objectives.map(objective => [objective.id, objective]))
  const groupedScope = coverageInput.objectives.map(objective => ({ objectiveId: objective.id, objective: objective.title, requirements: requirements.filter(requirement => requirement.objectiveRefs.includes(objective.id)).map(requirement => ({ id: requirement.id, statement: requirement.statement })) })).filter(group => group.requirements.length)
  const outOfScope = coverageInput.source.requirements.filter(requirement => requirement.objectiveRefs.some(ref => ['DROPPED', 'DEFERRED'].includes(objectiveById.get(ref)?.status ?? ''))).map(requirement => ({ id: requirement.id, statement: requirement.statement }))
  const rows = plans.flatMap(plan => plan.rows)
  const costLow = rows.reduce((sum, row) => sum + (row.estimatedCostLow ?? 0), 0)
  const costHigh = rows.reduce((sum, row) => sum + (row.estimatedCostHigh ?? row.estimatedCostLow ?? 0), 0)
  const valueCurve = buildValueDeliveredCurve(rows.map(row => ({ rowKey: row.rowKey, projectedFinishAt: row.projectedFinishAt, objectiveValueScore: row.objectiveValueScore })))
  const version = input.specificationVersionId ? versions.find(item => item.id === input.specificationVersionId) : versions[0]
  if (input.specificationVersionId && !version) throw new ValidationError('Specification version does not belong to this initiative')
  const changedSince = latestSigned
    ? changeRequests.filter(request => request.createdAt > latestSigned.createdAt).map(request => ({ id: request.id, title: request.title, status: request.status, requirementDeltas: request.requirementDeltas, costDelta: request.costDelta, milestoneImpacts: request.milestoneImpacts }))
    : changeRequests.map(request => ({ id: request.id, title: request.title, status: request.status, requirementDeltas: request.requirementDeltas, costDelta: request.costDelta, milestoneImpacts: request.milestoneImpacts }))
  const citations = [
    ...requirements.map(requirement => ({ sentence: requirement.statement, refs: [`requirement:${requirement.id}`] })),
    ...milestones.map(milestone => ({ sentence: `${milestone.name} is ${String(milestone.status).toLowerCase()}`, refs: [`milestone:${milestone.id}`, ...milestone.planRows.map(row => `plan-row:${row.id}`)] })),
    ...risks.slice(0, 5).map(risk => ({ sentence: risk.title, refs: [`${risk.sourceType.toLowerCase()}:${risk.sourceId}`] })),
    ...finalizations.map(record => ({ sentence: `${record.workItem.title} finalized`, refs: [`work-item:${record.workItemId}`, `finalization:${record.id}`] })),
  ]
  const content = {
    project: { id: project.id, code: project.code, name: project.name, mission: project.mission },
    objective: selectedObjective ?? null,
    specificationVersion: version ? { id: version.id, version: version.version, contentHash: version.contentHash } : null,
    scopeByObjective: groupedScope,
    unassignedRequirements: requirements.filter(requirement => !requirement.objectiveRefs.length).map(requirement => ({ id: requirement.id, statement: requirement.statement })),
    outOfScope,
    economics: { costLow, costHigh, currency: 'USD', envelope: project.costBudgetUsd, tokenBudget: project.tokenBudget, tokenUsed: project.tokenUsed },
    milestones: milestones.map(milestone => ({ id: milestone.id, name: milestone.name, valueStatement: milestone.valueStatement, targetDate: milestone.targetDate, projectedFinishAt: milestone.projectedFinishAt, status: milestone.status, completed: milestone.completed, total: milestone.total, percentComplete: milestone.percentComplete })),
    topRisks: risks.filter(risk => risk.status !== 'CLOSED').slice(0, 5).map(risk => ({ id: risk.id, category: risk.category, title: risk.title, severity: risk.severity, ownerId: risk.ownerId, mitigation: risk.mitigation, sourceHref: risk.sourceHref })),
    completedThisPeriod: finalizations.map(record => ({ id: record.id, workItemId: record.workItemId, title: record.workItem.title, finalizedAt: record.createdAt })),
    changedSincePreviousSignedReadout: changedSince,
    valueDeliveredByDate: valueCurve,
    generatedAt: new Date().toISOString(),
  }
  const renderedMarkdown = renderReadoutMarkdown(content, input.kind)
  const contentHash = digest({ content, renderedMarkdown, citations })
  const existing = await db().businessReadout.findFirst({ where: { studioProjectId: projectId, contentHash, kind: input.kind } })
  if (existing) return existing
  const readout = await db().businessReadout.create({
    data: { studioProjectId: projectId, objectiveId: input.objectiveId, specificationVersionId: version?.id, kind: input.kind, periodStart: input.periodStart, periodEnd: input.periodEnd, content: json(content), citations: json(citations), renderedMarkdown, contentHash, generatedById: actorId, supersedesId: latestSigned?.id, tenantId: project.tenantId ?? tenantId() },
  })
  await logEvent('BusinessReadoutGenerated', 'BusinessReadout', readout.id, actorId, { projectId, kind: readout.kind, contentHash, citationCount: citations.length })
  await publishOutbox('BusinessReadout', readout.id, 'BusinessReadoutGenerated', { projectId, kind: readout.kind, contentHash })
  return readout
}

function renderReadoutMarkdown(content: Record<string, unknown>, kind: 'SPONSOR' | 'WEEKLY'): string {
  const project = record(content.project)
  const groups = Array.isArray(content.scopeByObjective) ? content.scopeByObjective as Array<Record<string, unknown>> : []
  const milestones = Array.isArray(content.milestones) ? content.milestones as Array<Record<string, unknown>> : []
  const risks = Array.isArray(content.topRisks) ? content.topRisks as Array<Record<string, unknown>> : []
  const changes = Array.isArray(content.changedSincePreviousSignedReadout) ? content.changedSincePreviousSignedReadout as Array<Record<string, unknown>> : []
  const economics = record(content.economics)
  const scopeLines = groups.flatMap(group => [`### ${String(group.objective)}`, ...(Array.isArray(group.requirements) ? (group.requirements as Array<Record<string, unknown>>).map(requirement => `- ${String(requirement.statement)} [requirement:${String(requirement.id)}]`) : [])])
  return [
    `# ${kind === 'SPONSOR' ? 'Business Readout' : 'Weekly Status'}: ${String(project.name ?? '')}`,
    '', String(project.mission ?? ''), '',
    '## Scope and funded intent', ...scopeLines, '',
    '## Cost range', `- Estimated: $${Number(economics.costLow ?? 0).toLocaleString()}–$${Number(economics.costHigh ?? 0).toLocaleString()} against a $${Number(economics.envelope ?? 0).toLocaleString()} envelope. [initiative:${String(project.id)}]`, '',
    '## Milestones', ...(milestones.length ? milestones.map(milestone => `- **${String(milestone.name)}** — ${String(milestone.status)}; ${String(milestone.percentComplete)}% complete; target ${String(milestone.targetDate).slice(0, 10)}. [milestone:${String(milestone.id)}]`) : ['- No milestones declared.']), '',
    '## Top risks', ...(risks.length ? risks.map(risk => `- **${String(risk.category)}:** ${String(risk.title)} (severity ${String(risk.severity)}/5). [risk:${String(risk.id)}]`) : ['- No active composed risks.']), '',
    '## Changed since previous signed readout', ...(changes.length ? changes.map(change => `- ${String(change.title)} — ${String(change.status)}. [change-request:${String(change.id)}]`) : ['- No recorded change requests.']), '',
    `Generated from live platform evidence at ${String(content.generatedAt)}.`,
  ].join('\n')
}

function sponsorThresholds() {
  const cost = Number(process.env.BUSINESS_SPONSOR_COST_THRESHOLD_USD ?? '25000')
  const requirements = Number(process.env.BUSINESS_SPONSOR_REQUIREMENT_THRESHOLD ?? '5')
  return { cost: Number.isFinite(cost) && cost >= 0 ? cost : 25000, requirements: Number.isFinite(requirements) && requirements >= 0 ? Math.floor(requirements) : 5 }
}

async function sponsorGateDecisionInternal(projectId: string) {
  const { project, source } = await loadCoverageInputs(projectId)
  const high = await db().generationPlanRow.aggregate({ where: { plan: { specificationProjectId: projectId, tenantId: tenantId() } }, _sum: { estimatedCostHigh: true, estimatedCostLow: true } })
  const estimatedCost = high._sum.estimatedCostHigh ?? high._sum.estimatedCostLow ?? 0
  const thresholds = sponsorThresholds()
  const required = estimatedCost >= thresholds.cost || source.requirements.length > thresholds.requirements
  return { required, thresholds, estimatedCost, requirementCount: source.requirements.length, sponsorId: project.sponsorId, reason: required ? 'Initiative exceeds the configured sponsor fast-lane threshold' : 'Initiative qualifies for the DRI-only fast lane' }
}

async function requestSponsorApprovalInternal(readoutId: string, actorId: string) {
  const readout = await db().businessReadout.findFirst({ where: { id: readoutId, tenantId: tenantId() }, include: { project: true } })
  if (!readout) throw new NotFoundError('BusinessReadout', readoutId)
  if (readout.status === 'SIGNED') return readout
  if (readout.generatedById && readout.generatedById === readout.project.sponsorId) throw new ConflictError('The readout generator cannot be its sponsor approver')
  if (!readout.project.primaryCapabilityId) throw new ValidationError('Sponsor approval requires a primary capability on the initiative')
  await assertCanRequestApproval(actorId, readout.project.primaryCapabilityId, approvalPermission('workflow'), readout.tenantId)
  const approval = await withTenantDbTransaction(prisma, async tx => {
    const existing = await tx.approvalRequest.findFirst({ where: { subjectType: 'BusinessReadout', subjectId: readout.id, tenantId: readout.tenantId, status: 'PENDING' } })
    if (existing) return existing
    const created = await tx.approvalRequest.create({
      data: {
        subjectType: 'BusinessReadout', subjectId: readout.id, requestedById: actorId,
        assignmentMode: readout.project.sponsorId ? 'DIRECT_USER' : 'ROLE_BASED',
        assignedToId: readout.project.sponsorId,
        roleKey: readout.project.sponsorId ? null : 'SPONSOR',
        capabilityId: readout.project.primaryCapabilityId,
        adminOverride: false,
        tenantId: readout.tenantId,
        formData: { readoutId: readout.id, projectId: readout.studioProjectId, specificationVersionId: readout.specificationVersionId, contentHash: readout.contentHash, generatedAt: readout.createdAt.toISOString() } as Prisma.InputJsonValue,
      },
    })
    await tx.businessReadout.update({ where: { id: readout.id }, data: { status: 'PENDING_SPONSOR', sponsorApprovalId: created.id } })
    return created
  }, readout.tenantId ?? undefined)
  await logEvent('BusinessReadoutSponsorApprovalRequested', 'BusinessReadout', readout.id, actorId, { approvalRequestId: approval.id, contentHash: readout.contentHash })
  return approval
}

async function applyBusinessReadoutApprovalInternal(approvalRequestId: string, decision: ApprovalStatus, actorId: string, comment?: string) {
  const request = await db().approvalRequest.findFirst({ where: { id: approvalRequestId, tenantId: tenantId(), subjectType: 'BusinessReadout' }, include: { decisions: { where: { decidedById: actorId } } } })
  if (!request) throw new NotFoundError('ApprovalRequest', approvalRequestId)
  const readout = await db().businessReadout.findFirst({ where: { id: request.subjectId, tenantId: tenantId() } })
  if (!readout) throw new NotFoundError('BusinessReadout', request.subjectId)
  if (!request.decisions.length || request.status !== decision) throw new ConflictError('Readout decision is not backed by the current approval vote')
  const positive = decision === 'APPROVED' || decision === 'APPROVED_WITH_CONDITIONS'
  const updated = await withTenantDbTransaction(prisma, async tx => {
    await tx.approvalRequest.update({ where: { id: request.id }, data: { approvedContentHash: positive ? readout.contentHash : null } })
    return tx.businessReadout.update({ where: { id: readout.id }, data: positive ? { status: 'SIGNED', signedAt: new Date() } : { status: 'DRAFT' } })
  }, readout.tenantId ?? undefined)
  await logEvent(positive ? 'BusinessReadoutSigned' : 'BusinessReadoutRejected', 'BusinessReadout', readout.id, actorId, { approvalRequestId, contentHash: readout.contentHash, comment })
  await publishOutbox('BusinessReadout', readout.id, positive ? 'BusinessReadoutSigned' : 'BusinessReadoutRejected', { approvalRequestId, contentHash: readout.contentHash })
  return updated
}

async function listReadoutsInternal(projectId: string) {
  await projectOrThrow(projectId)
  return db().businessReadout.findMany({ where: { studioProjectId: projectId, tenantId: tenantId() }, orderBy: { createdAt: 'desc' } })
}

async function getProjectRollupInternal(projectId: string) {
  const [coverage, milestones, risks, objectives, plans, finalizationCount, workItemCount, readouts] = await Promise.all([
    getObjectiveCoverageInternal(projectId), listMilestonesInternal(projectId), composeRisksInternal(projectId), listObjectivesInternal(projectId),
    db().generationPlan.findMany({ where: { specificationProjectId: projectId, tenantId: tenantId() }, include: { rows: true } }),
    db().workItemFinalizationRecord.count({ where: { workItem: { projectId, tenantId: tenantId() }, status: 'COMPLETED' } }),
    db().workItem.count({ where: { projectId, tenantId: tenantId() } }),
    db().businessReadout.findMany({ where: { studioProjectId: projectId, tenantId: tenantId() }, orderBy: { createdAt: 'desc' }, take: 20 }),
  ])
  const rows = plans.flatMap(plan => plan.rows)
  return {
    projectId,
    coverage,
    objectives,
    milestones,
    risks: risks.filter(risk => risk.status !== 'CLOSED'),
    work: { total: workItemCount, finalized: finalizationCount, percentComplete: workItemCount ? Math.round(finalizationCount / workItemCount * 100) : 0 },
    burn: { actualCostUsd: rows.reduce((sum, row) => sum + (row.actualCostUsd ?? 0), 0), actualHours: rows.reduce((sum, row) => sum + (row.actualHours ?? 0), 0) },
    valueDeliveredByDate: buildValueDeliveredCurve(rows.map(row => ({ rowKey: row.rowKey, projectedFinishAt: row.projectedFinishAt, objectiveValueScore: row.objectiveValueScore }))),
    readouts,
  }
}

async function createChangeRequestInternal(projectId: string, input: { specificationVersionId: string; title: string; reason: string; requirementDeltas: Record<string, unknown> }, actorId: string) {
  const project = await projectOrThrow(projectId)
  const version = await db().specificationVersion.findFirst({ where: { id: input.specificationVersionId, specificationProjectId: projectId, tenantId: tenantId(), status: { in: ['LOCKED', 'ACTIVE', 'APPROVED'] } } })
  if (!version) throw new ValidationError('A business change request must amend a locked or approved specification version')
  const planRows = await db().generationPlanRow.findMany({ where: { plan: { specificationProjectId: projectId, tenantId: tenantId() } }, include: { milestone: true } })
  const changedIds = [...strings(input.requirementDeltas.added), ...strings(input.requirementDeltas.changed), ...strings(input.requirementDeltas.removed)]
  const impactedRows = planRows.filter(row => strings(row.requirementIds).some(id => changedIds.includes(id)))
  const costDelta = { affectedCostLow: impactedRows.reduce((sum, row) => sum + (row.estimatedCostLow ?? 0), 0), affectedCostHigh: impactedRows.reduce((sum, row) => sum + (row.estimatedCostHigh ?? row.estimatedCostLow ?? 0), 0), affectedRows: impactedRows.map(row => row.rowKey) }
  const scheduleDelta = { projectedFinishAt: impactedRows.map(row => row.projectedFinishAt).filter(Boolean).sort((left, right) => right!.getTime() - left!.getTime())[0] ?? null, criticalPathRows: impactedRows.filter(row => row.criticalPath).map(row => row.rowKey) }
  const milestoneImpacts = [...new Map(impactedRows.filter(row => row.milestone).map(row => [row.milestone!.id, { milestoneId: row.milestone!.id, name: row.milestone!.name, targetDate: row.milestone!.targetDate, affectedRows: impactedRows.filter(candidate => candidate.milestoneId === row.milestoneId).map(candidate => candidate.rowKey) }])).values()]
  const change = await db().specificationChangeRequest.create({ data: { projectId, specificationVersionId: version.id, title: input.title, reason: input.reason, requirementDeltas: json(input.requirementDeltas), costDelta: json(costDelta), scheduleDelta: json(scheduleDelta), milestoneImpacts: json(milestoneImpacts), status: 'DRAFT', requestedById: actorId, traceId: currentTraceIdForRequest(), tenantId: project.tenantId } })
  await logEvent('BusinessChangeRequestCreated', 'SpecificationChangeRequest', change.id, actorId, { projectId, specificationVersionId: version.id, costDelta, scheduleDelta, milestoneImpacts })
  return change
}

async function requestChangeSponsorReviewInternal(changeRequestId: string, actorId: string) {
  const change = await db().specificationChangeRequest.findFirst({ where: { id: changeRequestId, tenantId: tenantId() }, include: { project: true } })
  if (!change) throw new NotFoundError('SpecificationChangeRequest', changeRequestId)
  if (!['DRAFT', 'OPEN', 'RECOMMENDED'].includes(change.status)) throw new ConflictError(`Change request is ${change.status}`)
  if (!change.project.primaryCapabilityId) throw new ValidationError('Sponsor review requires a primary capability')
  if (change.requestedById && change.requestedById === change.project.sponsorId) throw new ConflictError('The change-request author cannot be its sponsor approver')
  await assertCanRequestApproval(actorId, change.project.primaryCapabilityId, approvalPermission('workflow'), change.tenantId)
  const consequenceHash = digest({ requirementDeltas: change.requirementDeltas, costDelta: change.costDelta, scheduleDelta: change.scheduleDelta, milestoneImpacts: change.milestoneImpacts })
  const approval = await withTenantDbTransaction(prisma, async tx => {
    const existing = await tx.approvalRequest.findFirst({ where: { subjectType: 'SpecificationChangeRequest', subjectId: change.id, status: 'PENDING', tenantId: change.tenantId } })
    if (existing) return existing
    const created = await tx.approvalRequest.create({ data: { subjectType: 'SpecificationChangeRequest', subjectId: change.id, requestedById: actorId, assignmentMode: change.project.sponsorId ? 'DIRECT_USER' : 'ROLE_BASED', assignedToId: change.project.sponsorId, roleKey: change.project.sponsorId ? null : 'SPONSOR', capabilityId: change.project.primaryCapabilityId, adminOverride: false, tenantId: change.tenantId, formData: { projectId: change.projectId, specificationVersionId: change.specificationVersionId, consequenceHash, requirementDeltas: change.requirementDeltas, costDelta: change.costDelta, scheduleDelta: change.scheduleDelta, milestoneImpacts: change.milestoneImpacts } as Prisma.InputJsonValue } })
    await tx.specificationChangeRequest.update({ where: { id: change.id }, data: { status: 'SPONSOR_REVIEW', sponsorApprovalId: created.id } })
    return created
  }, change.tenantId ?? undefined)
  await logEvent('BusinessChangeRequestSponsorReviewRequested', 'SpecificationChangeRequest', change.id, actorId, { approvalRequestId: approval.id, consequenceHash })
  return approval
}

async function applyChangeRequestApprovalInternal(approvalRequestId: string, decision: ApprovalStatus, actorId: string, comment?: string) {
  const request = await db().approvalRequest.findFirst({ where: { id: approvalRequestId, tenantId: tenantId(), subjectType: 'SpecificationChangeRequest' }, include: { decisions: { where: { decidedById: actorId } } } })
  if (!request) throw new NotFoundError('ApprovalRequest', approvalRequestId)
  const change = await db().specificationChangeRequest.findFirst({ where: { id: request.subjectId, tenantId: tenantId() } })
  if (!change) throw new NotFoundError('SpecificationChangeRequest', request.subjectId)
  if (!request.decisions.length || request.status !== decision) throw new ConflictError('Change-request decision is not backed by the current approval vote')
  const positive = decision === 'APPROVED' || decision === 'APPROVED_WITH_CONDITIONS'
  const consequenceHash = digest({ requirementDeltas: change.requirementDeltas, costDelta: change.costDelta, scheduleDelta: change.scheduleDelta, milestoneImpacts: change.milestoneImpacts })
  const updated = await withTenantDbTransaction(prisma, async tx => {
    await tx.approvalRequest.update({ where: { id: request.id }, data: { approvedContentHash: positive ? consequenceHash : null } })
    const row = await tx.specificationChangeRequest.update({ where: { id: change.id }, data: { status: positive ? 'APPROVED' : 'REJECTED', decidedById: actorId, decidedAt: new Date(), metadata: json({ ...record(change.metadata), sponsorComment: comment ?? null, consequenceHash }) } })
    if (positive) await tx.specificationProject.update({ where: { id: change.projectId }, data: { status: 'CHANGE_REQUESTED' } })
    return row
  }, change.tenantId ?? undefined)
  await logEvent(positive ? 'BusinessChangeRequestApproved' : 'BusinessChangeRequestRejected', 'SpecificationChangeRequest', change.id, actorId, { approvalRequestId, consequenceHash, comment })
  return updated
}

async function upsertTaxonomyMappingInternal(projectId: string, input: { entityType: string; entityId: string; externalSystem: string; externalType: string; externalLabel?: string | null; costCenterRef?: string | null; metadata?: Record<string, unknown> }, actorId: string) {
  const project = await projectOrThrow(projectId)
  return db().externalTaxonomyMapping.upsert({
    where: { tenantId_externalSystem_entityType_entityId: { tenantId: tenantId(), externalSystem: input.externalSystem, entityType: input.entityType, entityId: input.entityId } },
    create: { studioProjectId: projectId, tenantId: project.tenantId ?? tenantId(), ...input, metadata: json(input.metadata ?? {}), createdById: actorId },
    update: { studioProjectId: projectId, externalType: input.externalType, externalLabel: input.externalLabel, costCenterRef: input.costCenterRef, metadata: json(input.metadata ?? {}) },
  })
}

async function listTaxonomyMappingsInternal(projectId: string) {
  await projectOrThrow(projectId)
  return db().externalTaxonomyMapping.findMany({
    where: { studioProjectId: projectId, tenantId: tenantId() },
    orderBy: [{ externalSystem: 'asc' }, { entityType: 'asc' }, { updatedAt: 'desc' }],
  })
}

async function exportJiraCsvInternal(projectId: string) {
  await projectOrThrow(projectId)
  const [rows, mappings] = await Promise.all([
    db().generationPlanRow.findMany({ where: { plan: { specificationProjectId: projectId, tenantId: tenantId() } }, include: { milestone: true }, orderBy: { createdAt: 'asc' } }),
    db().externalTaxonomyMapping.findMany({ where: { studioProjectId: projectId, tenantId: tenantId(), externalSystem: 'JIRA' } }),
  ])
  const mappingByEntity = new Map(mappings.map(mapping => [`${mapping.entityType}:${mapping.entityId}`, mapping]))
  const csvRows = [['Summary', 'Description', 'Issue Type', 'External ID', 'Epic Name', 'Labels', 'Cost Center', 'Requirement IDs']]
  for (const row of rows) {
    const mapping = mappingByEntity.get(`GENERATION_PLAN_ROW:${row.id}`)
    csvRows.push([row.title, row.description ?? '', mapping?.externalType ?? 'Story', row.rowKey, row.milestone?.name ?? '', mapping?.externalLabel ?? '', mapping?.costCenterRef ?? '', strings(row.requirementIds).join(' ')])
  }
  return csvRows.map(columns => columns.map(csvCell).join(',')).join('\n')
}

function csvCell(value: unknown): string {
  const text = String(value ?? '')
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export const listBusinessObjectives = (projectId?: string) => tenantOperation(() => listObjectivesInternal(projectId))
export const createBusinessObjective = (input: ObjectiveInput, actorId: string) => tenantOperation(() => createObjectiveInternal(input, actorId))
export const updateBusinessObjective = (objectiveId: string, input: Partial<ObjectiveInput>, actorId: string) => tenantOperation(() => updateObjectiveInternal(objectiveId, input, actorId))
export const getObjectiveCoverage = (projectId: string, mode?: 'hub' | 'lock' | 'portfolio') => tenantOperation(() => getObjectiveCoverageInternal(projectId, mode))
export const assertObjectiveCoverageForLock = (projectId: string) => tenantOperation(() => assertObjectiveCoverageForLockInternal(projectId))
export const createBusinessMilestone = (projectId: string, input: MilestoneInput, actorId: string) => tenantOperation(() => createMilestoneInternal(projectId, input, actorId))
export const listBusinessMilestones = (projectId: string) => tenantOperation(() => listMilestonesInternal(projectId))
export const composeBusinessRisks = (projectId: string) => tenantOperation(() => composeRisksInternal(projectId))
export const updateBusinessRisk = (riskId: string, input: Parameters<typeof updateRiskInternal>[1], actorId: string) => tenantOperation(() => updateRiskInternal(riskId, input, actorId))
export const generateBusinessReadout = (projectId: string, input: Parameters<typeof generateReadoutInternal>[1], actorId: string) => tenantOperation(() => generateReadoutInternal(projectId, input, actorId))
export const listBusinessReadouts = (projectId: string) => tenantOperation(() => listReadoutsInternal(projectId))
export const requestBusinessReadoutSponsorApproval = (readoutId: string, actorId: string) => tenantOperation(() => requestSponsorApprovalInternal(readoutId, actorId))
export const applyBusinessReadoutApproval = (approvalRequestId: string, decision: ApprovalStatus, actorId: string, comment?: string) => tenantOperation(() => applyBusinessReadoutApprovalInternal(approvalRequestId, decision, actorId, comment))
export const getSponsorGateDecision = (projectId: string) => tenantOperation(() => sponsorGateDecisionInternal(projectId))
export const getBusinessProjectRollup = (projectId: string) => tenantOperation(() => getProjectRollupInternal(projectId))
export const createBusinessChangeRequest = (projectId: string, input: Parameters<typeof createChangeRequestInternal>[1], actorId: string) => tenantOperation(() => createChangeRequestInternal(projectId, input, actorId))
export const requestBusinessChangeSponsorReview = (changeRequestId: string, actorId: string) => tenantOperation(() => requestChangeSponsorReviewInternal(changeRequestId, actorId))
export const applyBusinessChangeRequestApproval = (approvalRequestId: string, decision: ApprovalStatus, actorId: string, comment?: string) => tenantOperation(() => applyChangeRequestApprovalInternal(approvalRequestId, decision, actorId, comment))
export const upsertExternalTaxonomyMapping = (projectId: string, input: Parameters<typeof upsertTaxonomyMappingInternal>[1], actorId: string) => tenantOperation(() => upsertTaxonomyMappingInternal(projectId, input, actorId))
export const listExternalTaxonomyMappings = (projectId: string) => tenantOperation(() => listTaxonomyMappingsInternal(projectId))
export const exportBusinessJiraCsv = (projectId: string) => tenantOperation(() => exportJiraCsvInternal(projectId))
