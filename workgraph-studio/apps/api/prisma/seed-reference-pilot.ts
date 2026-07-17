import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { Prisma, PrismaClient } from '@prisma/client'
import { config as loadDotenv } from 'dotenv'
import {
  REFERENCE_PILOT_CODE,
  REFERENCE_PILOT_PROJECT_ID,
  REFERENCE_PILOT_TAGS,
} from '../src/modules/portfolio-execution/reference-pilot'

function loadEnvironment() {
  for (const envFile of [
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), '.env.local'),
    path.resolve(__dirname, '../../../../.env.local'),
  ]) {
    if (existsSync(envFile)) loadDotenv({ path: envFile, override: false })
  }
  process.env.DATABASE_URL = process.env.DATABASE_URL
    || process.env.DATABASE_URL_WORKGRAPH_ADMIN
    || process.env.WORKGRAPH_DATABASE_URL_ADMIN
    || ''
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL_WORKGRAPH_ADMIN or DATABASE_URL is required')
  if (process.env.NODE_ENV === 'production' && process.env.REFERENCE_PILOT_ALLOW_SYNTHETIC !== 'true') {
    throw new Error('Synthetic reference-pilot evidence is disabled in production. Set REFERENCE_PILOT_ALLOW_SYNTHETIC=true only in an isolated validation tenant.')
  }
}

loadEnvironment()
const prisma = new PrismaClient()
const tenantId = process.env.REFERENCE_PILOT_TENANT_ID || 'default'
const capabilityId = process.env.REFERENCE_PILOT_CAPABILITY_ID || '11111111-2222-3333-4444-555555555555'
const json = (value: unknown) => value as Prisma.InputJsonValue
const digest = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
const provenance = { mode: 'REFERENCE_SYNTHETIC', runner: 'seed-reference-pilot.ts', tenantId }

const ids = {
  project: REFERENCE_PILOT_PROJECT_ID,
  objective: '9f000000-0000-4000-8000-000000000002',
  objectiveLink: '9f000000-0000-4000-8000-000000000003',
  board: '9f000000-0000-4000-8000-000000000004',
  branch: '9f000000-0000-4000-8000-000000000005',
  boardEvent: '9f000000-0000-4000-8000-000000000006',
  artifact: '9f000000-0000-4000-8000-000000000007',
  report: '9f000000-0000-4000-8000-000000000008',
  reportSource: '9f000000-0000-4000-8000-000000000009',
  claim: '9f000000-0000-4000-8000-000000000010',
  dossier: '9f000000-0000-4000-8000-000000000011',
  optionAccepted: '9f000000-0000-4000-8000-000000000012',
  optionRejected: '9f000000-0000-4000-8000-000000000013',
  decisionApproval: '9f000000-0000-4000-8000-000000000014',
  specification: '9f000000-0000-4000-8000-000000000015',
  specificationApproval: '9f000000-0000-4000-8000-000000000016',
  plan: '9f000000-0000-4000-8000-000000000017',
  planRow: '9f000000-0000-4000-8000-000000000018',
  workItem: '9f000000-0000-4000-8000-000000000019',
  target: '9f000000-0000-4000-8000-000000000020',
  binding: '9f000000-0000-4000-8000-000000000021',
  scope: '9f000000-0000-4000-8000-000000000022',
  handoff: '9f000000-0000-4000-8000-000000000023',
  submission: '9f000000-0000-4000-8000-000000000024',
  verifiedRun: '9f000000-0000-4000-8000-000000000025',
  failedRun: '9f000000-0000-4000-8000-000000000026',
  staleRun: '9f000000-0000-4000-8000-000000000027',
  verdict: '9f000000-0000-4000-8000-000000000028',
  drift: '9f000000-0000-4000-8000-000000000029',
  finalization: '9f000000-0000-4000-8000-000000000030',
  finalizedEvent: '9f000000-0000-4000-8000-000000000031',
  waiver: '9f000000-0000-4000-8000-000000000032',
  adHocWorkItem: '9f000000-0000-4000-8000-000000000033',
  slaEvent: '9f000000-0000-4000-8000-000000000034',
  budgetEvent: '9f000000-0000-4000-8000-000000000035',
  impact: '9f000000-0000-4000-8000-000000000036',
  capabilityLink: '9f000000-0000-4000-8000-000000000037',
  sponsorApproval: '9f000000-0000-4000-8000-000000000038',
  sponsorReadout: '9f000000-0000-4000-8000-000000000039',
  weeklyReadout1: '9f000000-0000-4000-8000-000000000040',
  weeklyReadout2: '9f000000-0000-4000-8000-000000000041',
  morningReadout: '9f000000-0000-4000-8000-000000000042',
  changeRequest: '9f000000-0000-4000-8000-000000000043',
} as const

const requirementId = 'REQ-REF-PILOT-001'
const tensionId = 'TENSION-REF-PILOT-001'
const referenceDate = new Date('2026-07-01T09:00:00.000Z')

async function seed() {
  return prisma.$transaction(async tx => {
    const author = await tx.user.upsert({
      where: { email: 'reference-pilot-author@singularity.local' },
      update: { displayName: 'Reference Pilot Author', isActive: true },
      create: { email: 'reference-pilot-author@singularity.local', displayName: 'Reference Pilot Author', isActive: true },
    })
    const approver = await tx.user.upsert({
      where: { email: 'reference-pilot-approver@singularity.local' },
      update: { displayName: 'Reference Pilot Independent Approver', isActive: true },
      create: { email: 'reference-pilot-approver@singularity.local', displayName: 'Reference Pilot Independent Approver', isActive: true },
    })

    const project = await tx.specificationProject.upsert({
      where: { code: REFERENCE_PILOT_CODE },
      update: {
        name: 'Reference Pilot: Governed delivery evidence',
        mission: 'Exercise the complete contract-bound work evidence spine without representing synthetic evidence as a production attestation.',
        status: 'ACTIVE', primaryCapabilityId: capabilityId, primaryCapabilityName: 'Reference Delivery Capability',
        sponsorId: approver.id, productOwnerId: author.id, tokenBudget: 10_000, tokenUsed: 8_500,
        businessValue: 80, customerImpact: 70, strategicAlignment: 90, urgency: 60,
        deliveryRisk: 55, technicalRisk: 50, confidence: 85, effort: 40,
        tags: [...REFERENCE_PILOT_TAGS], successMetrics: json([{ metric: 'Pilot proof score', target: 100 }]), tenantId,
      },
      create: {
        id: ids.project, code: REFERENCE_PILOT_CODE, name: 'Reference Pilot: Governed delivery evidence',
        mission: 'Exercise the complete contract-bound work evidence spine without representing synthetic evidence as a production attestation.',
        status: 'ACTIVE', createdById: author.id, primaryCapabilityId: capabilityId,
        primaryCapabilityName: 'Reference Delivery Capability', sponsorId: approver.id, productOwnerId: author.id,
        tokenBudget: 10_000, tokenUsed: 8_500, businessValue: 80, customerImpact: 70,
        strategicAlignment: 90, urgency: 60, deliveryRisk: 55, technicalRisk: 50,
        confidence: 85, effort: 40, tags: [...REFERENCE_PILOT_TAGS],
        successMetrics: json([{ metric: 'Pilot proof score', target: 100 }]), tenantId,
      },
    })

    const objective = await tx.businessObjective.upsert({
      where: { id: ids.objective },
      update: { title: 'Prove governed idea-to-check-in delivery', description: 'Every pilot obligation is backed by a durable, linked record.', ownerId: approver.id, targetMetric: json({ metric: 'pilot_readiness', target: 100, unit: 'percent' }), valueScore: 5, valueRationale: 'Validates the platform control plane before a production pilot.', status: 'ACTIVE' },
      create: { id: ids.objective, tenantId, studioProjectId: project.id, title: 'Prove governed idea-to-check-in delivery', description: 'Every pilot obligation is backed by a durable, linked record.', ownerId: approver.id, targetMetric: json({ metric: 'pilot_readiness', target: 100, unit: 'percent' }), valueScore: 5, valueRationale: 'Validates the platform control plane before a production pilot.', status: 'ACTIVE', createdById: author.id },
    })
    await tx.businessObjectiveProject.upsert({
      where: { objectiveId_projectId: { objectiveId: objective.id, projectId: project.id } },
      update: {}, create: { id: ids.objectiveLink, objectiveId: objective.id, projectId: project.id, tenantId, createdById: author.id },
    })
    await tx.specificationProjectCapability.upsert({
      where: { projectId_capabilityId: { projectId: project.id, capabilityId } },
      update: { capabilityName: 'Reference Delivery Capability', role: 'PRIMARY', impactArea: 'Contract-bound delivery' },
      create: { id: ids.capabilityLink, projectId: project.id, capabilityId, capabilityName: 'Reference Delivery Capability', role: 'PRIMARY', impactArea: 'Contract-bound delivery', tenantId },
    })
    await tx.capabilityImpactAssessment.upsert({
      where: { projectId_capabilityId: { projectId: project.id, capabilityId } },
      update: { status: 'COMPLETED', summary: 'The capability can execute the governed reference path.', recommendations: json(['Keep authorization snapshots and dynamic reconciliation mandatory.']), risks: json(['Synthetic evidence must remain visibly labeled.']), dependencies: json(['WorkGraph', 'IAM', 'Audit Governance']), assessedAt: referenceDate, traceId: 'trace-reference-pilot-impact' },
      create: { id: ids.impact, projectId: project.id, capabilityId, capabilityName: 'Reference Delivery Capability', status: 'COMPLETED', summary: 'The capability can execute the governed reference path.', recommendations: json(['Keep authorization snapshots and dynamic reconciliation mandatory.']), risks: json(['Synthetic evidence must remain visibly labeled.']), dependencies: json(['WorkGraph', 'IAM', 'Audit Governance']), traceId: 'trace-reference-pilot-impact', assessedAt: referenceDate, tenantId },
    })

    const board = await tx.board.upsert({ where: { id: ids.board }, update: { name: 'Reference pilot source board' }, create: { id: ids.board, projectId: project.id, name: 'Reference pilot source board', createdById: author.id, tenantId } })
    const branch = await tx.boardBranch.upsert({ where: { id: ids.branch }, update: { status: 'ACTIVE', headEventSeq: 1n }, create: { id: ids.branch, boardId: board.id, name: 'main', headEventSeq: 1n, mode: 'HUMAN', purpose: 'Reference pilot evidence', status: 'ACTIVE', createdById: author.id, tenantId } })
    await tx.boardEvent.upsert({ where: { id: ids.boardEvent }, update: { payload: json({ title: 'Governed evidence spine', ...provenance }) }, create: { id: ids.boardEvent, boardId: board.id, branchId: branch.id, eventSeq: 1n, eventType: 'OBJECT_CREATED', objectIds: json(['reference-idea-1']), actorType: 'HUMAN', actorId: author.id, payload: json({ title: 'Governed evidence spine', ...provenance }), tenantId } })
    const artifact = await tx.ingestedArtifact.upsert({ where: { id: ids.artifact }, update: { status: 'COMPLETED' }, create: { id: ids.artifact, boardId: board.id, branchId: branch.id, kind: 'MARKDOWN', filename: 'reference-pilot-source.md', storageRef: 'reference://pilot/source', contentHash: digest('reference-pilot-source'), status: 'COMPLETED', parseSummary: json({ paragraphs: 2, ...provenance }), sourceSpans: json([{ id: 'span-1', start: 0, end: 120 }]), extractedClaims: json([]), droppedById: author.id, tenantId } })
    const report = await tx.artifactValidationReport.upsert({ where: { id: ids.report }, update: { tensions: json([{ id: tensionId, statement: 'Speed conflicts with mandatory independent verification.', sourceRefs: [artifact.id] }]), citations: json([{ artifactId: artifact.id, spanId: 'span-1' }]), status: 'READY' }, create: { id: ids.report, projectId: project.id, boardId: board.id, taxonomy: json(['governance', 'delivery']), findings: json([{ id: 'finding-1', statement: 'Delivery needs an independent verification gate.', sourceRefs: [artifact.id] }]), tensions: json([{ id: tensionId, statement: 'Speed conflicts with mandatory independent verification.', sourceRefs: [artifact.id] }]), citations: json([{ artifactId: artifact.id, spanId: 'span-1' }]), status: 'READY', contentHash: digest('reference-pilot-validation'), generatedById: author.id, tenantId } })
    await tx.artifactValidationSource.upsert({ where: { reportId_artifactId: { reportId: report.id, artifactId: artifact.id } }, update: {}, create: { id: ids.reportSource, reportId: report.id, artifactId: artifact.id, tenantId } })

    const claim = await tx.claim.upsert({
      where: { id: ids.claim },
      update: { statement: 'A contract-bound evidence spine prevents unverifiable completion.', status: 'ACCEPTED', alpha: 8, beta: 2, provenance: json({ boardEventId: ids.boardEvent, artifactId: artifact.id, ...provenance }) },
      create: { id: ids.claim, projectId: project.id, statement: 'A contract-bound evidence spine prevents unverifiable completion.', riskiestAssumption: 'Operators can follow explicit evidence links.', claimType: 'TECHNICAL', contextScope: 'reference-pilot', capabilityId, alpha: 8, beta: 2, status: 'ACCEPTED', stewardId: approver.id, createdById: author.id, provenance: json({ boardEventId: ids.boardEvent, artifactId: artifact.id, ...provenance }), tenantId },
    })

    await tx.decisionDossier.upsert({ where: { id: ids.dossier }, update: { status: 'ACCEPTED', claimRefs: json([claim.id]), resolvesTensions: json([tensionId]), acceptedOptionId: ids.optionAccepted, approvalRequestId: ids.decisionApproval, decidedById: approver.id, decidedAt: referenceDate }, create: { id: ids.dossier, projectId: project.id, title: 'Choose the pilot completion authority', problem: 'Completion needs one auditable owner.', status: 'ACCEPTED', claimRefs: json([claim.id]), resolvesTensions: json([tensionId]), acceptedOptionId: ids.optionAccepted, approvalRequestId: ids.decisionApproval, createdById: author.id, decidedById: approver.id, decidedAt: referenceDate, tenantId } })
    await tx.decisionOption.upsert({ where: { id: ids.optionAccepted }, update: { status: 'ACCEPTED' }, create: { id: ids.optionAccepted, dossierId: ids.dossier, title: 'WorkItemFinalizer authority', summary: 'Only the finalizer may complete governed work.', status: 'ACCEPTED', claimRefs: json([claim.id]), tradeoffs: json(['More evidence', 'Stronger reproducibility']), estimatedHours: 8, estimatedCostLow: 400, estimatedCostHigh: 800, estimatedTokens: 2_000, riskScore: 2, createdById: author.id, tenantId } })
    await tx.decisionOption.upsert({ where: { id: ids.optionRejected }, update: { status: 'REJECTED' }, create: { id: ids.optionRejected, dossierId: ids.dossier, title: 'Direct status mutation', summary: 'Allow executors to mark work complete.', status: 'REJECTED', claimRefs: json([claim.id]), tradeoffs: json(['Faster', 'Not auditable']), estimatedHours: 2, estimatedCostLow: 100, estimatedCostHigh: 200, estimatedTokens: 500, riskScore: 5, createdById: author.id, tenantId } })
    await tx.approvalRequest.upsert({ where: { id: ids.decisionApproval }, update: { status: 'APPROVED', quorumMetAt: referenceDate }, create: { id: ids.decisionApproval, subjectType: 'DecisionDossier', subjectId: ids.dossier, requestedById: author.id, assignedToId: approver.id, assignmentMode: 'DIRECT_USER', capabilityId, status: 'APPROVED', approvedContentHash: digest(ids.optionAccepted), quorumRequired: 1, adminOverride: false, quorumMetAt: referenceDate, formData: json({ selectedOptionId: ids.optionAccepted, ...provenance }), tenantId } })
    await tx.approvalDecision.upsert({ where: { requestId_decidedById: { requestId: ids.decisionApproval, decidedById: approver.id } }, update: { decision: 'APPROVED', notes: 'Independent reference-pilot decision.' }, create: { requestId: ids.decisionApproval, decidedById: approver.id, decision: 'APPROVED', notes: 'Independent reference-pilot decision.', decidedAt: referenceDate } })

    const projectPackage = {
      analysis: { problem: 'Completion without linked evidence cannot be trusted.', goals: [{ text: 'Reach 100% reference pilot proof', metric: 'pilot_readiness=100' }], stakeholders: [{ name: 'Platform operator', role: 'Operator', concern: 'Evidence integrity' }], assumptions: ['Synthetic evidence remains labeled.'], constraints: ['Independent approval is mandatory.'] },
      requirements: [{ id: requirementId, statement: 'The platform shall preserve a complete idea-to-verified-check-in evidence chain.', priority: 'MUST', acceptanceCriteria: ['A dynamic reconciliation passes and the WorkItemFinalizer records completion.'], rationale: 'A single evidence spine enables audit and replay.', claimRefs: [claim.id], decisionRefs: [ids.dossier], objectiveRefs: [objective.id] }],
      decisions: [{ id: ids.dossier, title: 'Completion authority', status: 'ACCEPTED', decision: 'Use WorkItemFinalizer.', claimRefs: [claim.id], optionRefs: [ids.optionAccepted], resolvesTensions: [tensionId] }],
    }
    await tx.projectSpecification.upsert({ where: { projectId: project.id }, update: { package: json(projectPackage), revision: 1, updatedById: author.id, tenantId }, create: { projectId: project.id, package: json(projectPackage), revision: 1, updatedById: author.id, tenantId } })

    const specificationPackage = {
      schemaVersion: '1.0', summary: 'Reference pilot execution contract',
      sources: [{ id: claim.id, kind: 'CLAIM', label: 'Contract-bound evidence claim', ref: `/synthesis/rooms?claim=${claim.id}` }],
      requirements: [{ id: requirementId, type: 'FUNCTIONAL', statement: projectPackage.requirements[0].statement, priority: 'MUST', risk: 'HIGH', sourceIds: [claim.id], objectiveRefs: [objective.id], acceptanceCriterionIds: ['AC-REF-001'], testObligationIds: ['TEST-REF-001'] }],
      acceptanceCriteria: [{ id: 'AC-REF-001', requirementIds: [requirementId], given: ['a governed WorkItem'], when: ['dynamic verification passes'], then: ['the Finalizer records one completion event'] }],
      testObligations: [{ id: 'TEST-REF-001', verifies: [requirementId], kind: 'dynamic', description: 'Execute the reference verification suite.', requiredEvidence: ['TEST_RESULT'], minimumCases: ['happy path', 'stale result fence'] }],
      reconciliationPolicy: { profile: 'STRICT', requiredEvidence: ['TEST_RESULT'], forbiddenPaths: ['.env'] },
      analysis: { problem: projectPackage.analysis.problem, goals: ['Reach 100% reference pilot proof'], stakeholders: [{ role: 'Operator', name: 'Platform operator', interest: 'Evidence integrity' }], assumptions: projectPackage.analysis.assumptions, constraints: projectPackage.analysis.constraints },
      decisions: [{ id: ids.dossier, title: 'Completion authority', status: 'ACCEPTED', decision: 'Use WorkItemFinalizer.', alternatives: ['Direct status mutation'] }],
    }
    const specHash = digest(specificationPackage)
    await tx.specificationVersion.upsert({ where: { id: ids.specification }, update: { status: 'ACTIVE', package: json(specificationPackage), renderedMarkdown: '# Reference pilot execution contract', contentHash: specHash, approvedById: approver.id, approvedAt: referenceDate, approvalComment: 'Independent reference-pilot approval.' }, create: { id: ids.specification, specificationProjectId: project.id, version: 1, revision: 1, status: 'ACTIVE', package: json(specificationPackage), renderedMarkdown: '# Reference pilot execution contract', contentHash: specHash, createdById: author.id, approvedById: approver.id, approvedAt: referenceDate, approvalComment: 'Independent reference-pilot approval.', tenantId } })
    await tx.approvalRequest.upsert({ where: { id: ids.specificationApproval }, update: { status: 'APPROVED', quorumMetAt: referenceDate }, create: { id: ids.specificationApproval, subjectType: 'SpecificationVersion', subjectId: ids.specification, requestedById: author.id, assignedToId: approver.id, assignmentMode: 'DIRECT_USER', capabilityId, status: 'APPROVED', approvedContentHash: specHash, quorumRequired: 1, adminOverride: false, quorumMetAt: referenceDate, formData: json(provenance), tenantId } })
    await tx.approvalDecision.upsert({ where: { requestId_decidedById: { requestId: ids.specificationApproval, decidedById: approver.id } }, update: { decision: 'APPROVED', notes: 'Independent execution-contract approval.' }, create: { requestId: ids.specificationApproval, decidedById: approver.id, decision: 'APPROVED', notes: 'Independent execution-contract approval.', decidedAt: referenceDate } })

    await tx.generationPlan.upsert({ where: { id: ids.plan }, update: { status: 'APPLIED', contentHash: digest('reference-pilot-plan'), validation: json({ passed: true, coverage: 1, ...provenance }), appliedRows: 1, totalRows: 1 }, create: { id: ids.plan, specificationProjectId: project.id, specificationVersionId: ids.specification, status: 'APPLIED', contentHash: digest('reference-pilot-plan'), requestId: 'reference-pilot-plan-v1', validation: json({ passed: true, coverage: 1, ...provenance }), appliedRows: 1, totalRows: 1, createdById: author.id, tenantId } })
    await tx.workItem.upsert({ where: { id: ids.workItem }, update: { status: 'COMPLETED', reconciliationState: 'VERIFIED', finalizationGeneration: 1, finalOutput: json({ result: 'Reference delivery accepted', ...provenance }) }, create: { id: ids.workItem, workCode: 'REF-PILOT-WI-001', originType: 'SPEC_GENERATED', workItemTypeKey: 'REFERENCE_DELIVERY', routingMode: 'MANUAL', routingState: 'ROUTED', title: 'Deliver the governed reference change', description: 'A synthetic but structurally complete delivery chain.', parentCapabilityId: capabilityId, status: 'COMPLETED', reconciliationState: 'VERIFIED', completionPolicy: 'VERIFY_THEN_APPROVE', finalizationGeneration: 1, input: json({ requirementId }), details: json(provenance), specSourceRef: json({ specificationVersionId: ids.specification }), budget: json({ tokenLimit: 2_000 }), priority: 90, createdById: author.id, approvedById: approver.id, projectId: project.id, finalOutput: json({ result: 'Reference delivery accepted', ...provenance }), tenantId } })
    await tx.workItemTarget.upsert({ where: { id: ids.target }, update: { status: 'ACCEPTED', output: json({ result: 'accepted', ...provenance }), completedAt: referenceDate }, create: { id: ids.target, workItemId: ids.workItem, targetCapabilityId: capabilityId, roleKey: 'IMPLEMENTER', status: 'ACCEPTED', claimedById: author.id, output: json({ result: 'accepted', ...provenance }), claimedAt: referenceDate, startedAt: referenceDate, submittedAt: referenceDate, completedAt: referenceDate, tenantId } })
    await tx.workItemSpecificationBinding.upsert({ where: { id: ids.binding }, update: { resolvedPackage: json(specificationPackage), resolvedContentHash: specHash, requirementIds: json([requirementId]), status: 'CURRENT' }, create: { id: ids.binding, workItemId: ids.workItem, specificationVersionId: ids.specification, bindingGeneration: 1, resolvedPackage: json(specificationPackage), resolvedContentHash: specHash, requirementIds: json([requirementId]), status: 'CURRENT', boundById: author.id, boundAt: referenceDate, tenantId } })
    await tx.developmentScope.upsert({ where: { id: ids.scope }, update: { status: 'ACCEPTED', currentHandoffGenerationId: null }, create: { id: ids.scope, workItemId: ids.workItem, workItemTargetId: ids.target, specificationBindingId: ids.binding, targetCapabilityId: capabilityId, repository: 'reference://governed-delivery', component: 'evidence-spine', requirementIds: json([requirementId]), mandatory: true, status: 'ACCEPTED', tenantId } })
    await tx.handoffGeneration.upsert({ where: { id: ids.handoff }, update: { status: 'PUBLISHED', contentHash: digest('reference-pilot-handoff') }, create: { id: ids.handoff, developmentScopeId: ids.scope, generation: 1, specificationBindingId: ids.binding, repository: 'reference://governed-delivery', component: 'evidence-spine', baseBranch: 'main', baseCommitSha: '0000000000000000000000000000000000000000', requirementIds: json([requirementId]), requiredEvidence: json(['TEST_RESULT']), forbiddenPaths: json(['.env']), reconciliationPolicy: json({ mode: 'DYNAMIC', ...provenance }), contentHash: digest('reference-pilot-handoff'), status: 'PUBLISHED', publishedById: author.id, publishedAt: referenceDate, tenantId } })
    await tx.developmentScope.update({ where: { id: ids.scope }, data: { currentHandoffGenerationId: ids.handoff } })
    await tx.implementationSubmission.upsert({ where: { id: ids.submission }, update: { status: 'ACCEPTED', manifest: json({ tests: ['reference-pilot'], ...provenance }) }, create: { id: ids.submission, workItemId: ids.workItem, specificationVersionId: ids.specification, specificationBindingId: ids.binding, developmentScopeId: ids.scope, handoffGenerationId: ids.handoff, specificationHash: specHash, repository: 'reference://governed-delivery', baseCommitSha: '0000000000000000000000000000000000000000', headCommitSha: '1111111111111111111111111111111111111111', manifest: json({ tests: ['reference-pilot'], ...provenance }), claims: json([{ requirementId, status: 'implemented' }]), deviations: json([]), source: 'REFERENCE_PILOT', status: 'ACCEPTED', tenantId } })
    await tx.reconciliationRun.upsert({ where: { id: ids.verifiedRun }, update: { status: 'VERIFIED_PASS', reconciliationState: 'VERIFIED', summary: json({ tests: { passed: 1, failed: 0 }, ...provenance }) }, create: { id: ids.verifiedRun, workItemId: ids.workItem, submissionId: ids.submission, specificationVersionId: ids.specification, specificationBindingId: ids.binding, developmentScopeId: ids.scope, handoffGenerationId: ids.handoff, generation: 3, specificationHash: specHash, mode: 'DYNAMIC', status: 'VERIFIED_PASS', reconciliationState: 'VERIFIED', summary: json({ tests: { passed: 1, failed: 0 }, ...provenance }), traceId: 'trace-reference-pilot-verified', startedById: author.id, startedAt: referenceDate, completedAt: referenceDate, tenantId } })
    await tx.requirementVerdict.upsert({ where: { reconciliationRunId_requirementId: { reconciliationRunId: ids.verifiedRun, requirementId } }, update: { verdict: 'PASS', verified: true }, create: { id: ids.verdict, reconciliationRunId: ids.verifiedRun, requirementId, priority: 'MUST', verdict: 'PASS', claimStatus: 'SATISFIED', rationale: 'The isolated reference verification suite passed.', evidence: json([{ kind: 'TEST_RESULT', result: 'PASS', ...provenance }]), verified: true } })
    await tx.reconciliationRun.upsert({ where: { id: ids.failedRun }, update: { status: 'FAILED', reconciliationState: 'NOT_VERIFIED', summary: json({ tests: { passed: 0, failed: 1 }, ...provenance }) }, create: { id: ids.failedRun, workItemId: ids.workItem, submissionId: ids.submission, specificationVersionId: ids.specification, specificationBindingId: ids.binding, developmentScopeId: ids.scope, handoffGenerationId: ids.handoff, generation: 1, specificationHash: specHash, mode: 'DYNAMIC', status: 'FAILED', reconciliationState: 'NOT_VERIFIED', summary: json({ tests: { passed: 0, failed: 1 }, ...provenance }), traceId: 'trace-reference-pilot-failed', startedById: author.id, startedAt: referenceDate, completedAt: referenceDate, tenantId } })
    await tx.reconciliationRun.upsert({ where: { id: ids.staleRun }, update: { status: 'ERROR', reconciliationState: 'STALE', summary: json({ fence: { expectedGeneration: 3, receivedGeneration: 1, outcome: 'REJECTED' }, ...provenance }) }, create: { id: ids.staleRun, workItemId: ids.workItem, submissionId: ids.submission, specificationVersionId: ids.specification, specificationBindingId: ids.binding, developmentScopeId: ids.scope, handoffGenerationId: ids.handoff, generation: 1, specificationHash: specHash, mode: 'DYNAMIC', status: 'ERROR', reconciliationState: 'STALE', summary: json({ fence: { expectedGeneration: 3, receivedGeneration: 1, outcome: 'REJECTED' }, ...provenance }), traceId: 'trace-reference-pilot-stale', startedById: author.id, startedAt: referenceDate, completedAt: referenceDate, tenantId } })
    await tx.claimDriftSignal.upsert({ where: { id: ids.drift }, update: { beforeMean: 0.8, afterMean: 0.6, delta: -0.2, direction: 'DOWN', status: 'RESOLVED' }, create: { id: ids.drift, projectId: project.id, claimId: claim.id, reconciliationRunId: ids.failedRun, beforeMean: 0.8, afterMean: 0.6, delta: -0.2, direction: 'DOWN', threshold: 0.1, status: 'RESOLVED', traceId: 'trace-reference-pilot-failed', tenantId } })
    await tx.workItemFinalizationRecord.upsert({ where: { id: ids.finalization }, update: { status: 'COMPLETED', actorId: approver.id, finalOutput: json({ result: 'accepted', ...provenance }), evidenceDigest: digest('reference-pilot-finalization') }, create: { id: ids.finalization, workItemId: ids.workItem, finalizationGeneration: 1, status: 'COMPLETED', actorId: approver.id, finalOutput: json({ result: 'accepted', ...provenance }), evidenceDigest: digest('reference-pilot-finalization'), reason: 'All mandatory scopes have verified evidence and independent approval.', tenantId } })
    await tx.workItemEvent.upsert({ where: { id: ids.finalizedEvent }, update: { actorId: approver.id, payload: json({ source: 'WorkItemFinalizer', finalizationGeneration: 1, ...provenance }) }, create: { id: ids.finalizedEvent, workItemId: ids.workItem, targetId: ids.target, eventType: 'WORK_ITEM_FINALIZED', actorId: approver.id, payload: json({ source: 'WorkItemFinalizer', finalizationGeneration: 1, ...provenance }), createdAt: referenceDate, tenantId } })
    await tx.governanceWaiver.upsert({ where: { id: ids.waiver }, update: { status: 'APPROVED', requestedBy: author.id, approvedBy: approver.id }, create: { id: ids.waiver, workItemId: ids.workItem, controlKey: 'REFERENCE_PILOT_NETWORK_ISOLATION_EXCEPTION', reason: 'The local synthetic fixture uses a reference URI and no external network.', status: 'APPROVED', requestedBy: author.id, approvedBy: approver.id, expiresAt: new Date('2026-12-31T23:59:59.000Z') } })
    await tx.generationPlanRow.upsert({ where: { id: ids.planRow }, update: { workItemId: ids.workItem, state: 'COMPLETED', actualFinishAt: referenceDate, actualHours: 7.5, actualCostUsd: 650 }, create: { id: ids.planRow, planId: ids.plan, rowKey: 'reference-delivery', title: 'Deliver the governed reference change', description: 'Exercise the complete contract-bound evidence spine.', targetCapabilityId: capabilityId, repository: 'reference://governed-delivery', component: 'evidence-spine', baseBranch: 'main', baseCommitSha: '0000000000000000000000000000000000000000', requirementIds: json([requirementId]), decisionRefs: json([ids.dossier]), claimRefs: json([claim.id]), requiredEvidence: json(['TEST_RESULT']), forbiddenPaths: json(['.env']), reconciliationPolicy: json({ mode: 'DYNAMIC' }), dependencies: json([]), estimatedHours: 8, rateBand: 'REFERENCE', estimatedCostLow: 400, estimatedCostHigh: 800, estimatedTokens: 2_000, objectiveValueScore: 5, projectedStartAt: referenceDate, projectedFinishAt: referenceDate, criticalPath: true, actualStartAt: referenceDate, actualFinishAt: referenceDate, actualHours: 7.5, actualCostUsd: 650, workItemId: ids.workItem, state: 'COMPLETED', tenantId } })

    await tx.workItem.upsert({ where: { id: ids.adHocWorkItem }, update: { originType: 'AD_HOC', projectId: project.id }, create: { id: ids.adHocWorkItem, workCode: 'REF-PILOT-ADHOC-001', originType: 'AD_HOC', workItemTypeKey: 'REFERENCE_FAST_LANE', routingMode: 'MANUAL', routingState: 'UNROUTED', title: 'Reference fast-lane incident', description: 'Exercises the explicitly governed AD_HOC path.', parentCapabilityId: capabilityId, status: 'ARCHIVED', completionPolicy: 'APPROVAL_ONLY', input: json({ incident: 'synthetic' }), details: json(provenance), budget: json({ tokenLimit: 500 }), priority: 40, createdById: author.id, projectId: project.id, tenantId } })
    await tx.workItemEvent.upsert({ where: { id: ids.slaEvent }, update: { actorId: approver.id }, create: { id: ids.slaEvent, workItemId: ids.adHocWorkItem, eventType: 'SLA_BREACHED', actorId: approver.id, payload: json({ dueAt: '2026-07-01T08:00:00.000Z', observedAt: referenceDate.toISOString(), action: 'operator-alerted', ...provenance }), createdAt: referenceDate, tenantId } })
    await tx.projectBudgetEvent.upsert({ where: { evidenceKey: `reference-pilot:${project.id}:warning` }, update: { status: 'WARNING', percentUsed: 85, tokenUsed: 8_500, action: 'ROUTE_ECONOMY_MODEL' }, create: { id: ids.budgetEvent, projectId: project.id, evidenceKey: `reference-pilot:${project.id}:warning`, scopeType: 'PROJECT', scopeId: project.id, status: 'WARNING', percentUsed: 85, tokenUsed: 8_500, costUsedUsd: 42, thresholdPercent: 80, action: 'ROUTE_ECONOMY_MODEL', traceId: 'trace-reference-pilot-budget', metadata: json(provenance), tenantId } })

    await tx.approvalRequest.upsert({ where: { id: ids.sponsorApproval }, update: { status: 'APPROVED', quorumMetAt: referenceDate }, create: { id: ids.sponsorApproval, subjectType: 'BusinessReadout', subjectId: ids.sponsorReadout, requestedById: author.id, assignedToId: approver.id, assignmentMode: 'DIRECT_USER', capabilityId, status: 'APPROVED', approvedContentHash: digest('reference-pilot-sponsor-readout'), quorumRequired: 1, adminOverride: false, quorumMetAt: referenceDate, formData: json(provenance), tenantId } })
    await tx.approvalDecision.upsert({ where: { requestId_decidedById: { requestId: ids.sponsorApproval, decidedById: approver.id } }, update: { decision: 'APPROVED', notes: 'Synthetic reference attestation only.' }, create: { requestId: ids.sponsorApproval, decidedById: approver.id, decision: 'APPROVED', notes: 'Synthetic reference attestation only.', decidedAt: referenceDate } })
    const readouts = [
      { id: ids.sponsorReadout, kind: 'SPONSOR' as const, status: 'SIGNED' as const, markdown: '# Sponsor reference readout\n\nSynthetic control exercise approved for local validation.', citations: [{ type: 'specification', id: ids.specification }], signedAt: referenceDate, approval: ids.sponsorApproval },
      { id: ids.weeklyReadout1, kind: 'WEEKLY' as const, status: 'DRAFT' as const, markdown: '# Weekly reference readout 1\n\nSpecification and plan prepared.', citations: [{ type: 'plan', id: ids.plan }], signedAt: null, approval: null },
      { id: ids.weeklyReadout2, kind: 'WEEKLY' as const, status: 'DRAFT' as const, markdown: '# Weekly reference readout 2\n\nVerification and finalization complete.', citations: [{ type: 'reconciliation', id: ids.verifiedRun }], signedAt: null, approval: null },
      { id: ids.morningReadout, kind: 'MORNING' as const, status: 'DRAFT' as const, markdown: '# Morning reference brief\n\nSpend: 8,500 / 10,000 tokens.\n\nAction: review the budget warning and finalization evidence.', citations: [{ type: 'budget-event', id: ids.budgetEvent }, { type: 'finalization', id: ids.finalization }], signedAt: null, approval: null },
    ]
    for (const readout of readouts) {
      await tx.businessReadout.upsert({ where: { id: readout.id }, update: { renderedMarkdown: readout.markdown, citations: json(readout.citations), contentHash: digest(readout.markdown), status: readout.status, sponsorApprovalId: readout.approval, signedAt: readout.signedAt }, create: { id: readout.id, tenantId, studioProjectId: project.id, objectiveId: objective.id, specificationVersionId: ids.specification, kind: readout.kind, periodStart: new Date('2026-06-30T00:00:00.000Z'), periodEnd: new Date('2026-07-06T23:59:59.000Z'), content: json({ summary: readout.markdown, ...provenance }), citations: json(readout.citations), renderedMarkdown: readout.markdown, contentHash: digest(readout.markdown), status: readout.status, sponsorApprovalId: readout.approval, generatedById: author.id, signedAt: readout.signedAt } })
    }

    await tx.specificationChangeRequest.upsert({ where: { id: ids.changeRequest }, update: { status: 'APPROVED', requirementDeltas: json({ [requirementId]: { change: 'Clarify evidence retention.', consequence: 'No scope loss.' } }), costDelta: json({ low: 50, high: 100, currency: 'USD' }), scheduleDelta: json({ days: 1 }), milestoneImpacts: json([{ milestone: 'Reference verification', impact: 'one-day documentation update' }]), decidedById: approver.id, decidedAt: referenceDate }, create: { id: ids.changeRequest, projectId: project.id, driftSignalId: ids.drift, specificationVersionId: ids.specification, title: 'Clarify evidence retention after failed verification', reason: 'The failed reconciliation changed the claim posterior.', requirementDeltas: json({ [requirementId]: { change: 'Clarify evidence retention.', consequence: 'No scope loss.' } }), costDelta: json({ low: 50, high: 100, currency: 'USD' }), scheduleDelta: json({ days: 1 }), milestoneImpacts: json([{ milestone: 'Reference verification', impact: 'one-day documentation update' }]), status: 'APPROVED', requestedById: author.id, decidedById: approver.id, decidedAt: referenceDate, traceId: 'trace-reference-pilot-change', metadata: json(provenance), tenantId } })

    for (let index = 1; index <= 5; index += 1) {
      await tx.attentionItem.upsert({
        where: { projectId_sourceType_sourceId: { projectId: project.id, sourceType: 'REFERENCE_PILOT', sourceId: `attention-${index}` } },
        update: { status: 'RESOLVED', resolution: 'CONFIRMED', resolvedById: approver.id, resolvedAt: referenceDate, actionHref: `/synthesis/pilot?project=${project.id}` },
        create: { projectId: project.id, sourceType: 'REFERENCE_PILOT', sourceId: `attention-${index}`, band: index <= 2 ? 'DECIDE_NOW' : 'REVIEW', title: `Reference attention item ${index}`, summary: 'Human calibration decision for the synthetic reference pilot.', actionHref: `/synthesis/pilot?project=${project.id}`, stakes: 0.6, uncertainty: 0.4, urgency: 0.5, priority: 0.7 - index * 0.02, rankingReason: 'Reference calibration sample.', status: 'RESOLVED', assignedToId: approver.id, resolution: 'CONFIRMED', resolutionNote: 'Reviewed by the independent reference approver.', metadata: json(provenance), resolvedById: approver.id, resolvedAt: referenceDate, tenantId },
      })
    }

    return { projectId: project.id, projectCode: project.code, authorId: author.id, approverId: approver.id }
  }, { maxWait: 10_000, timeout: 60_000 })
}

seed()
  .then(result => console.log(JSON.stringify({ status: 'seeded', evidenceMode: 'REFERENCE_SYNTHETIC', ...result })))
  .catch(error => { console.error(error); process.exitCode = 1 })
  .finally(async () => prisma.$disconnect())
