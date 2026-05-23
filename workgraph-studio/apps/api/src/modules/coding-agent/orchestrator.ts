import { BlueprintStageStatus } from '@prisma/client'
import {
  contextFabricClient,
  type ExecuteRequest,
  type ExecuteResponse,
  type GovernedStageRequest,
  type GovernedStageResponse,
  type PendingApproval,
} from '../../lib/context-fabric/client'

export type CodingStagePolicy = 'planning' | 'design' | 'developer' | 'qa' | 'certify'
export type CodingRunStatus = 'COMPLETED' | 'FAILED' | 'PAUSED' | 'DENIED'

export interface CodingRunRequest {
  sessionId: string
  stageKey: string
  stageLabel?: string
  attemptId: string
  actorId?: string
  policy: CodingStagePolicy
  executeRequest: ExecuteRequest
}

export interface CodingRunResult {
  status: CodingRunStatus
  executeStatus: ExecuteResponse['status']
  response: ExecuteResponse
  policy: CodingStagePolicy
  pendingApproval?: PendingApproval | null
  codeChangeIds: string[]
  verificationReceipts: VerificationReceiptSummary[]
  modelUsage: ExecuteResponse['modelUsage']
  tokensUsed: ExecuteResponse['tokensUsed']
  warnings: string[]
}

export interface VerificationReceiptSummary {
  id?: string
  command?: string
  passed?: boolean
  exitCode?: number
  unavailable?: boolean
  source: 'tool' | 'artifact' | 'unknown'
}

export async function runCodingStage(input: CodingRunRequest): Promise<CodingRunResult> {
  const response = await contextFabricClient.execute(input.executeRequest)
  return normalizeCodingRunResult(response, input.policy)
}

export async function resumeCodingStage(input: {
  cfCallId?: string
  continuationToken?: string
  decision: 'approved' | 'rejected'
  reason?: string
  argsOverride?: Record<string, unknown>
  policy: CodingStagePolicy
}): Promise<CodingRunResult> {
  const response = await contextFabricClient.resume({
    cf_call_id: input.cfCallId,
    continuation_token: input.continuationToken,
    decision: input.decision,
    reason: input.reason,
    args_override: input.argsOverride,
  })
  return normalizeCodingRunResult(response, input.policy)
}

export function normalizeCodingRunResult(response: ExecuteResponse, policy: CodingStagePolicy): CodingRunResult {
  const executeStatus = response.status
  const status: CodingRunStatus =
    executeStatus === 'WAITING_APPROVAL' ? 'PAUSED'
      : executeStatus === 'FAILED' ? 'FAILED'
        : executeStatus === 'DENIED' || executeStatus === 'REJECTED' ? 'DENIED'
          : 'COMPLETED'

  return {
    status,
    executeStatus,
    response,
    policy,
    pendingApproval: response.pendingApproval ?? null,
    codeChangeIds: codeChangeIdsFrom(response),
    verificationReceipts: verificationReceiptsFrom(response),
    modelUsage: response.modelUsage,
    tokensUsed: response.tokensUsed,
    warnings: response.warnings ?? [],
  }
}

export function blueprintStageStatusFor(result: CodingRunResult): BlueprintStageStatus {
  if (result.status === 'FAILED' || result.status === 'DENIED') return BlueprintStageStatus.FAILED
  // The relational enum has no PAUSED state today. Keep the DB row open while
  // Workbench attempt metadata carries the precise PAUSED status + token.
  if (result.status === 'PAUSED') return BlueprintStageStatus.RUNNING
  return BlueprintStageStatus.COMPLETED
}

export function attemptStatusFor(result: CodingRunResult): 'COMPLETED' | 'FAILED' | 'PAUSED' {
  if (result.status === 'PAUSED') return 'PAUSED'
  if (result.status === 'FAILED' || result.status === 'DENIED') return 'FAILED'
  return 'COMPLETED'
}

export function isTerminalCodingResult(result: CodingRunResult): boolean {
  return result.status !== 'PAUSED'
}

export function classifyCodingStagePolicy(input: { key?: string; label?: string; agentRole?: string; terminal?: boolean; contextPolicy?: string; toolPolicy?: string }): CodingStagePolicy {
  const contextPolicy = String(input.contextPolicy ?? '').toUpperCase()
  const toolPolicy = String(input.toolPolicy ?? '').toUpperCase()
  if (contextPolicy === 'CODE_EDIT' || toolPolicy === 'MUTATION') return 'developer'
  if (contextPolicy === 'VERIFY_ONLY' || toolPolicy === 'VERIFICATION') return 'qa'
  if (contextPolicy === 'EVIDENCE_REVIEW') return 'certify'
  if (contextPolicy === 'REPO_READ_ONLY') return 'planning'
  const signature = `${input.key ?? ''} ${input.label ?? ''} ${input.agentRole ?? ''}`.toLowerCase()
  if (signature.includes('develop') || signature.includes('developer') || signature.includes('engineer') || signature.includes('code')) return 'developer'
  if (signature.includes('certif') || signature.includes('signoff') || signature.includes('sign-off') || input.terminal) return 'certify'
  if (signature.includes('qa') || signature.includes('quality') || signature.includes('test') || signature.includes('verif')) return 'qa'
  if (signature.includes('design') || signature.includes('architect')) return 'design'
  return 'planning'
}

export function stageRequiresVerification(policy: CodingStagePolicy): boolean {
  return policy === 'developer' || policy === 'qa' || policy === 'certify'
}

export function hasActualCodeChange(result: CodingRunResult): boolean {
  return result.codeChangeIds.length > 0
}

export function hasVerificationReceipt(result: CodingRunResult): boolean {
  return result.verificationReceipts.length > 0
}

export function hasPassingVerificationReceipt(result: CodingRunResult): boolean {
  return result.verificationReceipts.some(receipt => receipt.passed === true || receipt.exitCode === 0)
}

export function hasFailedVerificationReceipt(result: CodingRunResult): boolean {
  return result.verificationReceipts.some(receipt =>
    !receipt.unavailable && (receipt.passed === false || (typeof receipt.exitCode === 'number' && receipt.exitCode !== 0)),
  )
}

export function hasUnavailableVerificationReceipt(result: CodingRunResult): boolean {
  return result.verificationReceipts.some(receipt => receipt.unavailable === true)
}

function codeChangeIdsFrom(response: ExecuteResponse): string[] {
  return (response.correlation?.codeChangeIds ?? [])
    .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
}

function verificationReceiptsFrom(response: ExecuteResponse): VerificationReceiptSummary[] {
  const receipts: VerificationReceiptSummary[] = []
  const seen = new Set<string>()
  const candidates = [
    response.verificationReceipts,
    response.correlation,
    response.correlation?.verificationReceipts,
    response.workspace,
    response.usage,
    response.metrics,
    response.prompt,
  ]
  for (const candidate of candidates) {
    collectVerificationReceipts(candidate, receipts, seen)
  }
  return receipts
}

function collectVerificationReceipts(value: unknown, out: VerificationReceiptSummary[], seen: Set<string>): void {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) collectVerificationReceipts(item, out, seen)
    return
  }
  const record = value as Record<string, unknown>
  const kind = String(record.kind ?? record.type ?? '').toLowerCase()
  const verificationKind = String(record.verification_kind ?? '').toLowerCase()
  // M68.1 — Exclude the formal-verifier's own block-result receipts from
  // cross-stage threading. mcp-server's auto-finish at invoke.ts:2580
  // pushes a `{verification_kind:"formal", passed:false, ...}` entry onto
  // state.verificationReceipts whenever the gate blocks, so the agent's
  // repair loop can see WHY it was blocked. That's useful in-session.
  // But the summary gets saved into BlueprintSession.metadata
  // .verificationReceiptHistory and threaded to every future stage as
  // priorVerificationReceipts — and because the gate uses receipts.every(
  // passed), a single blocked stage poisons every subsequent stage's
  // gate forever. Filter formal-kind receipts here so they stay
  // in-session-only. Real run_test/run_command receipts (kind="test",
  // "command", etc.) still flow through.
  if (verificationKind === 'formal') return
  // M70.5 — Reject "summary-shape" receipts that came back from M66
  // cross-stage threading. Real receipts from mcp-server have an
  // explicit `kind === "verification_result"`; the summaries we thread
  // forward via priorVerificationReceipts only have
  // {passed, command, source, exitCode, unavailable} — no `kind`,
  // no `capturedAt`, no `verification_kind`. Without this guard the
  // orchestrator re-collects them as if fresh, the summary gets
  // re-persisted to verificationReceiptHistory, and a single failing
  // receipt from attempt #1 propagates forever (witnessed on a
  // 7-attempt RuleEngine session). Now the "kind"-less command-passed
  // fallback is dropped — every real receipt from mcp-server has the
  // kind set, so only those count toward the SUMMARY pipeline.
  const looksLikeVerification =
    kind === 'verification_result' ||
    kind === 'test_result'
  if (looksLikeVerification) {
    const id = typeof record.id === 'string' ? record.id : undefined
    const key = id ?? JSON.stringify({
      command: record.command,
      exit: record.exit_code ?? record.exitCode,
      passed: record.passed,
    })
    if (!seen.has(key)) {
      seen.add(key)
      out.push({
        id,
        command: typeof record.command === 'string' ? record.command : undefined,
        passed: typeof record.passed === 'boolean' ? record.passed : undefined,
        exitCode: typeof record.exit_code === 'number'
          ? record.exit_code
          : typeof record.exitCode === 'number'
            ? record.exitCode
            : undefined,
        unavailable: record.unavailable === true || record.verification_kind === 'unavailable',
        source: kind ? 'tool' : 'unknown',
      })
    }
    return
  }
  for (const item of Object.values(record)) collectVerificationReceipts(item, out, seen)
}


// ─────────────────────────────────────────────────────────────────────────────
// M71 Slice F — Governed-stage runner.
//
// Calls context-fabric's POST /api/v1/execute-governed-stage instead of the
// legacy /execute → mcp-server /invoke chain. The response shape
// (StageRunResult) is different from ExecuteResponse, so the adapter below
// re-projects it into CodingRunResult — the same return type runCodingStage
// has used since M66. Callers in blueprint.router.ts don't have to change.
//
// What we lose by going through the new path:
//   - cf_call_id correlation (the new endpoint doesn't mint one yet; we
//     synthesize a UUID-like value from the run_context.work_item_id +
//     turn count so audit-gov searches still join). TODO: emit cf_call_id
//     from run_stage so this round-trip is unnecessary.
//
// What we gain:
//   - Hard-refuse policy enforcement at every tool dispatch (PHASE_TOOL_FORBIDDEN).
//   - Per-phase prompts (so DEVELOPER PLAN sees PLAN guidance, not the kitchen
//     sink loopDeveloperTask).
//   - Structured phase-state persistence the Workbench UI can render.
//   - The stage halt-conditions taxonomy (FINALIZED / APPROVAL_PENDING /
//     POLICY_BLOCKED / etc.) which is more actionable than a single
//     "completed/failed" boolean.
// ─────────────────────────────────────────────────────────────────────────────

export interface CodingStageGovernedRequest {
  stageKey: string
  agentRole?: string | null
  policy: CodingStagePolicy
  vars?: Record<string, unknown>
  modelAlias?: string
  bearer?: string
  runContext?: Record<string, unknown>
  // Persistable phase state from a prior run of the same stage attempt.
  // Empty → context-fabric mints a fresh PLAN.
  phaseState?: Record<string, unknown> | null
  // Initial OpenAI-style message history. Usually empty on first run.
  initialHistory?: unknown[]
  // Safety cap on LLM turns. Unset = context-fabric's default (25).
  maxTurns?: number
}

export async function runCodingStageGoverned(
  input: CodingStageGovernedRequest,
): Promise<CodingRunResult> {
  const stageRequest: GovernedStageRequest = {
    stage_key: input.stageKey,
    agent_role: input.agentRole ?? undefined,
    phase_state: input.phaseState ?? null,
    vars: input.vars ?? {},
    initial_history: input.initialHistory ?? [],
    model_alias: input.modelAlias,
    bearer: input.bearer,
    run_context: input.runContext ?? {},
    max_turns: input.maxTurns,
  }
  const response = await contextFabricClient.executeGovernedStage(stageRequest)
  return adaptGovernedStageToCodingRun(response, input.policy)
}

/**
 * Map StageRunResult → CodingRunResult so existing blueprint.router code
 * paths keep working. Decisions:
 *
 *   - status: FINALIZED → COMPLETED. APPROVAL_PENDING → PAUSED (matches
 *     today's pause-for-approval flow). VALIDATION_BLOCKED /
 *     POLICY_BLOCKED / MAX_TURNS → FAILED. LLM_ERROR → FAILED.
 *
 *   - codeChangeIds: extracted from any tool outcome whose result carries
 *     a recognizable code_change_id / changeId. Conservative; misses any
 *     non-standard tool outputs but doesn't fabricate.
 *
 *   - verificationReceipts: extracted from tool outcomes whose tool_name
 *     is run_test/run_command/verification_unavailable. Same heuristic
 *     as the legacy normalizer's verification_result detection.
 *
 *   - modelUsage / tokensUsed: derived from totals.
 *
 *   - response (the legacy raw payload field): we stash the StageRunResult
 *     under a synthetic ExecuteResponse-shaped wrapper so callers that
 *     reach into `result.response.*` still find SOMETHING — but the new
 *     fields are clearly tagged so downstream code can branch on them.
 */
export function adaptGovernedStageToCodingRun(
  resp: GovernedStageResponse,
  policy: CodingStagePolicy,
): CodingRunResult {
  const stopReason = resp.stop_reason
  const status: CodingRunStatus =
    stopReason === 'FINALIZED' ? 'COMPLETED'
      : stopReason === 'APPROVAL_PENDING' ? 'PAUSED'
        : 'FAILED'
  const executeStatus: ExecuteResponse['status'] =
    stopReason === 'FINALIZED' ? 'COMPLETED'
      : stopReason === 'APPROVAL_PENDING' ? 'WAITING_APPROVAL'
        : 'FAILED'

  // Walk all turns and harvest tool-result payloads into the legacy slots.
  const codeChangeIds: string[] = []
  const verificationReceipts: VerificationReceiptSummary[] = []
  const warnings: string[] = []
  for (const turn of resp.turns) {
    for (const outcome of turn.tool_outcomes) {
      if (!outcome.allowed && outcome.refusal_reason) {
        warnings.push(`Phase ${outcome.phase}: ${outcome.refusal_reason}`)
        continue
      }
      const result = outcome.result
      if (result && typeof result === 'object' && !Array.isArray(result)) {
        const rec = result as Record<string, unknown>
        // Code-change extraction: tools like apply_patch, replace_text,
        // create_file, finish_work_branch all expose a code_change_id (or
        // changeId) on the result envelope when they actually mutate.
        const candidates = [rec.code_change_id, rec.codeChangeId, rec.changeId, rec.change_id]
        for (const cid of candidates) {
          if (typeof cid === 'string' && cid.length > 0) codeChangeIds.push(cid)
        }
        // Verification receipt extraction.
        const kind = String(rec.kind ?? rec.type ?? '').toLowerCase()
        if (kind === 'verification_result' || kind === 'test_result' || outcome.tool_name === 'run_test' || outcome.tool_name === 'run_command') {
          verificationReceipts.push({
            id: typeof rec.id === 'string' ? rec.id : undefined,
            command: typeof rec.command === 'string' ? rec.command : undefined,
            passed: typeof rec.passed === 'boolean' ? rec.passed : undefined,
            exitCode: typeof rec.exit_code === 'number'
              ? rec.exit_code as number
              : (typeof rec.exitCode === 'number' ? rec.exitCode as number : undefined),
            unavailable: rec.unavailable === true || rec.verification_kind === 'unavailable',
            source: 'tool',
          })
        }
      }
      if (outcome.dispatch_error) {
        warnings.push(`Tool ${outcome.tool_name}: ${outcome.dispatch_error}`)
      }
    }
    if (turn.validation_error) {
      const err = turn.validation_error as Record<string, unknown>
      warnings.push(`Phase ${turn.from_phase} output invalid: ${err.reason ?? 'unknown'}`)
    }
  }

  // Synthesize a minimum-viable ExecuteResponse shell so legacy readers
  // don't crash on .response.X access. The interesting fields live in the
  // adapter outputs above; this is just the envelope.
  const syntheticResponse = {
    status: executeStatus,
    cfCallId: `governed:${resp.final_state.stage_key}:${resp.turns.length}`,
    text: resp.turns.at(-1)?.llm?.content ?? '',
    correlation: { codeChangeIds, verificationReceipts },
    modelUsage: {
      provider: resp.turns.at(-1)?.llm?.provider ?? 'unknown',
      model: resp.turns.at(-1)?.llm?.model ?? 'unknown',
      inputTokens: resp.totals.input_tokens,
      outputTokens: resp.totals.output_tokens,
      estimatedCost: 0,
      latencyMs: resp.turns.reduce((sum, t) => sum + (t.llm?.latency_ms ?? 0), 0),
    },
    tokensUsed: {
      input: resp.totals.input_tokens,
      output: resp.totals.output_tokens,
      total: resp.totals.input_tokens + resp.totals.output_tokens,
    },
    verificationReceipts,
    warnings,
    pendingApproval: resp.stop_reason === 'APPROVAL_PENDING'
      ? { reason: 'SELF_REVIEW recommended approval', kind: 'self_review_approval' as const }
      : null,
    // M71 — extra fields the legacy ExecuteResponse type doesn't carry but
    // downstream debug surfaces can read off `result.response.governed`.
    governed: {
      stopReason: resp.stop_reason,
      errorCode: resp.error_code,
      errorMessage: resp.error_message,
      finalPhase: resp.final_state.current_phase,
      totalTurns: resp.turns.length,
      approvalPending: resp.final_state.approval_pending,
      totals: resp.totals,
    },
  } as unknown as ExecuteResponse

  return {
    status,
    executeStatus,
    response: syntheticResponse,
    policy,
    pendingApproval: syntheticResponse.pendingApproval,
    codeChangeIds,
    verificationReceipts,
    modelUsage: syntheticResponse.modelUsage,
    tokensUsed: syntheticResponse.tokensUsed,
    warnings,
  }
}
