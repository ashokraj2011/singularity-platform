import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { prisma } from '../src/lib/prisma'
import {
  claimWorkItemTarget,
  requestWorkItemRework,
  startWorkItemTarget,
} from '../src/modules/work-items/work-items.service'
import { registerSubmission } from '../src/modules/submissions/submissions.service'
import { specificationPackageBodySchema } from '../src/modules/specifications/specification.schemas'
import { requestSpecificationReview } from '../src/modules/specifications/specification-review.service'
import { approveSpecificationVersion } from '../src/modules/specifications/specifications.service'
import { applyDecisionApproval, evaluateProjectBudget, transitionChangeRequest } from '../src/modules/portfolio-execution/portfolio-execution.service'
import { runWithTenantDbContext, withTenantDbTransaction } from '../src/lib/tenant-db-context'
import { foldReconciliationIntoClaims } from '../src/modules/reconciliations/reconciliation-claim-evidence.service'

const HAS_DB = Boolean(process.env.TEST_DATABASE_URL)
const tenantId = 'contract-e2e'

function initiativeCapability(capabilityId: string, capabilityName: string) {
  return {
    primaryCapabilityId: capabilityId,
    primaryCapabilityName: capabilityName,
    capabilityLinks: {
      create: {
        capabilityId,
        capabilityName,
        role: 'PRIMARY' as const,
        tenantId,
      },
    },
  }
}

describe.runIf(HAS_DB)('contract-bound work execution — real Postgres', () => {
  afterAll(async () => {
    await prisma.$disconnect().catch(() => undefined)
  })

  it('rework fences the prior start command and permits a fresh child workflow run', async () => {
    const suffix = randomUUID().slice(0, 8)
    const team = await prisma.team.create({ data: { name: `Contract team ${suffix}` } })
    const user = await prisma.user.create({
      data: { email: `contract-${suffix}@example.test`, displayName: 'Contract reviewer', teamId: team.id },
    })
    const workflow = await prisma.workflow.create({
      data: {
        name: `Contract child ${suffix}`,
        teamId: team.id,
        createdById: user.id,
        status: 'ACTIVE',
        tenantId,
        eligibleWorkItemTypes: ['GENERAL'],
      },
    })
    const startNodeId = randomUUID()
    const endNodeId = randomUUID()
    await prisma.workflowDesignNode.createMany({ data: [
      { id: startNodeId, workflowId: workflow.id, nodeType: 'START', label: 'Start', positionX: 0, positionY: 0 },
      { id: endNodeId, workflowId: workflow.id, nodeType: 'END', label: 'Done', positionX: 240, positionY: 0 },
    ] })
    await prisma.workflowDesignEdge.create({
      data: { workflowId: workflow.id, sourceNodeId: startNodeId, targetNodeId: endNodeId },
    })
    const oldRun = await prisma.workflowInstance.create({
      data: { name: `Old child ${suffix}`, templateId: workflow.id, status: 'ACTIVE', tenantId, createdById: user.id },
    })
    const approval = await prisma.approvalRequest.create({
      data: { subjectType: 'WorkItem', subjectId: randomUUID(), requestedById: user.id, assignedToId: user.id, assignmentMode: 'DIRECT_USER', tenantId },
    })
    const workItem = await prisma.workItem.create({
      data: {
        workCode: `WRK-E2E-${suffix}`,
        title: 'Exercise rework lifecycle',
        status: 'AWAITING_PARENT_APPROVAL',
        parentApprovalRequestId: approval.id,
        createdById: user.id,
        tenantId,
      },
    })
    const target = await prisma.workItemTarget.create({
      data: {
        workItemId: workItem.id,
        targetCapabilityId: `capability-${suffix}`,
        childWorkflowTemplateId: workflow.id,
        childWorkflowInstanceId: oldRun.id,
        status: 'SUBMITTED',
        claimedById: user.id,
        tenantId,
      },
    })
    const idempotencyKey = `work-item-target-start:${workItem.id}:${target.id}:${workflow.id}`
    await prisma.workflowStartCommand.create({
      data: {
        idempotencyKey,
        requestHash: 'old-request',
        workItemTargetId: target.id,
        workflowInstanceId: oldRun.id,
        state: 'COMPLETED',
        attempt: 1,
        tenantId,
      },
    })

    await requestWorkItemRework(workItem.id, user.id, [target.id], 'Exercise another implementation pass')
    const reset = await prisma.workItemTarget.findUniqueOrThrow({ where: { id: target.id } })
    const staleCommand = await prisma.workflowStartCommand.findUniqueOrThrow({ where: { idempotencyKey } })
    expect(reset).toMatchObject({ status: 'REWORK_REQUESTED', claimedById: null, childWorkflowInstanceId: null })
    expect(staleCommand.state).toBe('STALE')
    expect((await prisma.workflowInstance.findUniqueOrThrow({ where: { id: oldRun.id } })).status).toBe('CANCELLED')

    await claimWorkItemTarget(workItem.id, target.id, user.id)
    const started = await startWorkItemTarget(workItem.id, target.id, user.id, {
      childWorkflowTemplateId: workflow.id,
      idempotencyKey,
    })
    expect(started.childWorkflowInstanceId).toBeTruthy()
    expect(started.childWorkflowInstanceId).not.toBe(oldRun.id)
    expect((await prisma.workflowStartCommand.findUniqueOrThrow({ where: { idempotencyKey } })).state).toBe('COMPLETED')
  })

  it('a newer scoped submission invalidates prior verified evidence and its active runner', async () => {
    const suffix = randomUUID().slice(0, 8)
    const workItem = await prisma.workItem.create({
      data: {
        workCode: `WRK-FRESH-${suffix}`,
        title: 'Exercise submission freshness',
        status: 'IN_PROGRESS',
        reconciliationState: 'VERIFIED',
        finalizationGeneration: 7,
        tenantId,
      },
    })
    const target = await prisma.workItemTarget.create({
      data: { workItemId: workItem.id, targetCapabilityId: `capability-${suffix}`, status: 'SUBMITTED', tenantId },
    })
    const specificationHash = `sha256:${'a'.repeat(64)}`
    const spec = await prisma.specificationVersion.create({
      data: {
        workItemId: workItem.id,
        version: 1,
        status: 'APPROVED',
        package: { requirements: [{ id: 'REQ-1', statement: 'Ship safely' }] },
        contentHash: specificationHash,
        tenantId,
      },
    })
    const binding = await prisma.workItemSpecificationBinding.create({
      data: {
        workItemId: workItem.id,
        specificationVersionId: spec.id,
        resolvedPackage: { requirements: [{ id: 'REQ-1', statement: 'Ship safely' }] },
        resolvedContentHash: specificationHash,
        requirementIds: ['REQ-1'],
        tenantId,
      },
    })
    const scope = await prisma.developmentScope.create({
      data: {
        workItemId: workItem.id,
        workItemTargetId: target.id,
        specificationBindingId: binding.id,
        targetCapabilityId: target.targetCapabilityId,
        repository: 'example/contract-repo',
        requirementIds: ['REQ-1'],
        status: 'SUBMITTED',
        tenantId,
      },
    })
    const handoff = await prisma.handoffGeneration.create({
      data: {
        developmentScopeId: scope.id,
        specificationBindingId: binding.id,
        repository: scope.repository,
        baseBranch: 'main',
        baseCommitSha: 'base0001',
        requirementIds: ['REQ-1'],
        contentHash: `sha256:${'b'.repeat(64)}`,
        status: 'PUBLISHED',
        tenantId,
      },
    })
    await prisma.developmentScope.update({
      where: { id: scope.id },
      data: { currentHandoffGenerationId: handoff.id },
    })
    const oldSubmission = await prisma.implementationSubmission.create({
      data: {
        workItemId: workItem.id,
        specificationVersionId: spec.id,
        specificationBindingId: binding.id,
        developmentScopeId: scope.id,
        handoffGenerationId: handoff.id,
        specificationHash,
        repository: scope.repository,
        baseCommitSha: 'base0001',
        headCommitSha: 'head0001',
        source: 'API',
        status: 'RECEIVED',
        tenantId,
      },
    })
    const oldRun = await prisma.reconciliationRun.create({
      data: {
        workItemId: workItem.id,
        submissionId: oldSubmission.id,
        specificationVersionId: spec.id,
        specificationBindingId: binding.id,
        developmentScopeId: scope.id,
        handoffGenerationId: handoff.id,
        specificationHash,
        mode: 'DYNAMIC',
        status: 'VERIFIED_PASS',
        reconciliationState: 'VERIFIED',
        tenantId,
      },
    })
    await prisma.reconciliationJob.create({
      data: {
        reconciliationRunId: oldRun.id,
        workItemId: workItem.id,
        submissionId: oldSubmission.id,
        status: 'RUNNING',
        repository: scope.repository,
        baseCommitSha: 'base0001',
        headCommitSha: 'head0001',
        claimToken: randomUUID(),
        leaseUntil: new Date(Date.now() + 60_000),
        tenantId,
      },
    })

    const registered = await registerSubmission(workItem.id, {
      specificationHash,
      repository: scope.repository,
      baseCommit: 'base0001',
      headCommit: 'head0002',
      claims: [{ requirementId: 'REQ-1', status: 'IMPLEMENTED', evidence: [{ kind: 'TEST', ref: 'contract#freshness' }] }],
      deviations: [],
      source: 'API',
    }, 'integration-runner', { developmentScopeId: scope.id, handoffGenerationId: handoff.id })

    expect(registered.invalidatedRunCount).toBe(1)
    expect((await prisma.reconciliationRun.findUniqueOrThrow({ where: { id: oldRun.id } })).reconciliationState).toBe('STALE')
    expect((await prisma.reconciliationJob.findUniqueOrThrow({ where: { reconciliationRunId: oldRun.id } })).status).toBe('CANCELLED')
    expect(await prisma.workItem.findUniqueOrThrow({ where: { id: workItem.id } })).toMatchObject({
      reconciliationState: 'STALE',
      finalizationGeneration: 8,
    })
    expect(await prisma.workItemEvent.count({
      where: { workItemId: workItem.id, eventType: 'RECONCILIATION_INVALIDATED' },
    })).toBe(1)
  })

  it('requires an independently routed approval before freezing a specification', async () => {
    const suffix = randomUUID().slice(0, 8)
    const permission = await prisma.permission.upsert({
      where: { name: 'workflow:approve' },
      update: {},
      create: { name: 'workflow:approve', resource: 'workflow', action: 'approve' },
    })
    const role = await prisma.role.create({ data: { name: `CONTRACT_APPROVER_${suffix}` } })
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } })
    const author = await prisma.user.create({ data: { email: `contract-author-${suffix}@example.test`, displayName: 'Specification author' } })
    const reviewer = await prisma.user.create({ data: { email: `contract-reviewer-${suffix}@example.test`, displayName: 'Independent reviewer' } })
    await prisma.userRole.createMany({ data: [
      { userId: author.id, roleId: role.id },
      { userId: reviewer.id, roleId: role.id },
    ] })
    const workItem = await prisma.workItem.create({
      data: {
        workCode: `WRK-REVIEW-${suffix}`,
        title: 'Require independent specification review',
        parentCapabilityId: `capability-${suffix}`,
        createdById: author.id,
        tenantId,
      },
    })
    const body = specificationPackageBodySchema.parse({
      requirements: [{ id: 'REQ-1', priority: 'MUST', statement: 'Require an independent decision', sourceIds: ['SRC-1'], acceptanceCriterionIds: ['AC-1'], testObligationIds: ['TEST-1'] }],
      acceptanceCriteria: [{ id: 'AC-1', requirementIds: ['REQ-1'], then: ['The decision is auditable'] }],
      testObligations: [{ id: 'TEST-1', verifies: ['REQ-1'], description: 'Verify segregation of duties' }],
      sources: [{ id: 'SRC-1', label: 'Contract-bound execution policy' }],
    })
    const version = await prisma.specificationVersion.create({
      data: { workItemId: workItem.id, version: 1, package: body, createdById: author.id, tenantId },
    })

    const request = await requestSpecificationReview(version.id, { assignedToId: reviewer.id }, author.id, tenantId)
    expect(request).toMatchObject({ status: 'PENDING', assignmentMode: 'DIRECT_USER', assignedToId: reviewer.id })
    expect((await prisma.specificationVersion.findUniqueOrThrow({ where: { id: version.id } })).status).toBe('IN_REVIEW')

    await prisma.approvalDecision.create({
      data: { requestId: request.id, decidedById: reviewer.id, decision: 'APPROVED' },
    })
    await prisma.approvalRequest.update({ where: { id: request.id }, data: { status: 'APPROVED' } })

    await expect(approveSpecificationVersion(workItem.id, version.id, { approvalRequestId: request.id }, author.id)).rejects.toThrow(/cannot approve/i)
    const approved = await approveSpecificationVersion(workItem.id, version.id, { approvalRequestId: request.id }, reviewer.id)
    expect(approved.version).toMatchObject({ status: 'APPROVED' })
    expect(approved.version.contentHash).toMatch(/^sha256:/)
  })

  it('prevents decision self-approval and preserves rejected alternatives', async () => {
    const suffix = randomUUID().slice(0, 8)
    const author = await prisma.user.create({ data: { email: `decision-author-${suffix}@example.test`, displayName: 'Decision author' } })
    const reviewer = await prisma.user.create({ data: { email: `decision-reviewer-${suffix}@example.test`, displayName: 'Decision reviewer' } })
    const { project, dossier, request } = await withTenantDbTransaction(prisma, async tx => {
      const project = await tx.specificationProject.create({
        data: {
          code: `DEC-${suffix}`,
          name: 'Decision governance',
          createdById: author.id,
          tenantId,
          ...initiativeCapability(`cap-decision-${suffix}`, 'Decision governance capability'),
        },
      })
      const dossier = await tx.decisionDossier.create({
        data: {
          projectId: project.id,
          title: 'Choose an implementation path',
          problem: 'The platform needs one durable choice with visible alternatives.',
          status: 'IN_REVIEW',
          createdById: author.id,
          tenantId,
          options: {
            create: [
              { title: 'Incremental', summary: 'Migrate in bounded slices.', createdById: author.id, tenantId },
              { title: 'Rewrite', summary: 'Replace the subsystem in one release.', createdById: author.id, tenantId },
            ],
          },
        },
        include: { options: true },
      })
      const selected = dossier.options[0]!
      const request = await tx.approvalRequest.create({
        data: {
          subjectType: 'DecisionDossier',
          subjectId: dossier.id,
          requestedById: author.id,
          assignedToId: reviewer.id,
          assignmentMode: 'DIRECT_USER',
          status: 'APPROVED',
          formData: { selectedOptionId: selected.id, projectId: project.id },
          tenantId,
        },
      })
      return { project, dossier, request }
    }, tenantId)
    const selected = dossier.options[0]!

    await expect(runWithTenantDbContext(tenantId, () => applyDecisionApproval(request.id, 'APPROVED', author.id)))
      .rejects.toThrow(/cannot approve/i)

    const accepted = await runWithTenantDbContext(tenantId, () => applyDecisionApproval(request.id, 'APPROVED', reviewer.id))
    expect(accepted).toMatchObject({ status: 'ACCEPTED', acceptedOptionId: selected.id, decidedById: reviewer.id })
    expect(accepted.options).toHaveLength(2)
    expect(accepted.options.find(option => option.id === selected.id)?.status).toBe('ACCEPTED')
    expect(accepted.options.find(option => option.id !== selected.id)?.status).toBe('REJECTED')
    const [security] = await prisma.$queryRaw<Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>>`
      SELECT relrowsecurity, relforcerowsecurity
      FROM pg_class
      WHERE oid = 'public.decision_dossiers'::regclass
    `
    const policies = await prisma.$queryRaw<Array<{ policyname: string }>>`
      SELECT policyname FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'decision_dossiers'
    `
    expect(security).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true })
    expect(policies.map(policy => policy.policyname)).toContain('tenant_isolation_policy')
  })

  it('stores at most one SLA breach event per WorkItem', async () => {
    const suffix = randomUUID().slice(0, 8)
    const workItem = await prisma.workItem.create({
      data: { workCode: `WRK-SLA-${suffix}`, title: 'Exercise SLA fence', dueAt: new Date(Date.now() - 60_000), tenantId },
    })
    await prisma.workItemEvent.create({ data: { workItemId: workItem.id, eventType: 'SLA_BREACHED', tenantId } })
    await expect(prisma.workItemEvent.create({ data: { workItemId: workItem.id, eventType: 'SLA_BREACHED', tenantId } }))
      .rejects.toMatchObject({ code: 'P2002' })
  })

  it('turns material reconciliation drift into traceable change control', async () => {
    const suffix = randomUUID().slice(0, 8)
    const traceId = `contract-drift-${suffix}`
    const project = await prisma.specificationProject.create({
      data: {
        code: `DRIFT-${suffix}`,
        name: 'Drift feedback loop',
        tenantId,
        ...initiativeCapability(`cap-drift-${suffix}`, 'Drift feedback capability'),
      },
    })
    const claim = await prisma.claim.create({
      data: {
        projectId: project.id,
        statement: 'The implementation satisfies the governing design constraint',
        stewardId: `steward-${suffix}`,
        tenantId,
      },
    })
    await prisma.projectSpecification.create({
      data: {
        projectId: project.id,
        package: {
          analysis: {},
          decisions: [],
          requirements: [{
            id: 'REQ-DRIFT',
            statement: 'Enforce the governing design constraint',
            priority: 'MUST',
            acceptanceCriteria: ['The dynamic verifier passes'],
            claimRefs: [claim.id],
            decisionRefs: [],
          }],
        },
        tenantId,
      },
    })
    const workItem = await prisma.workItem.create({
      data: { workCode: `WRK-DRIFT-${suffix}`, title: 'Exercise learning feedback', projectId: project.id, tenantId },
    })
    const specification = await prisma.specificationVersion.create({
      data: {
        specificationProjectId: project.id,
        version: 1,
        status: 'APPROVED',
        package: { requirements: [{ id: 'REQ-DRIFT', statement: 'Enforce the governing design constraint' }] },
        contentHash: `sha256:${'c'.repeat(64)}`,
        tenantId,
      },
    })
    const submission = await prisma.implementationSubmission.create({
      data: {
        workItemId: workItem.id,
        specificationVersionId: specification.id,
        specificationHash: specification.contentHash!,
        repository: 'example/drift-repo',
        baseCommitSha: 'base-drift',
        headCommitSha: 'head-drift',
        source: 'API',
        tenantId,
      },
    })
    const reconciliation = await prisma.reconciliationRun.create({
      data: {
        workItemId: workItem.id,
        submissionId: submission.id,
        specificationVersionId: specification.id,
        specificationHash: specification.contentHash,
        mode: 'DYNAMIC',
        status: 'FAILED',
        reconciliationState: 'NOT_VERIFIED',
        traceId,
        tenantId,
        verdicts: {
          create: { requirementId: 'REQ-DRIFT', verdict: 'FAIL', verified: true },
        },
      },
    })

    const folded = await runWithTenantDbContext(tenantId, () => foldReconciliationIntoClaims(reconciliation.id, `reviewer-${suffix}`), traceId)
    expect(folded).toMatchObject({ created: 1, changeRequests: 1, claimIds: [claim.id] })
    const signal = await prisma.claimDriftSignal.findUniqueOrThrow({
      where: { reconciliationRunId_claimId: { reconciliationRunId: reconciliation.id, claimId: claim.id } },
    })
    expect(signal).toMatchObject({ direction: 'DOWN', status: 'MATERIAL', traceId })
    const changeRequest = await prisma.specificationChangeRequest.findFirstOrThrow({
      where: { projectId: project.id, driftSignal: { reconciliationRunId: reconciliation.id } },
    })
    expect(changeRequest).toMatchObject({ status: 'RECOMMENDED', traceId })
    expect(await prisma.eventLog.findFirstOrThrow({
      where: { eventType: 'ReconciliationClaimEvidenceFolded', entityId: reconciliation.id },
    })).toMatchObject({ traceId, tenantId })

    await runWithTenantDbContext(tenantId, () => foldReconciliationIntoClaims(reconciliation.id, `reviewer-${suffix}`), traceId)
    expect(await prisma.claimDriftSignal.findUniqueOrThrow({ where: { id: signal.id } })).toMatchObject({
      beforeMean: signal.beforeMean,
      afterMean: signal.afterMean,
      delta: signal.delta,
      status: 'MATERIAL',
    })
    await expect(runWithTenantDbContext(tenantId, () => transitionChangeRequest(changeRequest.id, 'APPLIED', `independent-${suffix}`)))
      .rejects.toThrow(/cannot transition/i)
    await runWithTenantDbContext(tenantId, () => transitionChangeRequest(changeRequest.id, 'OPEN', `reviewer-${suffix}`))
    await expect(runWithTenantDbContext(tenantId, () => transitionChangeRequest(changeRequest.id, 'APPROVED', `reviewer-${suffix}`)))
      .rejects.toThrow(/cannot approve/i)
    await runWithTenantDbContext(tenantId, () => transitionChangeRequest(changeRequest.id, 'APPROVED', `independent-${suffix}`))
    await runWithTenantDbContext(tenantId, () => transitionChangeRequest(changeRequest.id, 'APPLIED', `reviewer-${suffix}`))
    expect(await prisma.specificationChangeRequest.findUniqueOrThrow({ where: { id: changeRequest.id } })).toMatchObject({ status: 'APPLIED' })
  })

  it('enforces the initiative envelope when a workflow stage has no narrower budget', async () => {
    const suffix = randomUUID().slice(0, 8)
    const project = await prisma.specificationProject.create({
      data: {
        code: `BUDGET-${suffix}`,
        name: 'Hierarchical budget controls',
        tokenBudget: 100,
        tenantId,
        ...initiativeCapability(`cap-budget-${suffix}`, 'Budget control capability'),
      },
    })
    await prisma.projectBudgetEnvelope.create({
      data: {
        projectId: project.id,
        tokenLimit: 100,
        warningPercent: 80,
        hardCapPercent: 120,
        stageBudgets: { Build: { tokenLimit: 10 } },
        tenantId,
      },
    })
    await prisma.projectTokenLedgerEntry.createMany({ data: [
      { projectId: project.id, evidenceKey: `budget-design-${suffix}`, stage: 'Design', totalTokens: 73, tenantId },
      { projectId: project.id, evidenceKey: `budget-build-${suffix}`, stage: 'Build', totalTokens: 12, tenantId },
    ] })

    const fallback = await runWithTenantDbContext(tenantId, () => evaluateProjectBudget(project.id, { stage: 'Verify' }))
    expect(fallback).toMatchObject({
      effective: { status: 'WARNING', action: 'ROUTE_ECONOMY_MODEL' },
      project: { tokens: 85, tokenLimit: 100 },
    })
    const stage = await runWithTenantDbContext(tenantId, () => evaluateProjectBudget(project.id, { stage: 'Build' }))
    expect(stage).toMatchObject({
      effective: { status: 'HARD_CAP', action: 'DENY_AGENT_TURNS' },
      project: { tokens: 12, tokenLimit: 10 },
    })
  })
})
