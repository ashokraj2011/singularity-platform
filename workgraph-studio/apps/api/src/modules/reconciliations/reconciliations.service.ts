import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { adminPrisma } from '../../lib/admin-prisma'
import { currentTenantIdForDb, withTenantDbTransaction } from '../../lib/tenant-db-context'
import { logEvent, publishOutbox } from '../../lib/audit'
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors'
import { specificationPackageBodySchema } from '../specifications/specification.schemas'
import type { DiffValidation } from '../workflow/runtime/executors/governance/diffVsDesign'
import { reconcile, type ReconciliationInput } from './reconciliation.engine'
import { evaluateObligations, type SymbolFactSource } from './reconciliation.obligations'
import { buildTestPlan, applyTestResults, type TestResult, type CurrentVerdict } from './reconciliation.dynamic'
import { runSemanticPass } from './reconciliation.semantic.service'
import type { SemanticVerdict } from './reconciliation.semantic'
import { foldReconciliationIntoClaims } from './reconciliation-claim-evidence.service'

export type ReconciliationMode = 'DETERMINISTIC' | 'DYNAMIC' | 'SEMANTIC'

export function dynamicCompletionOutcome(
  expectedCount: number,
  tests: Array<{ status: string }>,
  refinedStatus: string,
): { completePlan: boolean; allPassed: boolean; allSkipped: boolean; status: string; reconciliationState: 'VERIFIED' | 'NOT_VERIFIED' } {
  const completePlan = expectedCount > 0 && tests.length === expectedCount
  const allPassed = completePlan && tests.every((result) => result.status === 'PASS')
  const allSkipped = completePlan && tests.every((result) => result.status === 'SKIPPED')
  const status = allPassed && refinedStatus === 'PASSED'
    ? 'VERIFIED_PASS'
    : refinedStatus === 'PASSED'
      ? 'PARTIAL'
      : refinedStatus
  return {
    completePlan,
    allPassed,
    allSkipped,
    status,
    reconciliationState: status === 'VERIFIED_PASS' ? 'VERIFIED' : 'NOT_VERIFIED',
  }
}

export function supersededSpecificationFinding(status: string, version: number) {
  return status === 'SUPERSEDED'
    ? {
        kind: 'superseded-specification',
        severity: 'WARNING' as const,
        message: `Submission is bound to superseded specification version ${version}; retain this result as historical evidence and rebase before finalization.`,
      }
    : null
}

type WorkItemRef = { id: string; workCode: string; title: string | null; tenantId: string | null; status: string }

async function loadWorkItem(workItemId: string): Promise<WorkItemRef> {
  const workItem = await prisma.workItem.findUnique({
    where: { id: workItemId },
    select: { id: true, workCode: true, title: true, tenantId: true, status: true },
  })
  if (!workItem) throw new NotFoundError('WorkItem', workItemId)
  return workItem
}

// Reconciliation is evidence, not completion authority. A run can move the evidence state of a
// WorkItem, but it must never set COMPLETED or reopen an item. WorkItemFinalizer is the only
// component allowed to perform that transition after it checks all targets, scopes, approvals,
// dependencies, and current generations.
const TERMINAL_WORK_ITEM_STATUSES = new Set(['CANCELLED', 'ARCHIVED'])

type EvidenceTransition = { from: string; to: string; eventType: string; reconciliationRunId: string }

export async function applyReconciliationCompletionGate(
  tx: Prisma.TransactionClient,
  args: {
    workItemId: string
    currentStatus: string
    runStatus: string
    reconciliationRunId: string
    submissionId: string
    actorId: string
    tenantId: string | null
  },
): Promise<EvidenceTransition | null> {
  const { workItemId, currentStatus, runStatus, reconciliationRunId, submissionId, actorId, tenantId } = args
  if (TERMINAL_WORK_ITEM_STATUSES.has(currentStatus)) return null

  const nextState = runStatus === 'VERIFIED_PASS'
    ? 'VERIFIED'
    : currentStatus === 'COMPLETED'
      ? 'CONTESTED'
      : 'NOT_VERIFIED'
  const eventType = nextState === 'CONTESTED' ? 'RECONCILIATION_CONTESTED' : 'RECONCILIATION_EVIDENCE_UPDATED'
  const payload = {
    reconciliationRunId,
    submissionId,
    reconciliationStatus: runStatus,
    from: currentStatus,
    reconciliationState: nextState,
    authoritativeCompletion: false,
  }
  await tx.workItem.update({ where: { id: workItemId }, data: { reconciliationState: nextState as any } })
  await tx.workItemEvent.create({
    data: {
      workItemId,
      eventType: eventType as any,
      actorId,
      payload: payload as Prisma.InputJsonValue,
      tenantId,
    },
  })
  return { from: currentStatus, to: nextState, eventType, reconciliationRunId }
}

async function emitEvidenceTransitionAudit(workItemId: string, actorId: string, transition: EvidenceTransition | null) {
  if (!transition) return
  const auditType = transition.eventType === 'RECONCILIATION_CONTESTED'
    ? 'ReconciliationContested'
    : 'ReconciliationEvidenceUpdated'
  await logEvent(auditType, 'WorkItem', workItemId, actorId, transition)
  await publishOutbox('WorkItem', workItemId, auditType, transition)
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

/**
 * Resolve the symbol inventory a submission's SYMBOL obligations can be checked against.
 *
 * There is no symbol index reachable from this service. The live tree-sitter index is a SQLite file
 * scoped to a mounted sandbox in mcp-server, and the `CapabilityCodeSymbol` table in agent-runtime is
 * legacy, extraction-gated off by default, and queryable only by embedding similarity — neither can
 * answer "does repo X have symbol Y in file Z" from here. So the only inventory available today is
 * one the submitting side reports, because it is the only party that can see the tree:
 *
 *   manifest.symbolIndex = {
 *     coveredPaths: ["src/tenant-scope.ts", ...],   // files the inventory actually walked
 *     symbols: [{ path, symbol, symbolKind }, ...]
 *   }
 *
 * `coveredPaths` is required. Without it an absent symbol cannot be distinguished from an unindexed
 * file, and the obligation would silently harden into a false FAIL. An inventory with no covered
 * paths is treated as no inventory at all — every SYMBOL obligation then reads NOT_VERIFIED.
 *
 * Provenance is recorded as MANIFEST (self-reported, mechanically produced) rather than INDEX
 * (read from a trusted index) so a PASS is never mistaken for an independently verified fact.
 */
function symbolFactsOf(manifest: Prisma.JsonValue): SymbolFactSource | null {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return null
  const raw = (manifest as Record<string, unknown>).symbolIndex
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const coveredPaths = Array.isArray(o.coveredPaths) ? o.coveredPaths.filter((p): p is string => typeof p === 'string') : []
  if (coveredPaths.length === 0) return null
  const symbols = Array.isArray(o.symbols)
    ? o.symbols
        .map((s) => {
          const so = (s && typeof s === 'object' && !Array.isArray(s) ? s : {}) as Record<string, unknown>
          return {
            path: String(so.path ?? ''),
            symbol: String(so.symbol ?? ''),
            symbolKind: typeof so.symbolKind === 'string' ? so.symbolKind : undefined,
          }
        })
        .filter((s) => s.path && s.symbol)
    : []
  return { provenance: 'MANIFEST', symbols, coveredPaths }
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
export async function startReconciliation(
  workItemId: string,
  submissionId: string,
  actorId: string,
  mode: ReconciliationMode = 'DETERMINISTIC',
  opts: { requireChangeManifest?: boolean } = {},
) {
  const workItem = await loadWorkItem(workItemId)

  const submission = await prisma.implementationSubmission.findUnique({ where: { id: submissionId } })
  if (!submission || submission.workItemId !== workItemId) throw new NotFoundError('ImplementationSubmission', submissionId)
  if (String(submission.status).toUpperCase() === 'REJECTED') {
    throw new ConflictError('Rejected implementation submissions cannot be reconciled')
  }

  const scopedPath = Boolean(submission.specificationBindingId || submission.developmentScopeId || submission.handoffGenerationId)
  if (scopedPath && (!submission.specificationBindingId || !submission.developmentScopeId || !submission.handoffGenerationId)) {
    throw new ConflictError('Scope-bound submissions must include a binding, DevelopmentScope, and handoff generation')
  }

  const target = scopedPath ? null : await prisma.developmentTarget.findUnique({ where: { workItemId } })
  if (!scopedPath && !target) throw new NotFoundError('DevelopmentTarget', workItemId)
  if (target && target.status !== 'PUBLISHED') {
    throw new ConflictError('The developer handoff is not published; cannot reconcile against it.')
  }

  const spec = await prisma.specificationVersion.findUnique({ where: { id: submission.specificationVersionId } })
  if (!spec) throw new NotFoundError('SpecificationVersion', submission.specificationVersionId)
  if (!scopedPath && spec.workItemId !== workItemId) throw new ConflictError('Submission specification version is not bound to this WorkItem')

  const binding = submission.specificationBindingId
    ? await prisma.workItemSpecificationBinding.findFirst({ where: { id: submission.specificationBindingId, workItemId, specificationVersionId: spec.id, status: 'CURRENT' } })
    : await prisma.workItemSpecificationBinding.findFirst({ where: { workItemId, specificationVersionId: spec.id, status: 'CURRENT' }, orderBy: { bindingGeneration: 'desc' } })
  const scope = submission.developmentScopeId
    ? await prisma.developmentScope.findFirst({ where: { id: submission.developmentScopeId, workItemId, status: { not: 'CANCELLED' } } })
    : target
      ? await prisma.developmentScope.findFirst({ where: { workItemId, repository: target.repository, status: { not: 'CANCELLED' } }, orderBy: { updatedAt: 'desc' } })
      : null
  if (submission.specificationBindingId && !binding) throw new ConflictError('Submission references a stale or non-current specification binding')
  if (submission.developmentScopeId && !scope) throw new ConflictError('Submission references a stale or cancelled DevelopmentScope')
  if (scopedPath && scope?.specificationBindingId !== binding?.id) throw new ConflictError('Submission scope and specification binding do not match')
  if (scopedPath && binding?.specificationVersionId !== spec.id) throw new ConflictError('Submission specification version does not match the current scope binding')
  const handoff = submission.handoffGenerationId
    ? await prisma.handoffGeneration.findFirst({ where: { id: submission.handoffGenerationId, developmentScopeId: scope?.id, status: 'PUBLISHED' } })
    : scope?.currentHandoffGenerationId
      ? await prisma.handoffGeneration.findFirst({ where: { id: scope.currentHandoffGenerationId, status: 'PUBLISHED' } })
      : null
  if (submission.handoffGenerationId && !handoff) throw new ConflictError('Submission references a stale or unpublished handoff generation')
  if (scopedPath && scope?.currentHandoffGenerationId !== handoff?.id) throw new ConflictError('Submission references a stale handoff generation')

  const packageSource = binding?.resolvedPackage ?? spec.package ?? {}
  const parsed = specificationPackageBodySchema.safeParse(packageSource)
  if (!parsed.success) throw new ValidationError('Stored specification package is malformed; create a new valid specification version before reconciling')
  const body = parsed.data

  const scopeRequirementIds = scopedPath
    ? (Array.isArray(handoff?.requirementIds) ? handoff!.requirementIds.filter((id): id is string => typeof id === 'string') : [])
    : ((target!.requirementIds as string[] | null) ?? [])
  const requiredEvidenceSource = scopedPath ? handoff?.requiredEvidence : target?.requiredEvidence
  const forbiddenPathsSource = scopedPath ? handoff?.forbiddenPaths : target?.forbiddenPaths
  const reconciliationPolicySource = scopedPath ? handoff?.reconciliationPolicy : target?.reconciliationPolicy
  const repository = scopedPath ? handoff!.repository : target!.repository
  const claims = asClaims(submission.claims)
  const changedFiles = changedFilesOf(submission.manifest, claims)

  // Evaluate the requirements' declared obligations (spec §15, mechanical layer). Requirements that
  // declare none produce no results, so this is a no-op for every specification authored so far.
  const inObligationScope = (id: string) => scopeRequirementIds.length === 0 || scopeRequirementIds.includes(id)
  const obligationResults = evaluateObligations(
    body.requirements.filter((r) => inObligationScope(r.id)).map((r) => ({ id: r.id, obligations: r.obligations })),
    { contracts: body.contracts, changedFiles, symbolFacts: symbolFactsOf(submission.manifest) },
  )

  const input: ReconciliationInput = {
    requirements: body.requirements.map((r) => ({ id: r.id, priority: r.priority, testObligationIds: r.testObligationIds })),
    scopeRequirementIds,
    requiredEvidence: Array.isArray(requiredEvidenceSource)
      ? (requiredEvidenceSource as unknown[]).map((e) => {
          const o = (e && typeof e === 'object' ? e : {}) as Record<string, unknown>
          return { requirementId: String(o.requirementId ?? ''), kind: String(o.kind ?? '') }
        })
      : [],
    diffValidation: toDiffValidation(reconciliationPolicySource ?? {}, forbiddenPathsSource ?? []),
    claims,
    deviations: asDeviations(submission.deviations),
    changedFiles,
    ...(obligationResults.length ? { obligationResults } : {}),
    // Set only by automated callers (the copilot results post-back). A person filing a
    // submission by hand is asserting the change exists; a git event is not.
    requireChangeManifest: opts.requireChangeManifest === true,
  }

  const result = reconcile(input)
  const findings = [...result.findings]
  const supersededFinding = supersededSpecificationFinding(spec.status, spec.version)
  if (supersededFinding) findings.push(supersededFinding)

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

  // Semantic mode overlays an LLM per-requirement judgment on the deterministic verdicts. Synchronous
  // (a governed turn, no customer code) and BEST-EFFORT — a failed/empty pass keeps the deterministic
  // result, so semantic never fails the reconciliation.
  let finalVerdicts: SemanticVerdict[] = result.verdicts
  let finalStatus: string = result.status
  let finalSummary: Record<string, unknown> = result.summary
  if (mode === 'SEMANTIC') {
    const inScope = (id: string) => input.scopeRequirementIds.length === 0 || input.scopeRequirementIds.includes(id)
    const semanticRequirements = body.requirements.filter((r) => inScope(r.id)).map((r) => ({
      id: r.id,
      priority: r.priority,
      statement: (r as any).statement ?? '',
      acceptanceCriteria: (body.acceptanceCriteria as any[])
        .filter((a) => (a.requirementIds ?? []).includes(r.id) || ((r as any).acceptanceCriterionIds ?? []).includes(a.id))
        .map((a) => a.statement ?? a.text ?? a.description ?? a.id)
        .filter(Boolean),
    }))
    const overlay = await runSemanticPass({
      workItemId,
      actorId,
      requirements: semanticRequirements,
      claims: claims.map((c) => ({ requirementId: c.requirementId, status: c.status, evidence: c.evidence })),
      verdicts: result.verdicts,
    })
    if (overlay) {
      finalVerdicts = overlay.verdicts
      finalStatus = overlay.status
      finalSummary = overlay.summary
    }
  }

  const runId = randomUUID()
  const traceId = `recon-${runId}`
  const tenantId = workItem.tenantId ?? currentTenantIdForDb() ?? undefined
  const now = new Date()
  // `finalStatus` (the engine/semantic verdict) otherwise does not reach the run row: the
  // deterministic path records only that it ran, and the dynamic path overwrites the status when
  // the runner reports. The one case that must not be flattened into "declared consistent" is an
  // unproven run — there were no declared facts to be consistent with. Everything else keeps its
  // existing status so this stays a fail-safe rather than a re-modelling of the deterministic path.
  const runStatus = willRunDynamic
    ? 'RUNNING'
    : finalStatus === 'NOT_VERIFIED'
      ? 'NOT_VERIFIED'
      : mode === 'SEMANTIC'
        ? 'SEMANTICALLY_REVIEWED'
        : 'DECLARED_CONSISTENT'
  const runMode = willRunDynamic ? 'DYNAMIC' : mode

  const run = await withTenantDbTransaction(prisma, async (tx) => {
    const created = await tx.reconciliationRun.create({
      data: {
        id: runId,
        workItemId,
        submissionId,
        specificationVersionId: submission.specificationVersionId,
        specificationBindingId: binding?.id ?? null,
        developmentScopeId: scope?.id ?? null,
        handoffGenerationId: handoff?.id ?? null,
        specificationHash: spec.contentHash,
        mode: runMode,
        status: runStatus as any,
        reconciliationState: willRunDynamic ? 'VERIFYING' : 'NOT_VERIFIED',
        summary: finalSummary as unknown as Prisma.InputJsonValue,
        traceId,
        startedById: actorId,
        completedAt: willRunDynamic ? null : now,
        tenantId: workItem.tenantId,
      },
    })
    if (finalVerdicts.length) {
      await tx.requirementVerdict.createMany({
        data: finalVerdicts.map((v) => ({
          reconciliationRunId: runId,
          requirementId: v.requirementId,
          priority: v.priority,
          verdict: v.verdict as any,
          claimStatus: v.claimStatus,
          rationale: v.rationale,
          evidence: v.evidence as unknown as Prisma.InputJsonValue,
        })),
      })
    }
    if (findings.length) {
      await tx.reconciliationFinding.createMany({
        data: findings.map((f) => ({
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
        repository,
          baseCommitSha: submission.baseCommitSha,
          headCommitSha: submission.headCommitSha,
          testPlan: testPlan as unknown as Prisma.InputJsonValue,
          generation: handoff?.generation ?? 1,
          tenantId: workItem.tenantId,
        },
      })
    }
    return created
  }, tenantId)

  // Timeline: always STARTED. COMPLETED only when we finalized now (deterministic path); the
  // dynamic path emits COMPLETED later when the runner job finishes (see completeReconciliationJob).
  const startedPayload = { reconciliationRunId: runId, submissionId, specificationVersionId: submission.specificationVersionId, mode: runMode, traceId, dynamic: willRunDynamic }
  let evidenceTransition: EvidenceTransition | null = null
  await withTenantDbTransaction(prisma, async (tx) => {
    await tx.workItemEvent.create({ data: { workItemId, eventType: 'RECONCILIATION_STARTED', actorId, payload: startedPayload as Prisma.InputJsonValue, tenantId: workItem.tenantId } })
    if (!willRunDynamic) {
      const completedPayload = { reconciliationRunId: runId, submissionId, status: runStatus, summary: finalSummary, traceId, authoritativeCompletion: false }
      await tx.workItemEvent.create({ data: { workItemId, eventType: 'RECONCILIATION_COMPLETED', actorId, payload: completedPayload as Prisma.InputJsonValue, tenantId: workItem.tenantId } })
      evidenceTransition = await applyReconciliationCompletionGate(tx, {
        workItemId,
        currentStatus: workItem.status,
        runStatus,
        reconciliationRunId: runId,
        submissionId,
        actorId,
        tenantId: workItem.tenantId,
      })
    }
  }, tenantId)
  if (!willRunDynamic) {
    const completedPayload = { reconciliationRunId: runId, submissionId, status: runStatus, summary: finalSummary, traceId, authoritativeCompletion: false }
    await logEvent('ReconciliationCompleted', 'WorkItem', workItemId, actorId, completedPayload)
    await publishOutbox('WorkItem', workItemId, 'ReconciliationCompleted', completedPayload)
    await emitEvidenceTransitionAudit(workItemId, actorId, evidenceTransition)
  }

  return { run, verdicts: finalVerdicts, findings, summary: finalSummary, dynamic: willRunDynamic, semantic: mode === 'SEMANTIC' }
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

export function expiredReconciliationJobDisposition(attempts: number, maxAttempts: number): 'PENDING' | 'DEAD_LETTERED' {
  return attempts >= maxAttempts ? 'DEAD_LETTERED' : 'PENDING'
}

/** Recover runner leases after a crashed or disconnected worker. Discovery is cross-tenant;
 * every write is fenced by the expired lease and performed in that job's tenant context. */
export async function reapExpiredReconciliationJobs(now = new Date(), limit = 100) {
  const sweepReader = adminPrisma ?? prisma
  const expired = await sweepReader.reconciliationJob.findMany({
    where: { status: { in: ['CLAIMED', 'RUNNING'] }, leaseUntil: { lt: now } },
    select: { id: true, reconciliationRunId: true, workItemId: true, attempts: true, maxAttempts: true, tenantId: true },
    orderBy: { leaseUntil: 'asc' },
    take: Math.min(Math.max(limit, 1), 500),
  })
  let requeued = 0
  let deadLettered = 0
  for (const job of expired) {
    const disposition = expiredReconciliationJobDisposition(job.attempts, job.maxAttempts)
    const updated = await withTenantDbTransaction(prisma, async (tx) => {
      const result = await tx.reconciliationJob.updateMany({
        where: { id: job.id, status: { in: ['CLAIMED', 'RUNNING'] }, leaseUntil: { lt: now } },
        data: {
          status: disposition,
          claimToken: null,
          claimedBy: null,
          claimedAt: null,
          leaseUntil: null,
          heartbeatAt: null,
          error: disposition === 'PENDING' ? 'Runner lease expired; job returned to the queue.' : 'Runner lease expired after the maximum number of attempts.',
          deadLetterReason: disposition === 'DEAD_LETTERED' ? 'Maximum attempts exhausted after runner lease expiry.' : null,
        },
      })
      if (result.count === 1 && disposition === 'DEAD_LETTERED') {
        await tx.reconciliationRun.updateMany({
          where: { id: job.reconciliationRunId, reconciliationState: { not: 'STALE' } },
          data: { status: 'ERROR', reconciliationState: 'NOT_VERIFIED', completedAt: now },
        })
        await tx.workItem.updateMany({
          where: { id: job.workItemId, reconciliationState: { not: 'STALE' } },
          data: { reconciliationState: 'NOT_VERIFIED' },
        })
      }
      return result.count
    }, job.tenantId ?? undefined)
    if (updated !== 1) continue
    if (disposition === 'PENDING') requeued += 1
    else deadLettered += 1
  }
  return { inspected: expired.length, requeued, deadLettered }
}

export async function claimReconciliationJob(jobId: string, runnerId: string) {
  const job = await prisma.reconciliationJob.findUnique({ where: { id: jobId } })
  if (!job) throw new NotFoundError('ReconciliationJob', jobId)
  const tenantId = job.tenantId ?? undefined
  const runContext = await prisma.reconciliationRun.findUnique({ where: { id: job.reconciliationRunId }, select: { generation: true, status: true, reconciliationState: true } })
  const workItemContext = await prisma.workItem.findUnique({ where: { id: job.workItemId }, select: { status: true } })
  if (!runContext || !workItemContext) throw new NotFoundError('ReconciliationRun', job.reconciliationRunId)
  if (runContext.generation !== job.generation) throw new ConflictError('Reconciliation runner result belongs to a stale reconciliation generation')
  if (runContext.reconciliationState === 'STALE') throw new ConflictError('Reconciliation run was invalidated by a newer implementation submission')
  if (['CANCELLED', 'ARCHIVED'].includes(String(workItemContext.status))) throw new ConflictError('Cancelled WorkItems reject late reconciliation results')
  if (!['RUNNING', 'PENDING'].includes(String(runContext.status))) throw new ConflictError(`Reconciliation run is ${runContext.status} and cannot accept results`)
  if (job.attempts >= job.maxAttempts) {
    await prisma.reconciliationJob.updateMany({ where: { id: jobId, status: 'PENDING' }, data: { status: 'DEAD_LETTERED', deadLetterReason: 'Maximum runner attempts exceeded' } })
    throw new ConflictError('Reconciliation job exceeded its retry limit and was dead-lettered')
  }
  const claimToken = randomUUID()
  const claimed = await withTenantDbTransaction(prisma, (tx) => tx.reconciliationJob.updateMany({
    where: { id: jobId, status: 'PENDING' },
    data: { status: 'CLAIMED', claimToken, claimedBy: runnerId, claimedAt: new Date(), leaseUntil: new Date(Date.now() + 10 * 60 * 1000), heartbeatAt: new Date(), attempts: { increment: 1 } },
  }), tenantId)
  if (claimed.count !== 1) throw new ConflictError('Reconciliation job is already claimed or no longer pending.')
  return prisma.reconciliationJob.findUnique({ where: { id: jobId } }) // includes the fresh claimToken
}

export async function completeReconciliationJob(jobId: string, claimToken: string, tests: TestResult[], actorId: string) {
  const job = await prisma.reconciliationJob.findUnique({ where: { id: jobId } })
  if (!job) throw new NotFoundError('ReconciliationJob', jobId)
  const tenantId = job.tenantId ?? undefined
  const runContext = await prisma.reconciliationRun.findUnique({ where: { id: job.reconciliationRunId }, select: { generation: true, status: true, reconciliationState: true } })
  const workItemContext = await prisma.workItem.findUnique({ where: { id: job.workItemId }, select: { status: true } })
  if (!runContext || !workItemContext) throw new NotFoundError('ReconciliationRun', job.reconciliationRunId)
  if (runContext.generation !== job.generation) throw new ConflictError('Reconciliation runner result belongs to a stale reconciliation generation')
  if (runContext.reconciliationState === 'STALE') throw new ConflictError('Reconciliation run was invalidated by a newer implementation submission')
  if (['CANCELLED', 'ARCHIVED'].includes(String(workItemContext.status))) throw new ConflictError('Cancelled WorkItems reject late reconciliation results')
  if (!['RUNNING', 'PENDING'].includes(String(runContext.status))) throw new ConflictError(`Reconciliation run is ${runContext.status} and cannot accept results`)

  const plan = Array.isArray(job.testPlan) ? job.testPlan as Array<{ obligationId?: string }> : []
  const expected = new Set(plan.map((entry) => entry.obligationId).filter((id): id is string => Boolean(id)))
  const seen = new Set<string>()
  for (const result of tests) {
    const obligationId = result.obligationId ?? result.name
    if (!obligationId || !expected.has(obligationId)) {
      throw new ValidationError(`Dynamic reconciliation returned an unknown test obligation: ${obligationId ?? '<missing>'}`)
    }
    if (seen.has(obligationId)) throw new ValidationError(`Dynamic reconciliation returned duplicate results for test obligation ${obligationId}`)
    if (!['PASS', 'FAIL', 'SKIPPED'].includes(result.status)) {
      throw new ValidationError(`Dynamic reconciliation returned unsupported status ${result.status} for ${obligationId}`)
    }
    seen.add(obligationId)
  }
  const completePlan = expected.size > 0 && seen.size === expected.size

  // Fold the executed test outcomes over the deterministic verdicts → verified matrix.
  const existing = await prisma.requirementVerdict.findMany({ where: { reconciliationRunId: job.reconciliationRunId } })
  const current: CurrentVerdict[] = existing.map((v) => ({ requirementId: v.requirementId, priority: v.priority, verdict: v.verdict, rationale: v.rationale }))
  const refined = applyTestResults(current, tests)
  const outcome = dynamicCompletionOutcome(expected.size, tests, refined.status)
  const { allPassed, allSkipped } = outcome
  const dynamicStatus = outcome.status
  const byReq = new Map(refined.verdicts.map((v) => [v.requirementId, v]))
  const now = new Date()

  const run = await withTenantDbTransaction(prisma, async (tx) => {
    const done = await tx.reconciliationJob.updateMany({
      where: { id: jobId, claimToken, status: { in: ['CLAIMED', 'RUNNING'] } },
      data: { status: 'COMPLETED', result: { tests } as unknown as Prisma.InputJsonValue, leaseUntil: null, heartbeatAt: now },
    })
    if (done.count !== 1) throw new ConflictError('Reconciliation job is not claimed with this token, or is already resolved.')
    const transitioned = await tx.reconciliationRun.updateMany({
      where: {
        id: job.reconciliationRunId,
        status: { in: ['RUNNING', 'PENDING'] },
        reconciliationState: { not: 'STALE' },
      },
      data: {
        status: dynamicStatus as any,
        reconciliationState: outcome.reconciliationState,
        summary: { ...refined.summary, completePlan, allPassed, allSkipped } as unknown as Prisma.InputJsonValue,
        completedAt: now,
      },
    })
    if (transitioned.count !== 1) throw new ConflictError('Reconciliation run was invalidated or resolved before the runner result arrived.')
    for (const v of existing) {
      const r = byReq.get(v.requirementId)
      if (!r) continue
      await tx.requirementVerdict.update({ where: { id: v.id }, data: { verdict: r.verdict as any, rationale: r.rationale, verified: r.verified } })
    }
    return tx.reconciliationRun.findUniqueOrThrow({ where: { id: job.reconciliationRunId } })
  }, tenantId)

  const payload = { reconciliationRunId: job.reconciliationRunId, submissionId: job.submissionId, status: dynamicStatus, summary: { ...refined.summary, completePlan, allPassed, allSkipped }, traceId: run.traceId, dynamic: true, authoritativeCompletion: false }
  let evidenceTransition: EvidenceTransition | null = null
  await withTenantDbTransaction(prisma, async (tx) => {
    await tx.workItemEvent.create({ data: { workItemId: job.workItemId, eventType: 'RECONCILIATION_COMPLETED', actorId, payload: payload as Prisma.InputJsonValue, tenantId: job.tenantId } })
    const wi = await tx.workItem.findUnique({ where: { id: job.workItemId }, select: { status: true } })
    if (wi) {
      evidenceTransition = await applyReconciliationCompletionGate(tx, {
        workItemId: job.workItemId,
        currentStatus: wi.status,
        runStatus: dynamicStatus,
        reconciliationRunId: job.reconciliationRunId,
        submissionId: job.submissionId,
        actorId,
        tenantId: job.tenantId,
      })
    }
  }, tenantId)
  await logEvent('ReconciliationCompleted', 'WorkItem', job.workItemId, actorId, payload)
  await publishOutbox('WorkItem', job.workItemId, 'ReconciliationCompleted', payload)
  await emitEvidenceTransitionAudit(job.workItemId, actorId, evidenceTransition)
  const claimEvidence = await foldReconciliationIntoClaims(run.id, actorId)

  return { run, verdicts: refined.verdicts, summary: refined.summary, claimEvidence }
}

export async function failReconciliationJob(jobId: string, claimToken: string, error: string, actorId: string) {
  const job = await prisma.reconciliationJob.findUnique({ where: { id: jobId } })
  if (!job) throw new NotFoundError('ReconciliationJob', jobId)
  const tenantId = job.tenantId ?? undefined
  const runContext = await prisma.reconciliationRun.findUnique({
    where: { id: job.reconciliationRunId },
    select: { reconciliationState: true },
  })
  if (!runContext) throw new NotFoundError('ReconciliationRun', job.reconciliationRunId)
  if (runContext.reconciliationState === 'STALE') throw new ConflictError('Reconciliation run was invalidated by a newer implementation submission')

  const now = new Date()
  const run = await withTenantDbTransaction(prisma, async (tx) => {
    const done = await tx.reconciliationJob.updateMany({
      where: { id: jobId, claimToken, status: { in: ['CLAIMED', 'RUNNING'] } },
      data: { status: 'FAILED', error, leaseUntil: null, heartbeatAt: now },
    })
    if (done.count !== 1) throw new ConflictError('Reconciliation job is not claimed with this token, or is already resolved.')
    const transitioned = await tx.reconciliationRun.updateMany({
      where: { id: job.reconciliationRunId, reconciliationState: { not: 'STALE' } },
      data: { status: 'ERROR', reconciliationState: 'NOT_VERIFIED', completedAt: now },
    })
    if (transitioned.count !== 1) throw new ConflictError('Reconciliation run was invalidated before the runner failure arrived.')
    await tx.reconciliationFinding.create({ data: { reconciliationRunId: job.reconciliationRunId, kind: 'runner-error', severity: 'ERROR', message: `Dynamic reconciliation runner failed: ${error}` } })
    return tx.reconciliationRun.findUniqueOrThrow({ where: { id: job.reconciliationRunId } })
  }, tenantId)

  const payload = { reconciliationRunId: job.reconciliationRunId, submissionId: job.submissionId, status: 'ERROR', error, traceId: run.traceId, dynamic: true, authoritativeCompletion: false }
  let evidenceTransition: EvidenceTransition | null = null
  await withTenantDbTransaction(prisma, async (tx) => {
    await tx.workItemEvent.create({ data: { workItemId: job.workItemId, eventType: 'RECONCILIATION_COMPLETED', actorId, payload: payload as Prisma.InputJsonValue, tenantId: job.tenantId } })
    const wi = await tx.workItem.findUnique({ where: { id: job.workItemId }, select: { status: true } })
    if (wi) {
      evidenceTransition = await applyReconciliationCompletionGate(tx, {
        workItemId: job.workItemId,
        currentStatus: wi.status,
        runStatus: 'ERROR',
        reconciliationRunId: job.reconciliationRunId,
        submissionId: job.submissionId,
        actorId,
        tenantId: job.tenantId,
      })
    }
  }, tenantId)
  await logEvent('ReconciliationFailed', 'WorkItem', job.workItemId, actorId, payload)
  await publishOutbox('WorkItem', job.workItemId, 'ReconciliationFailed', payload)
  await emitEvidenceTransitionAudit(job.workItemId, actorId, evidenceTransition)

  return { run }
}
