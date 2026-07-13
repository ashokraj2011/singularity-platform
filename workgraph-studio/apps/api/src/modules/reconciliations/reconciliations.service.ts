import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { currentTenantIdForDb, withTenantDbTransaction } from '../../lib/tenant-db-context'
import { logEvent, publishOutbox } from '../../lib/audit'
import { ConflictError, NotFoundError } from '../../lib/errors'
import { specificationPackageBodySchema, emptySpecificationPackageBody } from '../specifications/specification.schemas'
import type { DiffValidation } from '../workflow/runtime/executors/governance/diffVsDesign'
import { reconcile, type ReconciliationInput } from './reconciliation.engine'
import { buildTestPlan, applyTestResults, type TestResult, type CurrentVerdict } from './reconciliation.dynamic'

export type ReconciliationMode = 'DETERMINISTIC' | 'DYNAMIC'

type WorkItemRef = { id: string; workCode: string; title: string | null; tenantId: string | null }

async function loadWorkItem(workItemId: string): Promise<WorkItemRef> {
  const workItem = await prisma.workItem.findUnique({
    where: { id: workItemId },
    select: { id: true, workCode: true, title: true, tenantId: true },
  })
  if (!workItem) throw new NotFoundError('WorkItem', workItemId)
  return workItem
}

// Coerce the handoff's open reconciliationPolicy JSON (+ its forbiddenPaths column) into the
// DiffValidation contract the shared DIFF_VS_DESIGN evaluator understands. Anything malformed is
// dropped rather than throwing — a bad policy must not crash reconciliation.
function toDiffValidation(policy: Prisma.JsonValue, forbiddenPathsCol: Prisma.JsonValue): DiffValidation {
  const p = (policy && typeof policy === 'object' && !Array.isArray(policy) ? policy : {}) as Record<string, unknown>
  const strArray = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  const forbidden = [...strArray(forbiddenPathsCol), ...strArray(p.forbiddenPaths)]
  return {
    forbiddenPaths: forbidden.length ? [...new Set(forbidden)] : undefined,
    requiredPathPatterns: strArray(p.requiredPathPatterns).length ? strArray(p.requiredPathPatterns) : undefined,
    requireTests: typeof p.requireTests === 'boolean' ? p.requireTests : undefined,
    testPathPattern: typeof p.testPathPattern === 'string' ? p.testPathPattern : undefined,
  }
}

// The set of changed files the deterministic layer can see today: an explicit manifest.changedFiles
// list if the implementer/webhook provided one, else the FILE/TEST evidence refs from the claims.
function changedFilesOf(manifest: Prisma.JsonValue, claims: EngineClaimLike[]): string[] {
  const files = new Set<string>()
  if (manifest && typeof manifest === 'object' && !Array.isArray(manifest)) {
    const declared = (manifest as Record<string, unknown>).changedFiles
    if (Array.isArray(declared)) for (const f of declared) if (typeof f === 'string') files.add(f)
  }
  for (const c of claims) for (const e of c.evidence) if (e.kind === 'FILE' || e.kind === 'TEST') files.add(e.ref)
  return [...files]
}

type EngineClaimLike = { requirementId: string; status: string; evidence: { kind: string; ref: string }[] }

function asClaims(value: Prisma.JsonValue): EngineClaimLike[] {
  if (!Array.isArray(value)) return []
  return value.map((c) => {
    const o = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>
    const evidence = Array.isArray(o.evidence)
      ? o.evidence.map((e) => {
          const eo = (e && typeof e === 'object' ? e : {}) as Record<string, unknown>
          return { kind: String(eo.kind ?? ''), ref: String(eo.ref ?? '') }
        })
      : []
    return { requirementId: String(o.requirementId ?? ''), status: String(o.status ?? ''), evidence }
  })
}

function asDeviations(value: Prisma.JsonValue): { requirementId?: string; kind: string; description: string }[] {
  if (!Array.isArray(value)) return []
  return value.map((d) => {
    const o = (d && typeof d === 'object' ? d : {}) as Record<string, unknown>
    return {
      requirementId: typeof o.requirementId === 'string' ? o.requirementId : undefined,
      kind: String(o.kind ?? ''),
      description: String(o.description ?? ''),
    }
  })
}

/**
 * Run a deterministic reconciliation of one submission against its approved spec + published
 * handoff (spec §15). Synchronous — the deterministic layer runs no customer code, so there is no
 * queue here; the dynamic (test-execution) layer will enqueue a runner job in a later phase.
 */
export async function startReconciliation(workItemId: string, submissionId: string, actorId: string, mode: ReconciliationMode = 'DETERMINISTIC') {
  const workItem = await loadWorkItem(workItemId)

  const submission = await prisma.implementationSubmission.findUnique({ where: { id: submissionId } })
  if (!submission || submission.workItemId !== workItemId) throw new NotFoundError('ImplementationSubmission', submissionId)

  const target = await prisma.developmentTarget.findUnique({ where: { workItemId } })
  if (!target) throw new NotFoundError('DevelopmentTarget', workItemId)
  if (target.status !== 'PUBLISHED') {
    throw new ConflictError('The developer handoff is not published; cannot reconcile against it.')
  }

  const spec = await prisma.specificationVersion.findUnique({ where: { id: submission.specificationVersionId } })
  if (!spec) throw new NotFoundError('SpecificationVersion', submission.specificationVersionId)

  const parsed = specificationPackageBodySchema.safeParse(spec.package ?? {})
  const body = parsed.success ? parsed.data : emptySpecificationPackageBody()

  const claims = asClaims(submission.claims)
  const input: ReconciliationInput = {
    requirements: body.requirements.map((r) => ({ id: r.id, priority: r.priority, testObligationIds: r.testObligationIds })),
    scopeRequirementIds: ((target.requirementIds as string[] | null) ?? []),
    requiredEvidence: Array.isArray(target.requiredEvidence)
      ? (target.requiredEvidence as unknown[]).map((e) => {
          const o = (e && typeof e === 'object' ? e : {}) as Record<string, unknown>
          return { requirementId: String(o.requirementId ?? ''), kind: String(o.kind ?? '') }
        })
      : [],
    diffValidation: toDiffValidation(target.reconciliationPolicy, target.forbiddenPaths),
    claims,
    deviations: asDeviations(submission.deviations),
    changedFiles: changedFilesOf(submission.manifest, claims),
  }

  const result = reconcile(input)

  // Dynamic mode enqueues an out-of-process test run; the deterministic verdicts are the initial
  // matrix and the run stays RUNNING until the runner reports back. With no tests to run there is
  // nothing to execute, so it finalizes deterministically like DETERMINISTIC mode.
  const testPlan = mode === 'DYNAMIC'
    ? buildTestPlan({
        requirements: body.requirements.map((r) => ({ id: r.id, testObligationIds: r.testObligationIds })),
        testObligations: (body.testObligations as any[]).map((t) => ({ id: t.id, verifies: t.verifies, description: t.description, command: t.command })),
        scopeRequirementIds: input.scopeRequirementIds,
      })
    : []
  const willRunDynamic = mode === 'DYNAMIC' && testPlan.length > 0

  const runId = randomUUID()
  const traceId = `recon-${runId}`
  const tenantId = workItem.tenantId ?? currentTenantIdForDb() ?? undefined
  const now = new Date()
  const runStatus = willRunDynamic ? 'RUNNING' : result.status
  const runMode = willRunDynamic ? 'DYNAMIC' : mode

  const run = await withTenantDbTransaction(prisma, async (tx) => {
    const created = await tx.reconciliationRun.create({
      data: {
        id: runId,
        workItemId,
        submissionId,
        specificationVersionId: submission.specificationVersionId,
        specificationHash: spec.contentHash,
        mode: runMode,
        status: runStatus,
        summary: result.summary as unknown as Prisma.InputJsonValue,
        traceId,
        startedById: actorId,
        completedAt: willRunDynamic ? null : now,
        tenantId: workItem.tenantId,
      },
    })
    if (result.verdicts.length) {
      await tx.requirementVerdict.createMany({
        data: result.verdicts.map((v) => ({
          reconciliationRunId: runId,
          requirementId: v.requirementId,
          priority: v.priority,
          verdict: v.verdict,
          claimStatus: v.claimStatus,
          rationale: v.rationale,
          evidence: v.evidence as unknown as Prisma.InputJsonValue,
        })),
      })
    }
    if (result.findings.length) {
      await tx.reconciliationFinding.createMany({
        data: result.findings.map((f) => ({
          reconciliationRunId: runId,
          requirementId: f.requirementId ?? null,
          kind: f.kind,
          severity: f.severity,
          message: f.message,
        })),
      })
    }
    if (willRunDynamic) {
      await tx.reconciliationJob.create({
        data: {
          reconciliationRunId: runId,
          workItemId,
          submissionId,
          repository: target.repository,
          baseCommitSha: submission.baseCommitSha,
          headCommitSha: submission.headCommitSha,
          testPlan: testPlan as unknown as Prisma.InputJsonValue,
          tenantId: workItem.tenantId,
        },
      })
    }
    return created
  }, tenantId)

  // Timeline: always STARTED. COMPLETED only when we finalized now (deterministic path); the
  // dynamic path emits COMPLETED later when the runner job finishes (see completeReconciliationJob).
  const startedPayload = { reconciliationRunId: runId, submissionId, specificationVersionId: submission.specificationVersionId, mode: runMode, traceId, dynamic: willRunDynamic }
  await withTenantDbTransaction(prisma, async (tx) => {
    await tx.workItemEvent.create({ data: { workItemId, eventType: 'RECONCILIATION_STARTED', actorId, payload: startedPayload as Prisma.InputJsonValue, tenantId: workItem.tenantId } })
    if (!willRunDynamic) {
      const completedPayload = { reconciliationRunId: runId, submissionId, status: result.status, summary: result.summary, traceId }
      await tx.workItemEvent.create({ data: { workItemId, eventType: 'RECONCILIATION_COMPLETED', actorId, payload: completedPayload as Prisma.InputJsonValue, tenantId: workItem.tenantId } })
    }
  }, tenantId)
  if (!willRunDynamic) {
    const completedPayload = { reconciliationRunId: runId, submissionId, status: result.status, summary: result.summary, traceId }
    await logEvent('ReconciliationCompleted', 'WorkItem', workItemId, actorId, completedPayload)
    await publishOutbox('WorkItem', workItemId, 'ReconciliationCompleted', completedPayload)
  }

  return { run, verdicts: result.verdicts, findings: result.findings, summary: result.summary, dynamic: willRunDynamic }
}

export async function listReconciliations(workItemId: string, submissionId?: string) {
  await loadWorkItem(workItemId)
  const rows = await prisma.reconciliationRun.findMany({
    where: { workItemId, ...(submissionId ? { submissionId } : {}) },
    orderBy: { createdAt: 'desc' },
    include: { _count: { select: { verdicts: true, findings: true } } },
  })
  return { items: rows }
}

export async function getReconciliation(workItemId: string, runId: string) {
  await loadWorkItem(workItemId)
  const run = await prisma.reconciliationRun.findUnique({
    where: { id: runId },
    include: {
      verdicts: { orderBy: { requirementId: 'asc' } },
      findings: { orderBy: { createdAt: 'asc' } },
    },
  })
  if (!run || run.workItemId !== workItemId) throw new NotFoundError('ReconciliationRun', runId)
  return run
}

// ── Dynamic layer: the runner-facing job queue (spec §15, "Layer 2") ─────────────────────────
// A runner polls pending jobs, claims one (atomic claim + fresh claimToken), executes the test
// plan out-of-process, then completes/fails with that token. Claim + complete mirror the
// PendingExecution fencing: updateMany guarded by status/token, count===1 wins, else 409.

export async function listPendingReconciliationJobs(limit = 20) {
  const items = await prisma.reconciliationJob.findMany({ where: { status: 'PENDING' }, orderBy: { createdAt: 'asc' }, take: Math.min(Math.max(limit, 1), 100) })
  return { items }
}

export async function getReconciliationJob(jobId: string) {
  const job = await prisma.reconciliationJob.findUnique({ where: { id: jobId } })
  if (!job) throw new NotFoundError('ReconciliationJob', jobId)
  return job
}

export async function claimReconciliationJob(jobId: string, runnerId: string) {
  const job = await prisma.reconciliationJob.findUnique({ where: { id: jobId } })
  if (!job) throw new NotFoundError('ReconciliationJob', jobId)
  const tenantId = job.tenantId ?? undefined
  const claimToken = randomUUID()
  const claimed = await withTenantDbTransaction(prisma, (tx) => tx.reconciliationJob.updateMany({
    where: { id: jobId, status: 'PENDING' },
    data: { status: 'CLAIMED', claimToken, claimedBy: runnerId, claimedAt: new Date(), attempts: { increment: 1 } },
  }), tenantId)
  if (claimed.count !== 1) throw new ConflictError('Reconciliation job is already claimed or no longer pending.')
  return prisma.reconciliationJob.findUnique({ where: { id: jobId } }) // includes the fresh claimToken
}

export async function completeReconciliationJob(jobId: string, claimToken: string, tests: TestResult[], actorId: string) {
  const job = await prisma.reconciliationJob.findUnique({ where: { id: jobId } })
  if (!job) throw new NotFoundError('ReconciliationJob', jobId)
  const tenantId = job.tenantId ?? undefined

  const done = await withTenantDbTransaction(prisma, (tx) => tx.reconciliationJob.updateMany({
    where: { id: jobId, claimToken, status: { in: ['CLAIMED', 'RUNNING'] } },
    data: { status: 'COMPLETED', result: { tests } as unknown as Prisma.InputJsonValue },
  }), tenantId)
  if (done.count !== 1) throw new ConflictError('Reconciliation job is not claimed with this token, or is already resolved.')

  // Fold the executed test outcomes over the deterministic verdicts → verified matrix.
  const existing = await prisma.requirementVerdict.findMany({ where: { reconciliationRunId: job.reconciliationRunId } })
  const current: CurrentVerdict[] = existing.map((v) => ({ requirementId: v.requirementId, priority: v.priority, verdict: v.verdict, rationale: v.rationale }))
  const refined = applyTestResults(current, tests)
  const byReq = new Map(refined.verdicts.map((v) => [v.requirementId, v]))
  const now = new Date()

  const run = await withTenantDbTransaction(prisma, async (tx) => {
    for (const v of existing) {
      const r = byReq.get(v.requirementId)
      if (!r) continue
      await tx.requirementVerdict.update({ where: { id: v.id }, data: { verdict: r.verdict as any, rationale: r.rationale, verified: r.verified } })
    }
    return tx.reconciliationRun.update({
      where: { id: job.reconciliationRunId },
      data: { status: refined.status, summary: refined.summary as unknown as Prisma.InputJsonValue, completedAt: now },
    })
  }, tenantId)

  const payload = { reconciliationRunId: job.reconciliationRunId, submissionId: job.submissionId, status: refined.status, summary: refined.summary, traceId: run.traceId, dynamic: true }
  await withTenantDbTransaction(prisma, (tx) => tx.workItemEvent.create({ data: { workItemId: job.workItemId, eventType: 'RECONCILIATION_COMPLETED', actorId, payload: payload as Prisma.InputJsonValue, tenantId: job.tenantId } }), tenantId)
  await logEvent('ReconciliationCompleted', 'WorkItem', job.workItemId, actorId, payload)
  await publishOutbox('WorkItem', job.workItemId, 'ReconciliationCompleted', payload)

  return { run, verdicts: refined.verdicts, summary: refined.summary }
}

export async function failReconciliationJob(jobId: string, claimToken: string, error: string, actorId: string) {
  const job = await prisma.reconciliationJob.findUnique({ where: { id: jobId } })
  if (!job) throw new NotFoundError('ReconciliationJob', jobId)
  const tenantId = job.tenantId ?? undefined

  const done = await withTenantDbTransaction(prisma, (tx) => tx.reconciliationJob.updateMany({
    where: { id: jobId, claimToken, status: { in: ['CLAIMED', 'RUNNING'] } },
    data: { status: 'FAILED', error },
  }), tenantId)
  if (done.count !== 1) throw new ConflictError('Reconciliation job is not claimed with this token, or is already resolved.')

  const now = new Date()
  const run = await withTenantDbTransaction(prisma, async (tx) => {
    await tx.reconciliationFinding.create({ data: { reconciliationRunId: job.reconciliationRunId, kind: 'runner-error', severity: 'ERROR', message: `Dynamic reconciliation runner failed: ${error}` } })
    return tx.reconciliationRun.update({ where: { id: job.reconciliationRunId }, data: { status: 'ERROR', completedAt: now } })
  }, tenantId)

  const payload = { reconciliationRunId: job.reconciliationRunId, submissionId: job.submissionId, status: 'ERROR', error, traceId: run.traceId, dynamic: true }
  await withTenantDbTransaction(prisma, (tx) => tx.workItemEvent.create({ data: { workItemId: job.workItemId, eventType: 'RECONCILIATION_COMPLETED', actorId, payload: payload as Prisma.InputJsonValue, tenantId: job.tenantId } }), tenantId)
  await logEvent('ReconciliationFailed', 'WorkItem', job.workItemId, actorId, payload)
  await publishOutbox('WorkItem', job.workItemId, 'ReconciliationFailed', payload)

  return { run }
}
