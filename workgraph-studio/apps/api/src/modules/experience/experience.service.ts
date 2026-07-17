import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { logEvent, publishOutbox } from '../../lib/audit'
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors'
import { currentTenantDbClient, currentTenantIdForDb, withTenantDbTransaction } from '../../lib/tenant-db-context'
import { projectSpecPackageSchema } from '../studio/studio-spec.schemas'
import {
  INTAKE_STAGES,
  assertCitedSentences,
  attentionBand,
  attentionCanAcknowledge,
  attentionPriority,
  nextIntakeStage,
  posteriorVariance,
  rankingReason,
  splitStatements,
  stableHash,
  stageReadback,
  validateArtifactPile,
  type ArtifactClaim,
  type ArtifactForValidation,
  type IntakeStage,
} from './experience-core'

const tenantId = () => currentTenantIdForDb() ?? 'default'
const db = () => currentTenantDbClient() ?? prisma
const json = (value: unknown) => value as Prisma.InputJsonValue

function tenantOperation<T>(operation: () => Promise<T>): Promise<T> {
  return withTenantDbTransaction(prisma, async () => operation(), tenantId())
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(item => item && typeof item === 'object' && !Array.isArray(item)) as Record<string, unknown>[] : []
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : []
}

async function projectOrThrow(projectId: string) {
  const project = await db().specificationProject.findFirst({
    where: { id: projectId, tenantId: tenantId() },
    include: { studio: true },
  })
  if (!project) throw new NotFoundError('SpecificationProject', projectId)
  return project
}

async function ensureStudio(projectId: string, name: string, actorId: string) {
  return db().studio.upsert({
    where: { projectId },
    create: { projectId, name: `${name} Studio`, createdById: actorId, tenantId: tenantId() },
    update: {},
  })
}

type AttentionCandidate = {
  sourceType: string
  sourceId: string
  title: string
  summary: string
  href?: string
  stakes: number
  uncertainty: number
  urgency: number
  blocking?: boolean
  decision?: boolean
  assignedToId?: string | null
  metadata?: Record<string, unknown>
}

function daysSince(value: Date): number {
  return Math.max(0, (Date.now() - value.getTime()) / 86_400_000)
}

async function adaptiveWindowHours(sourceType: string): Promise<number> {
  const history = await db().attentionItem.findMany({
    where: { tenantId: tenantId(), sourceType, status: 'RESOLVED' },
    select: { resolution: true },
    orderBy: { resolvedAt: 'desc' },
    take: 100,
  })
  if (history.length < 5) return 72
  const confirmations = history.filter(item => ['ACCEPTED', 'CONFIRMED'].includes(item.resolution ?? '')).length
  const acceptance = confirmations / history.length
  return acceptance >= 0.9 ? 168 : acceptance >= 0.75 ? 120 : acceptance < 0.4 ? 24 : 72
}

async function attentionCandidates(projectId: string): Promise<AttentionCandidate[]> {
  const project = await projectOrThrow(projectId)
  const boardIds = (await db().board.findMany({ where: { projectId, tenantId: tenantId() }, select: { id: true } })).map(board => board.id)
  const [proposals, verdicts, risks, approvals, reports] = await Promise.all([
    project.studio ? db().studioProposal.findMany({ where: { studioId: project.studio.id, status: 'PENDING', tenantId: tenantId() }, orderBy: { createdAt: 'asc' } }) : [],
    db().agentVerdict.findMany({ where: { status: 'OPEN', tenantId: tenantId(), boardId: { in: boardIds } }, orderBy: { createdAt: 'asc' } }),
    db().businessRisk.findMany({ where: { studioProjectId: projectId, tenantId: tenantId(), status: { in: ['OPEN', 'MITIGATING'] } }, orderBy: { severity: 'desc' } }),
    db().approvalRequest.findMany({ where: { tenantId: tenantId(), status: 'PENDING', OR: [{ subjectId: projectId }, { capabilityId: project.primaryCapabilityId ?? undefined }] }, orderBy: { createdAt: 'asc' } }),
    db().artifactValidationReport.findMany({ where: { projectId, tenantId: tenantId(), status: 'READY' }, orderBy: { createdAt: 'desc' }, take: 20 }),
  ])
  const candidates: AttentionCandidate[] = []
  const cadence = Math.max(1, project.reviewCadenceDays)
  const reviewAge = daysSince(project.lastReviewedAt ?? project.createdAt)
  if (reviewAge >= cadence) {
    const overdueFactor = Math.min(5, 1 + reviewAge / cadence)
    candidates.push({
      sourceType: 'PROJECT_REVIEW', sourceId: project.id,
      title: `Review ${project.name}`,
      summary: `This initiative has gone ${Math.floor(reviewAge)} days without a recorded review against a ${cadence}-day cadence.`,
      href: `/synthesis/hub?project=${project.id}`,
      stakes: project.businessValue ?? 3,
      uncertainty: Math.max(1, 6 - (project.confidence ?? 3)),
      urgency: overdueFactor,
      assignedToId: project.productOwnerId,
      metadata: { reviewAgeDays: Math.floor(reviewAge), cadenceDays: cadence },
    })
  }
  for (const proposal of proposals) {
    const payload = record(proposal.payload)
    candidates.push({
      sourceType: 'STUDIO_PROPOSAL', sourceId: proposal.id,
      title: String(payload.title ?? payload.name ?? proposal.kind.replaceAll('_', ' ')),
      summary: String(payload.summary ?? payload.readback ?? `An ${proposal.agentRole ?? 'agent'} proposal is waiting for a human decision.`),
      href: `/synthesis/intake?project=${projectId}&proposal=${proposal.id}`,
      stakes: Number(payload.stakes ?? project.businessValue ?? 3),
      uncertainty: Number(payload.uncertainty ?? 3),
      urgency: Math.min(5, 1 + daysSince(proposal.createdAt) / 2),
      decision: true,
      metadata: { kind: proposal.kind, agentRole: proposal.agentRole },
    })
  }
  for (const verdict of verdicts) {
    const blocking = verdict.stance === 'CHALLENGE' && /must|blocking|critical/i.test(`${verdict.rationale} ${verdict.resolvesWith ?? ''}`)
    candidates.push({
      sourceType: 'AGENT_VERDICT', sourceId: verdict.id,
      title: `${verdict.agentRole} ${verdict.stance.toLowerCase()}: ${verdict.targetType}`,
      summary: verdict.rationale,
      href: `/synthesis/ideas?project=${projectId}`,
      stakes: blocking ? 5 : verdict.stance === 'CHALLENGE' ? 4 : 2,
      uncertainty: Math.max(1, (1 - verdict.confidence) * 5),
      urgency: Math.min(5, 1 + daysSince(verdict.createdAt) / 3),
      blocking,
      decision: verdict.stance !== 'ENDORSE',
      metadata: { targetType: verdict.targetType, targetRef: verdict.targetRef, evidenceRefs: verdict.evidenceRefs },
    })
  }
  for (const risk of risks) {
    candidates.push({
      sourceType: 'BUSINESS_RISK', sourceId: risk.id,
      title: risk.title,
      summary: risk.description,
      href: `/synthesis/business?project=${projectId}`,
      stakes: risk.severity,
      uncertainty: risk.mitigation ? 2 : 4,
      urgency: risk.severity >= 5 ? 5 : Math.min(5, 1 + daysSince(risk.createdAt) / 7),
      blocking: risk.severity >= 5 && !risk.mitigation,
      assignedToId: risk.ownerId,
      metadata: { category: risk.category, sourceHref: risk.sourceHref },
    })
  }
  for (const approval of approvals) {
    const dueUrgency = approval.dueAt ? Math.max(1, Math.min(5, 3 + (Date.now() - approval.dueAt.getTime()) / 86_400_000)) : 3
    candidates.push({
      sourceType: 'APPROVAL', sourceId: approval.id,
      title: `Decision needed: ${approval.subjectType}`,
      summary: `Approval ${approval.id.slice(0, 8)} is waiting for an authorized human decision.`,
      href: '/approvals', stakes: 5, uncertainty: 2, urgency: dueUrgency,
      blocking: true, decision: true, assignedToId: approval.assignedToId,
      metadata: { subjectType: approval.subjectType, subjectId: approval.subjectId, capabilityId: approval.capabilityId },
    })
  }
  for (const report of reports) {
    const tensions = records(report.tensions).filter(item => String(item.status ?? 'OPEN') === 'OPEN')
    if (!tensions.length) continue
    candidates.push({
      sourceType: 'VALIDATION_REPORT', sourceId: report.id,
      title: `${tensions.length} source contradiction${tensions.length === 1 ? '' : 's'} need adjudication`,
      summary: 'The artifact pile contains opposing assertions. The platform will preserve both until a human records a decision.',
      href: `/synthesis/intake?project=${projectId}&report=${report.id}`,
      stakes: 4, uncertainty: 5, urgency: Math.min(5, 1 + daysSince(report.createdAt) / 3),
      decision: true,
      metadata: { boardId: report.boardId, tensionIds: tensions.map(item => item.id) },
    })
  }
  return candidates
}

async function refreshDeskInternal(projectId: string) {
  const candidates = await attentionCandidates(projectId)
  const activeKeys: string[] = []
  for (const candidate of candidates) {
    const priority = attentionPriority(candidate.stakes, candidate.uncertainty, candidate.urgency)
    const band = attentionBand({ blocking: candidate.blocking, decision: candidate.decision, stakes: candidate.stakes, priority })
    const windowHours = await adaptiveWindowHours(candidate.sourceType)
    const eligibleForAutoConfirm = band === 'DIGEST' && candidate.stakes <= 2
    const key = `${candidate.sourceType}:${candidate.sourceId}`
    activeKeys.push(key)
    await db().attentionItem.upsert({
      where: { projectId_sourceType_sourceId: { projectId, sourceType: candidate.sourceType, sourceId: candidate.sourceId } },
      create: {
        projectId, sourceType: candidate.sourceType, sourceId: candidate.sourceId,
        band, title: candidate.title, summary: candidate.summary, actionHref: candidate.href,
        stakes: candidate.stakes, uncertainty: candidate.uncertainty, urgency: candidate.urgency, priority,
        rankingReason: rankingReason(candidate.stakes, candidate.uncertainty, candidate.urgency),
        assignedToId: candidate.assignedToId, metadata: json({ ...candidate.metadata, calibrationWindowHours: windowHours }),
        autoConfirmAt: eligibleForAutoConfirm ? new Date(Date.now() + windowHours * 3_600_000) : null,
        tenantId: tenantId(),
      },
      update: {
        band, title: candidate.title, summary: candidate.summary, actionHref: candidate.href,
        stakes: candidate.stakes, uncertainty: candidate.uncertainty, urgency: candidate.urgency, priority,
        rankingReason: rankingReason(candidate.stakes, candidate.uncertainty, candidate.urgency),
        assignedToId: candidate.assignedToId, metadata: json({ ...candidate.metadata, calibrationWindowHours: windowHours }),
        lastProjectedAt: new Date(),
      },
    })
  }
  const open = await db().attentionItem.findMany({ where: { projectId, tenantId: tenantId(), status: 'OPEN' }, select: { id: true, sourceType: true, sourceId: true } })
  const active = new Set(activeKeys)
  const withdrawn = open.filter(item => !active.has(`${item.sourceType}:${item.sourceId}`)).map(item => item.id)
  if (withdrawn.length) await db().attentionItem.updateMany({ where: { id: { in: withdrawn } }, data: { status: 'WITHDRAWN', resolvedAt: new Date(), resolution: 'SOURCE_CLOSED' } })
  return candidates.length
}

export async function getDesk(projectId: string, reviewBudget = 12) {
  return tenantOperation(async () => {
    await refreshDeskInternal(projectId)
    const items = await db().attentionItem.findMany({ where: { projectId, tenantId: tenantId(), status: 'OPEN' }, orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }] })
    const budget = Math.max(1, Math.min(50, reviewBudget))
    const visible = items.slice(0, budget)
    const digest = items.slice(budget)
    const grouped = Object.fromEntries(['BLOCKING', 'DECIDE', 'REVIEW', 'DIGEST'].map(band => [band, visible.filter(item => item.band === band)]))
    return {
      projectId, reviewBudget: budget, totalOpen: items.length, visibleCount: visible.length,
      digestCount: digest.length, grouped, digest,
      economics: { formula: 'stakes x uncertainty x urgency', hiddenPassingGates: true },
      generatedAt: new Date().toISOString(),
    }
  })
}

export async function refreshDesk(projectId: string) {
  return tenantOperation(async () => ({ projected: await refreshDeskInternal(projectId) }))
}

export async function resolveAttentionItem(itemId: string, resolution: string, note: string | undefined, actorId: string) {
  return tenantOperation(async () => {
    const item = await db().attentionItem.findFirst({ where: { id: itemId, tenantId: tenantId() } })
    if (!item) throw new NotFoundError('AttentionItem', itemId)
    if (item.status !== 'OPEN') throw new ConflictError(`Attention item is already ${item.status}.`)
    if (!attentionCanAcknowledge(item.band as 'BLOCKING' | 'DECIDE' | 'REVIEW' | 'DIGEST')) {
      throw new ValidationError('Blocking and decision items must be resolved in their authoritative source workflow.')
    }
    const updated = await db().attentionItem.update({ where: { id: itemId }, data: { status: 'RESOLVED', resolution, resolutionNote: note, resolvedById: actorId, resolvedAt: new Date() } })
    await logEvent('AttentionItemResolved', 'AttentionItem', itemId, actorId, { resolution, sourceType: item.sourceType, sourceId: item.sourceId })
    return updated
  })
}

export async function autoConfirmDueAttention() {
  return tenantOperation(async () => {
    const due = await db().attentionItem.findMany({ where: { tenantId: tenantId(), status: 'OPEN', band: 'DIGEST', autoConfirmAt: { lte: new Date() } } })
    for (const item of due) {
      await db().attentionItem.update({ where: { id: item.id }, data: { status: 'RESOLVED', resolution: 'CONFIRMED', resolutionNote: 'Adaptive auto-confirm window elapsed without challenge.', resolvedById: 'attention-auto-confirm', resolvedAt: new Date() } })
      await logEvent('AttentionItemAutoConfirmed', 'AttentionItem', item.id, 'attention-auto-confirm', { sourceType: item.sourceType, sourceId: item.sourceId })
    }
    return { confirmed: due.length }
  })
}

export async function resolveIntakeSession(projectId: string, actorId: string) {
  return tenantOperation(async () => {
    await projectOrThrow(projectId)
    const existing = await db().discoverySession.findFirst({ where: { tenantId: tenantId(), scopeType: 'INITIATIVE', scopeId: projectId, status: { in: ['OPEN', 'RESOLVING', 'BLOCKED'] } }, include: { questions: true, assumptions: true }, orderBy: { updatedAt: 'desc' } })
    if (existing) return existing
    const session = await db().discoverySession.create({ data: { tenantId: tenantId(), scopeType: 'INITIATIVE', scopeId: projectId, touchPoint: 'ARCHON_INTAKE', protocolStage: 'PROBLEM', stageExtracts: json({}), createdById: actorId }, include: { questions: true, assumptions: true } })
    await logEvent('IntakeInterviewStarted', 'DiscoverySession', session.id, actorId, { projectId, protocolStage: 'PROBLEM' })
    return session
  })
}

export async function recordIntakeTurn(sessionId: string, input: { stage: IntakeStage; text: string; confidence: number; tokensUsed?: number; costUsd?: number }, actorId: string) {
  return tenantOperation(async () => {
    const session = await db().discoverySession.findFirst({ where: { id: sessionId, tenantId: tenantId(), scopeType: 'INITIATIVE' } })
    if (!session) throw new NotFoundError('DiscoverySession', sessionId)
    if (session.status === 'RESOLVED' || session.status === 'ABANDONED') throw new ConflictError(`Interview is already ${session.status}.`)
    if (!INTAKE_STAGES.includes(input.stage)) throw new ValidationError('Unknown intake stage')
    if (session.protocolStage !== input.stage) throw new ConflictError(`The interview is currently at ${session.protocolStage}; save that stage before ${input.stage}.`)
    const confidence = Math.max(0, Math.min(1, input.confidence))
    const extracts = record(session.stageExtracts)
    const readback = stageReadback(input.stage, input.text, confidence)
    extracts[input.stage] = { text: input.text.trim(), statements: splitStatements(input.text), confidence, readback, confirmedById: actorId, confirmedAt: new Date().toISOString() }
    const next = nextIntakeStage(input.stage)
    const updated = await db().discoverySession.update({
      where: { id: session.id },
      data: {
        stageExtracts: json(extracts), protocolStage: next ?? input.stage,
        status: next ? 'OPEN' : 'RESOLVING',
        tokensUsed: { increment: Math.max(0, input.tokensUsed ?? 0) },
        sessionCostUsd: { increment: Math.max(0, input.costUsd ?? 0) },
      },
    })
    await logEvent('IntakeStageConfirmed', 'DiscoverySession', session.id, actorId, { stage: input.stage, nextStage: next, confidence })
    return { session: updated, readback, nextStage: next, canScaffold: true }
  })
}

function intakePayload(project: Awaited<ReturnType<typeof projectOrThrow>>, session: { id: string; stageExtracts: Prisma.JsonValue; sessionCostUsd: number; tokensUsed: number }) {
  const stages = record(session.stageExtracts)
  const text = (stage: IntakeStage) => String(record(stages[stage]).text ?? '')
  const confidence = (stage: IntakeStage) => Number(record(stages[stage]).confidence ?? 0.5)
  const beliefs = splitStatements(text('BELIEFS'))
  const success = splitStatements(text('SUCCESS'))
  const constraints = splitStatements(text('CONSTRAINTS'))
  return {
    title: `Scaffold ${project.name}`,
    summary: 'One interruptible intake batch: initiative framing, board, belief room, claims, probes, draft objectives, and an empty-requirements specification skeleton.',
    intakeSessionId: session.id,
    initiative: { projectId: project.id, mission: text('PROBLEM') || project.mission, primaryCapabilityId: project.primaryCapabilityId, primaryCapabilityName: project.primaryCapabilityName },
    board: { name: `${project.name} Intent Board` },
    rooms: beliefs.length ? [{ title: 'Intake beliefs', claimIndexes: beliefs.map((_, index) => index) }] : [],
    claims: beliefs.map((statement, index) => ({ statement, confidence: confidence('BELIEFS'), claimType: 'OPERATIONAL', capabilityId: project.primaryCapabilityId, provenance: { sourceType: 'INTAKE_INTERVIEW', sourceId: session.id, stage: 'BELIEFS', ordinal: index } })),
    probes: beliefs.map((statement, index) => ({ claimIndex: index, riskiestAssumption: statement, falsification: `Find credible evidence that would make this belief false: ${statement}`, tier: 'SOURCE_DOCUMENT' })),
    objectives: success.map((statement, index) => ({ title: statement.slice(0, 160), description: statement, valueScore: 3, valueRationale: 'Drafted from the SUCCESS stage; a human must confirm value and metric.', targetMetric: { declared: true, value: statement }, ordinal: index })),
    specSkeleton: { analysis: { problem: text('PROBLEM'), goals: success.map(statement => ({ text: statement })), stakeholders: [], assumptions: beliefs, constraints }, requirements: [], decisions: [] },
    context: text('CONTEXT'),
    priorArtInheritance: project.primaryCapabilityId ? [{ capabilityId: project.primaryCapabilityId, enabled: false, reason: 'Human must choose whether capability prior art is inherited.' }] : [],
    economics: { tokensUsed: session.tokensUsed, costUsd: session.sessionCostUsd },
  }
}

export async function proposeIntakeScaffold(sessionId: string, actorId: string) {
  return tenantOperation(async () => {
    const session = await db().discoverySession.findFirst({ where: { id: sessionId, tenantId: tenantId(), scopeType: 'INITIATIVE' } })
    if (!session) throw new NotFoundError('DiscoverySession', sessionId)
    const project = await projectOrThrow(session.scopeId)
    const studio = await ensureStudio(project.id, project.name, actorId)
    const payload = intakePayload(project, session)
    const existing = await db().studioProposal.findFirst({ where: { studioId: studio.id, kind: 'SCAFFOLD_BATCH', status: 'PENDING', scopeType: 'INTAKE_SESSION', scopeRef: { path: ['sessionId'], equals: session.id } } })
    if (existing) return existing
    const proposal = await db().studioProposal.create({ data: { studioId: studio.id, scopeType: 'INTAKE_SESSION', scopeRef: json({ sessionId: session.id, projectId: project.id }), kind: 'SCAFFOLD_BATCH', payload: json(payload), authorType: 'AGENT', agentRole: 'ARCHON', traceId: `intake:${session.id}`, tenantId: tenantId() } })
    await logEvent('ScaffoldProposalCreated', 'StudioProposal', proposal.id, actorId, { projectId: project.id, sessionId: session.id, requirements: 0 })
    await publishOutbox('StudioProposal', proposal.id, 'ScaffoldProposalCreated', { projectId: project.id, sessionId: session.id })
    return proposal
  })
}

export async function acceptIntakeScaffold(proposalId: string, actorId: string, note?: string) {
  return tenantOperation(async () => {
    const proposal = await db().studioProposal.findFirst({ where: { id: proposalId, tenantId: tenantId() }, include: { studio: true } })
    if (!proposal) throw new NotFoundError('StudioProposal', proposalId)
    if (proposal.scopeType !== 'INTAKE_SESSION' || proposal.kind !== 'SCAFFOLD_BATCH') throw new ValidationError('This proposal is not an intake scaffold')
    if (proposal.status !== 'PENDING') throw new ConflictError(`Scaffold is already ${proposal.status}.`)
    const payload = record(proposal.editedPayload ?? proposal.payload)
    const projectId = String(record(proposal.scopeRef).projectId ?? proposal.studio.projectId)
    const project = await projectOrThrow(projectId)
    const claims = records(payload.claims)
    const rooms = records(payload.rooms)
    const objectives = records(payload.objectives)
    const skeleton = projectSpecPackageSchema.parse(payload.specSkeleton ?? {})
    if (skeleton.requirements.length !== 0) throw new ValidationError('Intake scaffolds must not manufacture requirements; requirements are earned after evidence review.')

    const tx = db()
      let board = await tx.board.findFirst({ where: { projectId, tenantId: tenantId(), name: String(record(payload.board).name ?? `${project.name} Intent Board`) } })
      if (!board) board = await tx.board.create({ data: { projectId, name: String(record(payload.board).name ?? `${project.name} Intent Board`), createdById: actorId, tenantId: tenantId(), branches: { create: { name: 'main', createdById: actorId, tenantId: tenantId() } } } })
      const createdClaims: string[] = []
      for (const roomInput of rooms) {
        const room = await tx.room.create({ data: { projectId, title: String(roomInput.title ?? 'Intake beliefs'), createdById: actorId, tenantId: tenantId() } })
        const indexes = (Array.isArray(roomInput.claimIndexes) ? roomInput.claimIndexes : []).map(Number)
        for (const index of indexes) {
          const input = claims[index]
          if (!input) continue
          const confidence = Math.max(0.01, Math.min(0.99, Number(input.confidence ?? 0.5)))
          const strength = 2 + confidence * 8
          const claim = await tx.claim.create({ data: { projectId, roomId: room.id, statement: String(input.statement), riskiestAssumption: String(input.statement), claimType: String(input.claimType ?? 'OPERATIONAL') as 'OPERATIONAL', alpha: 1 + confidence * strength, beta: 1 + (1 - confidence) * strength, stewardId: actorId, provenance: json(input.provenance ?? {}), capabilityId: typeof input.capabilityId === 'string' ? input.capabilityId : project.primaryCapabilityId, createdById: actorId, tenantId: tenantId() } })
          createdClaims.push(claim.id)
          await tx.probe.create({ data: { claimId: claim.id, roomId: room.id, riskiestAssumption: claim.statement, falsification: `Find credible evidence that would make this belief false: ${claim.statement}`, tier: 'SOURCE_DOCUMENT', ownerId: actorId, createdById: actorId, tenantId: tenantId() } })
        }
      }
      for (const input of objectives) {
        await tx.businessObjective.create({ data: { studioProjectId: projectId, title: String(input.title), description: String(input.description), ownerId: project.productOwnerId ?? actorId, targetMetric: json(input.targetMetric ?? {}), valueScore: Math.max(1, Math.min(5, Number(input.valueScore ?? 3))), valueRationale: String(input.valueRationale ?? 'Confirmed from governed intake.'), period: json({}), createdById: actorId, tenantId: tenantId(), projectLinks: { create: { projectId, tenantId: tenantId(), createdById: actorId } } } })
      }
      const existingSpec = await tx.projectSpecification.findUnique({ where: { projectId } })
      if (!existingSpec) await tx.projectSpecification.create({ data: { projectId, package: json(skeleton), updatedById: actorId, tenantId: tenantId() } })
      else {
        const current = projectSpecPackageSchema.parse(existingSpec.package)
        const merged = projectSpecPackageSchema.parse({ ...current, analysis: { ...current.analysis, ...skeleton.analysis }, requirements: current.requirements, decisions: current.decisions })
        await tx.projectSpecification.update({ where: { projectId }, data: { package: json(merged), revision: { increment: 1 }, updatedById: actorId } })
      }
      await tx.specificationProject.update({ where: { id: projectId }, data: { mission: String(record(payload.initiative).mission ?? project.mission ?? '') || project.mission } })
      await tx.discoverySession.update({ where: { id: String(record(proposal.scopeRef).sessionId) }, data: { status: 'RESOLVED' } })
      await tx.studioProposal.update({ where: { id: proposal.id }, data: { status: 'ACCEPTED', decidedById: actorId, decidedAt: new Date(), decisionNote: note ?? 'Accepted as one governed intake batch.' } })
    const applied = { boardId: board.id, claimIds: createdClaims, objectiveCount: objectives.length }
    await logEvent('ScaffoldProposalAccepted', 'StudioProposal', proposal.id, actorId, { projectId, ...applied, requirementsCreated: 0 })
    await publishOutbox('StudioProposal', proposal.id, 'ScaffoldProposalAccepted', { projectId, ...applied })
    return { proposalId: proposal.id, projectId, ...applied, requirementsCreated: 0 }
  })
}

function asArtifact(row: { id: string; filename: string; kind: string; status: string; contentHash: string; sourceSpans: Prisma.JsonValue; extractedClaims: Prisma.JsonValue }): ArtifactForValidation {
  return {
    id: row.id, filename: row.filename, kind: row.kind, status: row.status, contentHash: row.contentHash,
    sourceSpans: records(row.sourceSpans).map(span => ({ ref: String(span.ref), title: typeof span.title === 'string' ? span.title : null, text: String(span.text ?? '') })),
    extractedClaims: records(row.extractedClaims).map(claim => ({ ...claim, id: String(claim.id), kind: String(claim.kind), statement: String(claim.statement), sourceRef: record(claim.sourceRef) as ArtifactClaim['sourceRef'] })) as ArtifactClaim[],
  }
}

export async function validateBoardArtifacts(boardId: string, actorId: string) {
  return tenantOperation(async () => {
    const board = await db().board.findFirst({ where: { id: boardId, tenantId: tenantId() } })
    if (!board) throw new NotFoundError('Board', boardId)
    const rows = await db().ingestedArtifact.findMany({ where: { boardId, tenantId: tenantId() }, orderBy: { createdAt: 'asc' } })
    if (!rows.length) throw new ValidationError('Drop at least one document into the board before validating the pile.')
    const artifacts = rows.map(asArtifact)
    const result = validateArtifactPile(artifacts)
    const contentHash = stableHash({ sources: artifacts.map(item => ({ id: item.id, contentHash: item.contentHash })), ...result })
    const report = await db().artifactValidationReport.upsert({
      where: { boardId_contentHash: { boardId, contentHash } },
      create: { projectId: board.projectId, boardId, taxonomy: json(result.taxonomy), findings: json(result.findings), tensions: json(result.tensions), citations: json(result.citations), contentHash, generatedById: actorId, tenantId: tenantId(), sources: { create: artifacts.map(artifact => ({ artifactId: artifact.id, tenantId: tenantId() })) } },
      update: {},
      include: { sources: { include: { artifact: true } } },
    })
    await logEvent('ArtifactValidationReportGenerated', 'ArtifactValidationReport', report.id, actorId, { boardId, projectId: board.projectId, findings: result.findings.length, tensions: result.tensions.length, citations: result.citations.length })
    return report
  })
}

export async function listValidationReports(boardId: string) {
  return tenantOperation(async () => {
    const board = await db().board.findFirst({ where: { id: boardId, tenantId: tenantId() }, select: { id: true } })
    if (!board) throw new NotFoundError('Board', boardId)
    return { items: await db().artifactValidationReport.findMany({ where: { boardId, tenantId: tenantId() }, include: { sources: { include: { artifact: { select: { id: true, filename: true, kind: true, status: true } } } } }, orderBy: { createdAt: 'desc' } }) }
  })
}

export async function transmuteValidationReport(reportId: string, actorId: string) {
  return tenantOperation(async () => {
    const report = await db().artifactValidationReport.findFirst({ where: { id: reportId, tenantId: tenantId() }, include: { project: { include: { studio: true } }, sources: { include: { artifact: true } } } })
    if (!report) throw new NotFoundError('ArtifactValidationReport', reportId)
    const studio = report.project.studio ?? await ensureStudio(report.projectId, report.project.name, actorId)
    const claims = report.sources.flatMap(source => records(source.artifact.extractedClaims)).filter(claim => String(claim.status ?? 'STAGED') !== 'REJECTED')
    const draftRequirements = claims.filter(claim => ['COMMITMENT', 'METRIC'].includes(String(claim.kind))).map((claim, index) => ({ id: `DRAFT-${index + 1}`, statement: String(claim.statement), priority: 'SHOULD', acceptanceCriteria: [], sourceRef: claim.sourceRef, status: 'DRAFT' }))
    const payload = {
      title: `Artifact scaffold for ${report.project.name}`,
      summary: `${report.sources.length} source(s), ${records(report.findings).length} finding(s), and ${records(report.tensions).length} unresolved tension(s).`,
      validationReportId: report.id,
      claims: claims.map(claim => ({ ...claim, tier: 'SOURCE_DOCUMENT', status: 'STAGED', capabilityId: report.project.primaryCapabilityId })),
      tensions: report.tensions,
      draftRequirements,
      constraints: claims.filter(claim => String(claim.kind) === 'COMMITMENT'),
      requirementPolicy: 'DRAFT_ONLY_HUMAN_COMMIT_REQUIRED',
    }
    const existing = await db().studioProposal.findFirst({ where: { studioId: studio.id, kind: 'ARTIFACT_SCAFFOLD_BATCH', status: 'PENDING', scopeType: 'VALIDATION_REPORT', scopeRef: { path: ['reportId'], equals: report.id } } })
    if (existing) return existing
    const proposal = await db().studioProposal.create({ data: { studioId: studio.id, scopeType: 'VALIDATION_REPORT', scopeRef: json({ reportId: report.id, projectId: report.projectId }), kind: 'ARTIFACT_SCAFFOLD_BATCH', payload: json(payload), authorType: 'AGENT', agentRole: 'ARCHON', traceId: `validation:${report.id}`, tenantId: tenantId() } })
    await logEvent('ArtifactScaffoldProposed', 'StudioProposal', proposal.id, actorId, { reportId, projectId: report.projectId, draftRequirements: draftRequirements.length })
    return proposal
  })
}

export async function generateCanonicalArtifactDocument(reportId: string) {
  return tenantOperation(async () => {
    const report = await db().artifactValidationReport.findFirst({ where: { id: reportId, tenantId: tenantId() }, include: { project: true, sources: { include: { artifact: true } } } })
    if (!report) throw new NotFoundError('ArtifactValidationReport', reportId)
    const sentences = report.sources.flatMap(source => records(source.artifact.extractedClaims).filter(claim => String(claim.status ?? 'STAGED') !== 'REJECTED').slice(0, 3).map(claim => ({ text: String(claim.statement), citationRefs: [`${source.artifactId}#${String(record(claim.sourceRef).spanRef ?? claim.id)}`] }))).slice(0, 8)
    if (!sentences.length) throw new ValidationError('No cited claims are available to generate a canonical document.')
    assertCitedSentences(sentences)
    const markdown = [`# ${report.project.name}: Canonical Source Brief`, '', ...sentences.map(sentence => `- ${sentence.text} [${sentence.citationRefs.join(', ')}]`), '', `Validation report: ${report.id}`, `Content hash: ${stableHash(sentences)}`].join('\n')
    return { reportId, filename: `${report.project.code.toLowerCase()}-canonical-source-brief.md`, contentType: 'text/markdown', markdown, sentences }
  })
}

export async function runOvernightShift(projectId: string, actorId = 'overnight-shift') {
  return tenantOperation(async () => {
    const project = await projectOrThrow(projectId)
    if (project.status === 'LOCKED') return { projectId, skipped: true, reason: 'The initiative is LOCKED; the shift never modifies or proposes against locked artifacts.' }
    const boardIds = (await db().board.findMany({ where: { projectId, tenantId: tenantId() }, select: { id: true } })).map(board => board.id)
    const [spec, claims, openVerdicts] = await Promise.all([
      db().projectSpecification.findUnique({ where: { projectId } }),
      db().claim.findMany({ where: { projectId, tenantId: tenantId(), status: 'OPEN' }, orderBy: { updatedAt: 'asc' } }),
      db().agentVerdict.findMany({ where: { tenantId: tenantId(), status: 'OPEN', boardId: { in: boardIds } }, select: { targetRef: true } }),
    ])
    if (spec && Date.now() - spec.updatedAt.getTime() < 24 * 3_600_000) return { projectId, skipped: true, reason: 'A human edited the specification in the last 24 hours.' }
    const challenged = new Set(openVerdicts.map(item => item.targetRef))
    const envelopeShareTokens = Math.floor(project.tokenBudget * 0.05)
    const available = Math.max(0, Math.min(envelopeShareTokens, project.tokenBudget - project.tokenUsed))
    const ranked = claims.filter(claim => !challenged.has(claim.id)).map(claim => {
      const variance = posteriorVariance(claim.alpha, claim.beta)
      const stakes = claim.claimType === 'MARKET' || claim.claimType === 'USER' ? 4 : 3
      const expectedValue = variance * stakes * 100
      const estimatedTokens = 1200
      return { claim, variance, stakes, expectedValue, estimatedTokens, valuePerThousandTokens: expectedValue / (estimatedTokens / 1000) }
    }).filter(item => item.expectedValue >= 1).sort((left, right) => right.valuePerThousandTokens - left.valuePerThousandTokens)
    let plannedTokens = 0
    const selected = ranked.filter(item => plannedTokens + item.estimatedTokens <= available && (plannedTokens += item.estimatedTokens) > 0).slice(0, 5)
    const studio = await ensureStudio(projectId, project.name, actorId)
    const proposals = []
    for (const item of selected) {
      const existing = await db().studioProposal.findFirst({ where: { studioId: studio.id, kind: 'OVERNIGHT_EVIDENCE_HUNT', status: 'PENDING', scopeType: 'CLAIM', scopeRef: { path: ['claimId'], equals: item.claim.id } } })
      if (existing) { proposals.push(existing); continue }
      proposals.push(await db().studioProposal.create({ data: { studioId: studio.id, scopeType: 'CLAIM', scopeRef: json({ claimId: item.claim.id, projectId }), kind: 'OVERNIGHT_EVIDENCE_HUNT', payload: json({ title: `Evidence hunt: ${item.claim.statement.slice(0, 100)}`, summary: 'Proposal only. Find evidence at the highest honest available tier; do not update the claim until a human accepts the evidence.', expectedValue: item.expectedValue, estimatedTokens: item.estimatedTokens, valuePerThousandTokens: item.valuePerThousandTokens, capabilityId: item.claim.capabilityId ?? project.primaryCapabilityId }), authorType: 'AGENT', agentRole: 'OVERNIGHT_SHIFT', traceId: `overnight:${projectId}:${item.claim.id}`, tenantId: tenantId() } }))
    }
    await refreshDeskInternal(projectId)
    const openAttention = await db().attentionItem.findMany({ where: { projectId, tenantId: tenantId(), status: 'OPEN' }, orderBy: { priority: 'desc' }, take: 3 })
    const sentences = [
      ...openAttention.map(item => ({ text: `${item.title} is ranked ${item.priority.toFixed(2)} because ${item.rankingReason}`, citationRefs: [`attention:${item.id}`, `${item.sourceType.toLowerCase()}:${item.sourceId}`] })),
      ...proposals.slice(0, 3).map(proposal => ({ text: `${String(record(proposal.payload).title)} was prepared as a proposal and has not changed its target.`, citationRefs: [`proposal:${proposal.id}`] })),
      { text: `The shift planned ${plannedTokens.toLocaleString()} tokens within a ${available.toLocaleString()} token nightly allowance and spent zero tokens on deterministic ranking.`, citationRefs: [`initiative:${project.id}`, `budget-envelope:${project.id}`] },
    ].slice(0, 8)
    assertCitedSentences(sentences)
    const content = { projectId, sentences, proposals: proposals.map(item => item.id), plannedTokens, actualTokens: 0, costUsd: 0, generatedAt: new Date().toISOString() }
    const contentHash = stableHash(content)
    const renderedMarkdown = [`# Morning Brief: ${project.name}`, '', ...sentences.map(sentence => `- ${sentence.text} [${sentence.citationRefs.join(', ')}]`), '', `Spend: 0 tokens / $0.00 (deterministic sweep); planned follow-up allowance ${plannedTokens} tokens.`].join('\n')
    const brief = await db().businessReadout.upsert({ where: { studioProjectId_contentHash_kind: { studioProjectId: projectId, contentHash, kind: 'MORNING' } }, create: { studioProjectId: projectId, kind: 'MORNING', content: json(content), citations: json(sentences), renderedMarkdown, contentHash, generatedById: actorId, tenantId: tenantId() }, update: {} })
    await logEvent('OvernightShiftCompleted', 'SpecificationProject', projectId, actorId, { proposals: proposals.length, plannedTokens, actualTokens: 0, morningBriefId: brief.id })
    return { projectId, skipped: false, proposals: proposals.length, plannedTokens, actualTokens: 0, brief }
  })
}

export async function getMorningBrief(projectId: string) {
  return tenantOperation(async () => {
    await projectOrThrow(projectId)
    return db().businessReadout.findFirst({ where: { studioProjectId: projectId, tenantId: tenantId(), kind: 'MORNING' }, orderBy: { createdAt: 'desc' } })
  })
}
