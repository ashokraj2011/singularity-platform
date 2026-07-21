/**
 * RECONCILE node — the real requirement-by-requirement spec reconciliation, as ONE
 * action inside the workflow.
 *
 * Before this node the graph could only GATE on a reconciliation: a human left the run,
 * opened ReconciliationStudio, started one by hand, came back and approved. The
 * measurement itself (`startReconciliation` — verdict matrix vs. the frozen
 * SpecificationVersion) had no node type. This node is a THIN executor over that exact
 * service; it re-implements none of the engine, the obligations layer, the semantic
 * overlay or the completion gate.
 *
 * ── Why calling the service from here is safe ────────────────────────────────
 * `startReconciliation(workItemId, submissionId, actorId, mode, opts)` takes no `req`.
 * The routers do authorization separately (`loadAuthorizedWorkItem`) and then call it
 * with `req.user!.userId`. A non-request caller already exists and is the precedent
 * this node follows: `reconcileCopilotResults` (runtime/copilot-results-reconcile.ts)
 * calls it with an explicit actorId when a developer posts results back.
 *
 * ── The verdict mapping is the load-bearing part ─────────────────────────────
 * `applyReconciliationCompletionGate` moves WorkItem.reconciliationState, and it reaches
 * VERIFIED **only** on VERIFIED_PASS. So this node must not flatten "we measured nothing"
 * into "it passed". Three outcomes, three different words, three different audit events:
 *
 *   ADVANCE  VERIFIED_PASS / PASSED          → VERIFIED   — a complete test plan actually passed.
 *   ADVANCE  DECLARED_CONSISTENT             → DECLARED   — the developer's declared claims are
 *            SEMANTICALLY_REVIEWED                          consistent with the spec. A real but
 *                                                           WEAKER result: nothing was executed.
 *                                                           Suppress with requireVerifiedPass:true.
 *   HALT     NOT_VERIFIED / PENDING          → NOT_VERIFIED — the run measured NOTHING. Not a pass
 *                                                           and NOT a failure. unproven:true.
 *   HALT     FAILED / PARTIAL / ERROR /      → FAILED     — the change WAS measured and found
 *            CANCELLED                                      wanting. unproven:false.
 *   HALT     RUNNING                         → AWAITING_TESTS — DYNAMIC mode queued a test job;
 *                                                           no verdict exists yet.
 *   HALT     (no work item / no submission / → HALTED     — a legible stop, never a crash.
 *            no actor / service threw)
 *
 * NOT_VERIFIED and FAILED both stop the run, but they must never read the same. They carry
 * a different `status`, a different `unproven` flag, different prose, a different
 * WorkflowMutation type (RECONCILE_NOT_VERIFIED vs RECONCILE_FAILED) and a different audit
 * event (ReconcileNotVerified vs ReconcileFailed).
 *
 * ── Defaults ─────────────────────────────────────────────────────────────────
 * `requireChangeManifest` defaults to TRUE here, unlike the hand-filed router path. A node
 * firing automatically asserts nothing; an empty diff means the developer proved nothing
 * and must not report clean. This is the same reasoning as the copilot post-back.
 *
 * Blocks the way VERIFIER and GOVERNANCE_GATE block: node BLOCKED + instance PAUSED with the
 * reason in context._blockedByReconcile, which is recoverable (restart the node) rather than
 * a hard failure.
 */
import { Prisma, type WorkflowInstance, type WorkflowNode } from '@prisma/client'
import { prisma } from '../../../../lib/prisma'
import { withTenantDbTransaction } from '../../../../lib/tenant-db-context'
import { logEvent, publishOutbox } from '../../../../lib/audit'
import { startReconciliation, type ReconciliationMode } from '../../../reconciliations/reconciliations.service'

/** PASSED/DECLARED advance the node. Everything else halts it. */
export type ReconcileNodeStatus =
  | 'VERIFIED'
  | 'DECLARED'
  | 'NOT_VERIFIED'
  | 'FAILED'
  | 'AWAITING_TESTS'
  | 'HALTED'

export type ReconcileOutput = {
  reconcile: {
    status: ReconcileNodeStatus
    /** Prose an operator can act on. Always set — this is what makes a halt legible. */
    outcome: string
    /** TRUE only when nothing was measured. Never true for FAILED. */
    unproven: boolean
    /** The raw ReconciliationStatus from the run row, when a run was created. */
    runStatus?: string
    reconciliationRunId?: string
    workItemId?: string
    workCode?: string
    submissionId?: string
    mode?: string
    verdictCount?: number
    findingCount?: number
    summary?: Record<string, unknown>
  }
}

type JsonObject = Record<string, unknown>
const isRecord = (v: unknown): v is JsonObject => Boolean(v && typeof v === 'object' && !Array.isArray(v))
const asObject = (v: unknown): JsonObject => (isRecord(v) ? v : {})
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

function cfgValue(node: WorkflowNode, key: string): unknown {
  const cfg = asObject(node.config)
  const standard = asObject(cfg.standard)
  return cfg[key] ?? standard[key]
}
function cfgString(node: WorkflowNode, key: string): string | undefined {
  return str(cfgValue(node, key))
}
function cfgBool(node: WorkflowNode, key: string, fallback: boolean): boolean {
  const v = cfgValue(node, key)
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') return v === 'true'
  return fallback
}

/**
 * Which ReconciliationStatus values mean what. Exported and PURE so the mapping — the part
 * that decides whether an unproven run advances a workflow — is testable on its own.
 */
export function reconcileOutcomeFor(
  runStatus: string,
  opts: { requireVerifiedPass?: boolean } = {},
): { status: ReconcileNodeStatus; advance: boolean; unproven: boolean; outcome: string } {
  switch (String(runStatus).toUpperCase()) {
    case 'VERIFIED_PASS':
    case 'PASSED':
      return {
        status: 'VERIFIED',
        advance: true,
        unproven: false,
        outcome: 'Every in-scope requirement was verified against the frozen specification by a complete, fully passing test plan.',
      }

    // A real measurement, but a weaker one: the developer's DECLARED claims line up with the
    // specification and the handoff policy. Nothing was executed, so this is not VERIFIED and
    // WorkItem.reconciliationState stays NOT_VERIFIED. requireVerifiedPass:true refuses it.
    case 'DECLARED_CONSISTENT':
      return opts.requireVerifiedPass
        ? {
            status: 'NOT_VERIFIED',
            advance: false,
            unproven: true,
            outcome: 'The declared claims are consistent with the specification, but this node requires an executed, fully passing test plan (requireVerifiedPass), and none was run. Re-run in DYNAMIC mode to actually execute the declared test obligations.',
          }
        : {
            status: 'DECLARED',
            advance: true,
            unproven: false,
            outcome: 'The implementation\'s declared claims are consistent with the frozen specification and the handoff policy. NOTE: nothing was executed — this is a declaration check, not an independently verified pass, and the Work Item does NOT become VERIFIED.',
          }
    case 'SEMANTICALLY_REVIEWED':
      return opts.requireVerifiedPass
        ? {
            status: 'NOT_VERIFIED',
            advance: false,
            unproven: true,
            outcome: 'A semantic review completed, but this node requires an executed, fully passing test plan (requireVerifiedPass), and none was run. Re-run in DYNAMIC mode to actually execute the declared test obligations.',
          }
        : {
            status: 'DECLARED',
            advance: true,
            unproven: false,
            outcome: 'A semantic (LLM) review of each requirement completed alongside the deterministic check. NOTE: nothing was executed — this is a judgement, not an independently verified pass, and the Work Item does NOT become VERIFIED.',
          }

    // The run completed but assessed nothing — no change manifest, or no claims to measure.
    // NOT a pass and NOT a failure. This is the case that must never advance quietly.
    case 'NOT_VERIFIED':
      return {
        status: 'NOT_VERIFIED',
        advance: false,
        unproven: true,
        outcome: 'The reconciliation ran but MEASURED NOTHING — the submission declared no per-requirement claims, or reported no changed files. This is not a failure: nothing was found wrong, because nothing was checked. Register a submission that declares claims (or post results with a non-empty diff), then restart this node.',
      }
    case 'PENDING':
      return {
        status: 'NOT_VERIFIED',
        advance: false,
        unproven: true,
        outcome: 'The reconciliation run was created but never left PENDING, so no requirement was measured. This is not a failure. Restart this node to re-run it.',
      }

    // Measured, and found wanting. The opposite of unproven.
    case 'FAILED':
      return {
        status: 'FAILED',
        advance: false,
        unproven: false,
        outcome: 'The implementation WAS measured against the frozen specification and did not satisfy it. Open the Work Item → Reconciliation for the per-requirement verdict matrix and the findings.',
      }
    case 'PARTIAL':
      return {
        status: 'FAILED',
        advance: false,
        unproven: false,
        outcome: 'The implementation WAS measured and satisfied only part of the specification — some in-scope requirements did not pass. Open the Work Item → Reconciliation for the per-requirement verdict matrix.',
      }
    case 'ERROR':
      return {
        status: 'FAILED',
        advance: false,
        unproven: false,
        outcome: 'The reconciliation run ended in ERROR, so no trustworthy verdict exists. Open the Work Item → Reconciliation for the findings, then restart this node.',
      }
    case 'CANCELLED':
      return {
        status: 'FAILED',
        advance: false,
        unproven: false,
        outcome: 'The reconciliation run was cancelled before it produced a verdict. Restart this node to run it again.',
      }

    // DYNAMIC mode enqueued an out-of-process test job; the verdict does not exist yet.
    case 'RUNNING':
      return {
        status: 'AWAITING_TESTS',
        advance: false,
        unproven: true,
        outcome: 'DYNAMIC mode queued the declared test obligations as a runner job; no verdict exists yet. Wait for the runner to report, then restart this node to read the refined result.',
      }

    default:
      return {
        status: 'HALTED',
        advance: false,
        unproven: true,
        outcome: `The reconciliation returned an unrecognised status (${runStatus}), so this node cannot tell a pass from a failure and will not advance the run.`,
      }
  }
}

async function halt(
  instance: WorkflowInstance,
  node: WorkflowNode,
  output: ReconcileOutput,
  actorId?: string,
): Promise<void> {
  const tenantId = instance.tenantId ?? undefined
  // Distinct mutation type + audit event per outcome, so "measured nothing" and "measured and
  // failed" are never a single line an operator learns to skim past.
  const mutationType =
    output.reconcile.status === 'NOT_VERIFIED'
      ? 'RECONCILE_NOT_VERIFIED'
      : output.reconcile.status === 'FAILED'
        ? 'RECONCILE_FAILED'
        : output.reconcile.status === 'AWAITING_TESTS'
          ? 'RECONCILE_AWAITING_TESTS'
          : 'RECONCILE_HALTED'
  const eventType =
    output.reconcile.status === 'NOT_VERIFIED'
      ? 'ReconcileNotVerified'
      : output.reconcile.status === 'FAILED'
        ? 'ReconcileFailed'
        : output.reconcile.status === 'AWAITING_TESTS'
          ? 'ReconcileAwaitingTests'
          : 'ReconcileHalted'

  await withTenantDbTransaction(prisma, (tx) => Promise.all([
    tx.workflowNode.update({ where: { id: node.id }, data: { status: 'BLOCKED', completedAt: new Date() } }),
    tx.workflowInstance.update({
      where: { id: instance.id },
      data: {
        status: 'PAUSED',
        context: {
          ...asObject(instance.context),
          _blockedByReconcile: output.reconcile,
        } as Prisma.InputJsonValue,
      },
    }),
    tx.workflowMutation.create({
      data: {
        instanceId: instance.id,
        nodeId: node.id,
        mutationType,
        beforeState: { status: node.status } as Prisma.InputJsonValue,
        afterState: output as unknown as Prisma.InputJsonValue,
        performedById: actorId,
      },
    }),
  ]), tenantId)
  await logEvent(eventType, 'WorkflowNode', node.id, actorId, { instanceId: instance.id, output })
  await publishOutbox('WorkflowNode', node.id, eventType, { instanceId: instance.id, nodeId: node.id, output })
}

/** Resolve the Work Item this run is about, the same way CREATE_BRANCH / RAISE_PR do. */
async function resolveWorkItem(
  node: WorkflowNode,
  instance: WorkflowInstance,
): Promise<{ id: string; workCode: string } | null> {
  const context = asObject(instance.context)
  const vars = asObject(context._vars)
  const ctxWorkItem = asObject(context._workItem)
  const tenantId = instance.tenantId ?? undefined

  const explicitId = cfgString(node, 'workItemId') ?? str(ctxWorkItem.id) ?? str(vars.workItemId)
  if (explicitId) {
    const byId = await withTenantDbTransaction(
      prisma,
      (tx) => tx.workItem.findUnique({ where: { id: explicitId }, select: { id: true, workCode: true } }),
      tenantId,
    )
    if (byId) return byId
  }
  const workCode = str(ctxWorkItem.workCode) ?? str(vars.workCode) ?? str(vars.workItemCode)
  if (!workCode) return null
  return withTenantDbTransaction(
    prisma,
    (tx) => tx.workItem.findUnique({ where: { workCode }, select: { id: true, workCode: true } }),
    tenantId,
  )
}

/**
 * Which submission to measure. An explicit id wins; otherwise the most recent submission that
 * is not REJECTED — a rejected one cannot be reconciled (startReconciliation throws on it), so
 * picking it would turn a legible "nothing to reconcile yet" into a thrown ConflictError.
 */
async function resolveSubmission(
  node: WorkflowNode,
  instance: WorkflowInstance,
  workItemId: string,
): Promise<{ id: string; status: string; headCommitSha: string } | null> {
  const context = asObject(instance.context)
  const tenantId = instance.tenantId ?? undefined
  const explicit = cfgString(node, 'submissionId') ?? str(context.submissionId)
  if (explicit) {
    const found = await withTenantDbTransaction(
      prisma,
      (tx) => tx.implementationSubmission.findUnique({
        where: { id: explicit },
        select: { id: true, status: true, headCommitSha: true, workItemId: true },
      }),
      tenantId,
    )
    if (found && found.workItemId === workItemId) {
      return { id: found.id, status: String(found.status), headCommitSha: found.headCommitSha }
    }
    return null
  }
  const latest = await withTenantDbTransaction(
    prisma,
    (tx) => tx.implementationSubmission.findFirst({
      where: { workItemId, NOT: { status: 'REJECTED' } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true, headCommitSha: true },
    }),
    tenantId,
  )
  return latest ? { id: latest.id, status: String(latest.status), headCommitSha: latest.headCommitSha } : null
}

export async function activateReconcile(
  node: WorkflowNode,
  instance: WorkflowInstance,
  actorId?: string,
): Promise<{ passed: boolean; output: ReconcileOutput }> {
  const requireVerifiedPass = cfgBool(node, 'requireVerifiedPass', false)
  const rawMode = (cfgString(node, 'mode') ?? 'DETERMINISTIC').toUpperCase()
  const mode: ReconciliationMode =
    rawMode === 'DYNAMIC' || rawMode === 'SEMANTIC' ? (rawMode as ReconciliationMode) : 'DETERMINISTIC'
  // A node firing on its own asserts nothing. An empty diff means the developer proved nothing,
  // so it must not report clean. Same reasoning as the copilot results post-back.
  const requireChangeManifest = cfgBool(node, 'requireChangeManifest', true)

  const stop = async (outcome: string, extra: Partial<ReconcileOutput['reconcile']> = {}) => {
    const output: ReconcileOutput = {
      reconcile: { status: 'HALTED', outcome, unproven: true, mode, ...extra },
    }
    await halt(instance, node, output, actorId)
    return { passed: false, output }
  }

  // ── Actor ────────────────────────────────────────────────────────────────
  // startReconciliation stamps ReconciliationRun.startedById and the WorkItemEvent actor, and
  // that attribution feeds a governance verdict. So: the human who triggered the node
  // (startAwaitingNode passes their id through), else whoever started the run. NO fabricated
  // system principal — with neither, halt and say so.
  const effectiveActorId = actorId ?? instance.createdById ?? undefined
  if (!effectiveActorId) {
    return stop(
      'This run records no actor (no triggering user and no instance creator), and a reconciliation verdict must be attributable to a person. Trigger this node manually so the reconciliation is attributed to you.',
    )
  }

  const workItem = await resolveWorkItem(node, instance)
  if (!workItem) {
    return stop(
      'This run is not linked to a Work Item, so there is no frozen specification to measure an implementation against. Launch the workflow from a Work Item, or set the node\'s workItemId.',
    )
  }

  const submission = await resolveSubmission(node, instance, workItem.id)
  if (!submission) {
    return stop(
      `No implementation submission exists for ${workItem.workCode} yet, so there is nothing to reconcile against the specification. The developer must post their results back (POST /export/copilot-results) or a submission must be registered on the Work Item, then restart this node.`,
      { workItemId: workItem.id, workCode: workItem.workCode },
    )
  }

  // ── The one call this node exists to make ────────────────────────────────
  let result: Awaited<ReturnType<typeof startReconciliation>>
  try {
    result = await startReconciliation(workItem.id, submission.id, effectiveActorId, mode, { requireChangeManifest })
  } catch (err) {
    // A ConflictError/NotFoundError here is a real, actionable statement about the handoff or
    // the binding (unpublished handoff, stale scope, malformed package). Surface it verbatim as
    // a halt rather than letting it fail the node with a stack trace.
    return stop(
      `The reconciliation could not be started: ${err instanceof Error ? err.message : String(err)}`,
      { workItemId: workItem.id, workCode: workItem.workCode, submissionId: submission.id },
    )
  }

  const runStatus = String(result.run.status)
  const decision = reconcileOutcomeFor(runStatus, { requireVerifiedPass })
  const output: ReconcileOutput = {
    reconcile: {
      status: decision.status,
      outcome: decision.outcome,
      unproven: decision.unproven,
      runStatus,
      reconciliationRunId: result.run.id,
      workItemId: workItem.id,
      workCode: workItem.workCode,
      submissionId: submission.id,
      mode: String(result.run.mode),
      verdictCount: result.verdicts.length,
      findingCount: result.findings.length,
      summary: asObject(result.summary),
    },
  }

  if (!decision.advance) {
    await halt(instance, node, output, actorId)
    return { passed: false, output }
  }
  const passedEvent = decision.status === 'VERIFIED' ? 'ReconcileVerified' : 'ReconcileDeclared'
  await logEvent(passedEvent, 'WorkflowNode', node.id, actorId, { instanceId: instance.id, output })
  await publishOutbox('WorkflowNode', node.id, passedEvent, { instanceId: instance.id, nodeId: node.id, output })
  return { passed: true, output }
}
