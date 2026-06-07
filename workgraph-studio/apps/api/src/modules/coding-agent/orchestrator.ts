import { BlueprintStageStatus } from '@prisma/client'
import {
  contextFabricClient,
  type ExecuteRequest,
  type ExecuteResponse,
  type GovernedStageRequest,
  type GovernedStageResponse,
  type PendingApproval,
} from '../../lib/context-fabric/client'
import { enrichStageRequestWithGovernance } from '../governance/governance.service'

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
  // Governed path only — the StageRunResult.final_state (PhaseState dict). The
  // caller persists this on an APPROVAL_PENDING pause so resume can rehydrate it
  // (legacy path leaves it undefined).
  governedFinalState?: Record<string, unknown> | null
}

export interface VerificationReceiptSummary {
  id?: string
  command?: string
  passed?: boolean
  exitCode?: number
  unavailable?: boolean
  source: 'tool' | 'artifact' | 'unknown'
  // M78 — surface the structured test parser output + a stdout slice so
  // the inherited-failure analyzer (blueprint.router approval path) can
  // classify each failed test as regression-vs-inherited and extract the
  // exception type for actionable UI. Optional — older receipts and
  // unsupported runners just leave these undefined.
  parsedTests?: { failingTests?: string[]; passingTests?: string[]; format?: string }
  stdoutExcerpt?: string
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
  // M100 — per-phase model override map (Phase value → model alias) for
  // this stage. Forwarded verbatim to CF, which routes each governed phase
  // to its pinned model (falling back to modelAlias for unset phases).
  // Omitted = single stage model (legacy).
  phaseModelAliases?: Record<string, string>
  bearer?: string
  runContext?: Record<string, unknown>
  // Persistable phase state from a prior run of the same stage attempt.
  // Empty → context-fabric mints a fresh PLAN.
  phaseState?: Record<string, unknown> | null
  // Initial OpenAI-style message history. Usually empty on first run.
  initialHistory?: unknown[]
  // Safety cap on LLM turns. Unset = context-fabric's default (25).
  maxTurns?: number
  // Wall-clock budget for the entire CF execute call. Drives both the
  // HTTP client AbortSignal in the CF client and (when honored on the
  // server) the per-stage timeout inside context-fabric's loop driver.
  // Unset = the CF client's hardcoded 15-minute ceiling.
  timeoutSec?: number
  // M93.D (2026-05-27) — Workflow's resolved StageExecutionPolicy.
  // Pre-M93.D the blueprint coding path silently dropped this even when
  // the workflow designer had pinned a tool_policy / repo_access on the
  // stage: M91.A's tool filtering only ran in the generic adapter path.
  // CF treats it as an override layer on top of the DB-seeded StagePolicy;
  // tool_policy / repo_access / context_policy filter the per-phase
  // allowed_tools, prompt_profile_key overrides which StagePromptBinding
  // resolves. Optional — legacy callers omitting this still get the
  // unfiltered base policy (back-compat preserved).
  stageExecutionPolicy?: GovernedStageRequest['stage_execution_policy']
  // Phase 3 — human approval-gate resume. When resuming a stage paused at
  // APPROVAL_PENDING, pass the persisted phaseState PLUS a decision: 'approved'
  // drives SELF_REVIEW→FINALIZE, 'rejected'/'changes_requested' → REPAIR (reason
  // surfaced as eval_feedback). Omitted ⇒ plain run/continuation.
  decision?: string
  reason?: string
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
    // M100 — only sent when the operator pinned at least one per-phase
    // override, so CF sees a clean "no per-phase map" signal otherwise.
    ...(input.phaseModelAliases && Object.keys(input.phaseModelAliases).length > 0
      ? { phase_model_aliases: input.phaseModelAliases }
      : {}),
    bearer: input.bearer,
    run_context: input.runContext ?? {},
    max_turns: input.maxTurns,
    timeout_sec: input.timeoutSec,
    // M93.D — pass through when the caller supplied one. Empty
    // stage_execution_policy isn't sent so CF sees a clean "no override"
    // signal (back-compat with pre-M93.D wire).
    ...(input.stageExecutionPolicy ? { stage_execution_policy: input.stageExecutionPolicy } : {}),
    // Phase 3 — approval-gate resume decision (only when resuming a pause).
    ...(input.decision ? { decision: input.decision, ...(input.reason ? { reason: input.reason } : {}) } : {}),
  }
  // Capability Governance Model (G5) — resolve + attach the governance overlay +
  // active waivers so CF's enforcement gate can block on unmet BLOCKING/REQUIRED
  // controls. Fail-open: no-op when there's no governance for the capability.
  await enrichStageRequestWithGovernance(stageRequest)
  const response = await contextFabricClient.executeGovernedStage(stageRequest)
  return adaptGovernedStageToCodingRun(response, input.policy)
}

/**
 * Map StageRunResult → CodingRunResult so existing blueprint.router code
 * paths keep working. Decisions:
 *
 *   - status: FINALIZED → COMPLETED. APPROVAL_PENDING → COMPLETED. The
 *     governed stage driver uses APPROVAL_PENDING for SELF_REVIEW's
 *     "ready for Workbench human approval" gate, not for a resumable MCP tool
 *     approval. MCP/tool approvals still come through the legacy /execute
 *     response with a continuation token. VALIDATION_BLOCKED / POLICY_BLOCKED
 *     / MAX_TURNS → FAILED. LLM_ERROR → FAILED.
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
  // M95 — NOT_ACTIONABLE is a legitimate terminal (the agent proved there's
  // nothing to do), NOT a failure. Treat it like APPROVAL_PENDING: the stage
  // COMPLETES and surfaces to the human gate for confirmation, rather than
  // being marked FAILED (which would look like the agent broke).
  const completedReasons = ['FINALIZED', 'APPROVAL_PENDING', 'NOT_ACTIONABLE']
  const status: CodingRunStatus =
    completedReasons.includes(stopReason ?? '') ? 'COMPLETED' : 'FAILED'
  const executeStatus: ExecuteResponse['status'] =
    completedReasons.includes(stopReason ?? '') ? 'COMPLETED' : 'FAILED'

  // Walk all turns and harvest tool-result payloads into the legacy slots.
  const codeChangeIds: string[] = []
  // (2026-05-26) Also harvest the FULL code-change envelope from each
  // successful mutating tool outcome. mcp-server's /resources/code-changes
  // ring is keyed by its own cc_<uuid> id which the governed loop never
  // sees (the legacy /mcp/invoke path used to mint these via
  // provenanceExtractor; /mcp/tool-run does not). Without inline records,
  // the workbench's "Code review" panel queried MCP by tool_invocation_id,
  // got an empty hit, and surfaced the "no diff body was available" banner
  // even though the diff was right there in the governed response.
  // Persisting the full envelope alongside the id list lets the
  // /blueprint/sessions/:id/code-changes endpoint serve diffs from
  // workgraph state without an MCP roundtrip.
  const codeChangeRecords: Array<{
    id: string
    tool_name: string
    paths_touched: string[]
    diff?: string
    patch?: string
    lines_added?: number
    lines_removed?: number
    commit_sha?: string
    stale: false
  }> = []
  const verificationReceipts: VerificationReceiptSummary[] = []
  const warnings: string[] = []
  // (2026-05-26) Provenance for finish_work_branch. The dev FINALIZE
  // prompt tells the agent to call finish_work_branch, but the
  // FinalizeReceipt validator only checks that branch_name and
  // commit_sha are strings — it doesn't verify those strings came
  // from a real tool dispatch. Agents have submitted fabricated
  // values and the stage closed COMPLETED with no actual commit
  // (repro 2026-05-26 session ef0e849e dev attempts 22b07b16 +
  // c119c6b7 — 3 successful replace_text calls each, zero
  // finish_work_branch dispatches, yet stage marked COMPLETED).
  // Surface a top-level signal so blueprint.router can refuse to
  // mark COMPLETED when the agent claims to have finalized but
  // never actually committed.
  let finishWorkBranchInvoked = false
  let finishWorkBranchResult: {
    branch_name?: string
    commit_sha?: string
    paths_committed?: string[]
    // (2026-05-31) mcp-server's finish_work_branch output also carries the
    // absolute worktree root the commit lives in. Capturing it lets Git Push
    // pin to the exact worktree (authoritative `workspaceRoot`) instead of
    // re-deriving a fragile guess from the branch name → NO_COMMIT_TO_PUSH.
    workspaceRoot?: string
  } | null = null
  // (2026-05-25) Mirror context-fabric's loop._extract_code_changes
  // logic: a mutating tool is "evidence of a real code change" iff
  // it ran successfully AND either emitted a code_change_id OR (more
  // commonly) emitted a paths_touched/paths_changed/files list. When
  // no server-minted id exists, use the dispatch's tool_invocation_id
  // as the binding token — that's the same token audit-gov's
  // governed.tool_dispatched events carry, so the trail stays intact.
  // The previous version of this adapter only knew the
  // {code_change_id, codeChangeId, changeId, change_id} aliases — none
  // of which mcp-server emits today — so every successful mutation
  // left codeChangeIds empty and the Develop approval guard refused
  // to advance. Reproduced manually 2026-05-25: 3 successful
  // replace_text calls on Operator.java + RuleEngineService.java +
  // RuleEngineServiceTest.java, all surfaced as
  // `{kind:"code_change", paths_touched:[...], diff:"...", patch:"...",
  //   lines_added, lines_removed}` — no id whatsoever.
  const MUTATING_TOOLS = new Set([
    'apply_patch', 'replace_text', 'replace_range', 'write_file',
    'create_file', 'finish_work_branch',
  ])
  for (const turn of resp.turns) {
    for (const outcome of turn.tool_outcomes) {
      if (!outcome.allowed && outcome.refusal_reason) {
        warnings.push(`Phase ${outcome.phase}: ${outcome.refusal_reason}`)
        continue
      }
      const result = outcome.result
      if (result && typeof result === 'object' && !Array.isArray(result)) {
        const rec = result as Record<string, unknown>
        // Code-change extraction. Three signals stack:
        //   1. Server-minted change id (preferred when present).
        //   2. paths_touched/paths_changed list + a binding id fallback.
        //   3. Single file/path field + a binding id fallback.
        // The fallback for (2) and (3) is the dispatch's
        // tool_invocation_id — guaranteed unique per call.
        const explicitIdCandidates = [
          rec.code_change_id, rec.codeChangeId, rec.changeId, rec.change_id,
        ]
        let explicitChangeId: string | null = null
        for (const cid of explicitIdCandidates) {
          if (typeof cid === 'string' && cid.length > 0) {
            explicitChangeId = cid
            codeChangeIds.push(cid)
            break
          }
        }
        // Common-shape harvester used to build the inline record. Computed
        // up front so both the explicit-id branch and the
        // invocation-id-fallback branch can reuse it.
        const collectPaths = (): string[] => {
          const out: string[] = []
          const pathLists: unknown[] = [
            rec.paths_touched, rec.paths_changed, rec.changed_files, rec.files,
          ]
          for (const list of pathLists) {
            if (Array.isArray(list)) {
              for (const x of list) {
                if (typeof x === 'string' && x.length > 0 && !out.includes(x)) out.push(x)
              }
            }
          }
          const singlePath = rec.file ?? rec.path ?? rec.file_path ?? rec.target_file
          if (typeof singlePath === 'string' && singlePath.length > 0 && !out.includes(singlePath)) {
            out.push(singlePath)
          }
          return out
        }
        const numOrUndef = (v: unknown): number | undefined =>
          typeof v === 'number' && Number.isFinite(v) ? v : undefined
        const strOrUndef = (v: unknown): string | undefined =>
          typeof v === 'string' && v.length > 0 ? v : undefined
        // If no explicit id but the tool is mutating AND succeeded AND
        // reported a path, fall back to invocation_id.
        let fallbackChangeId: string | null = null
        if (
          !explicitChangeId
          && MUTATING_TOOLS.has(outcome.tool_name)
          && outcome.tool_success !== false
          && outcome.tool_invocation_id
        ) {
          // Confirm the result envelope actually claims a path —
          // otherwise we don't have evidence of a real edit.
          if (collectPaths().length > 0) {
            fallbackChangeId = outcome.tool_invocation_id
            codeChangeIds.push(outcome.tool_invocation_id)
          }
        }
        // (2026-05-26) Inline code-change record. Captures everything the
        // workbench's review panel needs (paths_touched, diff, lines)
        // without an MCP roundtrip. The id matches whatever we recorded
        // in codeChangeIds for this outcome so the existing lookup path
        // still matches by id when records are merged in the route.
        const bindingId = explicitChangeId ?? fallbackChangeId
        if (bindingId) {
          const paths = collectPaths()
          codeChangeRecords.push({
            id: bindingId,
            tool_name: outcome.tool_name,
            paths_touched: paths,
            diff: strOrUndef(rec.diff) ?? strOrUndef(rec.unified_diff),
            patch: strOrUndef(rec.patch),
            lines_added: numOrUndef(rec.lines_added),
            lines_removed: numOrUndef(rec.lines_removed),
            commit_sha: strOrUndef(rec.commit_sha) ?? strOrUndef(rec.commitSha),
            stale: false,
          })
        }
        // (2026-05-26) finish_work_branch provenance. Track whether
        // the dev agent actually invoked the tool (vs fabricating the
        // FinalizeReceipt). See finishWorkBranchInvoked declaration.
        if (outcome.tool_name === 'finish_work_branch' && outcome.tool_success !== false) {
          finishWorkBranchInvoked = true
          finishWorkBranchResult = {
            // (2026-05-31) The finish_work_branch tool emits `branch` (and
            // `paths_touched`), not `branch_name`/`paths_committed` — so the
            // branch was silently lost here and only recovered downstream by the
            // workbench-name fallback (which has no equivalent for the root).
            // Read the real field with a legacy fallback.
            branch_name: typeof rec.branch_name === 'string' ? rec.branch_name
              : typeof rec.branch === 'string' ? rec.branch : undefined,
            commit_sha: typeof rec.commit_sha === 'string' ? rec.commit_sha : undefined,
            paths_committed: Array.isArray(rec.paths_committed)
              ? rec.paths_committed.filter((p): p is string => typeof p === 'string')
              : Array.isArray(rec.paths_touched)
                ? rec.paths_touched.filter((p): p is string => typeof p === 'string')
                : undefined,
            // Absolute worktree root the commit lives in — lets Git Push pin to
            // the exact tree instead of re-deriving a guess from the branch name.
            workspaceRoot: typeof rec.workspaceRoot === 'string' ? rec.workspaceRoot : undefined,
          }
        }
        // Verification receipt extraction.
        const kind = String(rec.kind ?? rec.type ?? '').toLowerCase()
        if (kind === 'verification_result' || kind === 'test_result' || outcome.tool_name === 'run_test' || outcome.tool_name === 'run_command') {
          // M78 — Preserve the structured test-parser output + a stdout
          // slice so the approval gate's inherited-failure analyzer can
          // classify each failed test (regression-vs-inherited) and
          // extract the exception class for actionable UI cards. The
          // structured data lives at rec.parsed_tests (see
          // mcp-server/src/tools/test-report-parser.ts), populated by
          // M72 Slice D for Maven/Gradle/pytest. Older runners + Jest
          // leave it undefined; analyzer degrades gracefully.
          const parsedRec = (rec.parsed_tests && typeof rec.parsed_tests === 'object'
            && !Array.isArray(rec.parsed_tests)) ? rec.parsed_tests as Record<string, unknown> : undefined
          const parsedTests = parsedRec ? {
            failingTests: Array.isArray(parsedRec.failingTests)
              ? parsedRec.failingTests.filter((t): t is string => typeof t === 'string')
              : undefined,
            passingTests: Array.isArray(parsedRec.passingTests)
              ? parsedRec.passingTests.filter((t): t is string => typeof t === 'string')
              : undefined,
            format: typeof parsedRec.format === 'string' ? parsedRec.format : undefined,
          } : undefined
          verificationReceipts.push({
            id: typeof rec.id === 'string' ? rec.id : undefined,
            command: typeof rec.command === 'string' ? rec.command : undefined,
            passed: typeof rec.passed === 'boolean' ? rec.passed : undefined,
            exitCode: typeof rec.exit_code === 'number'
              ? rec.exit_code as number
              : (typeof rec.exitCode === 'number' ? rec.exitCode as number : undefined),
            unavailable: rec.unavailable === true || rec.verification_kind === 'unavailable',
            source: 'tool',
            parsedTests,
            stdoutExcerpt: typeof rec.stdout_excerpt === 'string' ? rec.stdout_excerpt : undefined,
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
  const cfCallId = `governed:${resp.final_state.stage_key}:${resp.turns.length}`
  const finalResponse = governedFinalResponse(resp)
  // Surface the CONCRETE failure cause (LLM gateway upstream error, validation
  // halt, policy block, …) so the workbench shows it instead of the generic
  // "stage failed". The router persists this into the attempt's `error` field
  // (read as result.finishReason), which the FocusPane banner renders.
  const finishReason = governedFailureReason(resp)
  const syntheticResponse = {
    status: executeStatus,
    cfCallId,
    finalResponse,
    text: finalResponse,
    finishReason,
    correlation: {
      cfCallId,
      codeChangeIds,
      // M71-followup (2026-05-26) — inline diff envelopes alongside the
      // ids. Workbench /blueprint/sessions/:id/code-changes prefers these
      // over MCP roundtrip because mcp-server's /resources/code-changes
      // ring is keyed by cc_<uuid> and never sees our tool_invocation_id
      // fallback. Persisted into BlueprintSession.metadata.stageAttempts[]
      // .correlation by the existing spread at line ~2342 / 2366.
      codeChangeRecords,
      verificationReceipts,
      // (2026-05-26) Cross-stage check: blueprint.router refuses to
      // mark develop COMPLETED when finishWorkBranchInvoked is false.
      finishWorkBranchInvoked,
      finishWorkBranchResult,
      // (2026-05-29) Git Push evidence chain. The governed loop commits on
      // a real branch via finish_work_branch, but that branch was never
      // surfaced to buildActualCodeChangeEvidence, so workspaceBranch landed
      // empty and GitPushExecutor hit NO_COMMIT_TO_PUSH even with edits.
      // Map the committed branch + sha + touched paths here so the artifact
      // carries them through.
      workspaceBranch: finishWorkBranchResult?.branch_name,
      workspaceCommitSha: finishWorkBranchResult?.commit_sha,
      changedPaths: Array.from(new Set([
        ...(finishWorkBranchResult?.paths_committed ?? []),
        ...codeChangeRecords.flatMap((r) => r.paths_touched ?? []),
      ])),
      // (2026-05-31) Surface the real worktree root so buildActualCodeChangeEvidence
      // records workspace_root and GitPushExecutor forwards it to /mcp/work/finish-branch
      // as the authoritative root — pinning the push to the worktree that holds the
      // commit instead of re-deriving an empty branch → NO_COMMIT_TO_PUSH.
      workspaceRoot: finishWorkBranchResult?.workspaceRoot,
      governed: {
        stopReason: resp.stop_reason,
        errorCode: resp.error_code,
        errorMessage: resp.error_message,
        finalPhase: resp.final_state.current_phase,
        totalTurns: resp.turns.length,
        approvalPending: resp.final_state.approval_pending,
      },
    },
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
    pendingApproval: null,
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
    // Phase 3 — expose the PhaseState dict so the caller can persist it on an
    // APPROVAL_PENDING pause and rehydrate it on resume.
    governedFinalState: (resp.final_state as Record<string, unknown> | undefined) ?? null,
  }
}

/**
 * Build a concise, human-readable failure reason from a governed stage result.
 *
 * Context-Fabric's StageRunResult already carries `error_code` + `error_message`
 * (for LLM_ERROR the message includes the gateway's upstream body, e.g.
 * "Gateway returned 502: …Your credit balance is too low…"). Pre-this-change
 * that detail was buried in correlation.governed and never reached the attempt's
 * `error` field, so the workbench banner fell back to the literal "stage failed"
 * and showed "no error message". This surfaces the real cause.
 *
 * Returns undefined for a clean finish (FINALIZED / APPROVAL_PENDING / empty) so
 * success paths don't render a spurious reason.
 */
export function governedFailureReason(resp: GovernedStageResponse): string | undefined {
  const stop = resp.stop_reason
  if (!stop || stop === 'FINALIZED' || stop === 'APPROVAL_PENDING') return undefined
  // Prefer the concrete message (carries the upstream gateway body), prefixed
  // with the machine code for triage. Cap length so a verbose provider error
  // can't bloat the attempt record / banner.
  if (resp.error_message) {
    const prefix = resp.error_code ? `${resp.error_code}: ` : ''
    return `${prefix}${resp.error_message}`.slice(0, 600)
  }
  switch (stop) {
    case 'LLM_ERROR':
      return resp.error_code ? `LLM gateway error (${resp.error_code})` : 'LLM gateway error'
    case 'VALIDATION_BLOCKED':
      return 'Phase output failed validation'
    case 'POLICY_BLOCKED':
      return 'Agent stalled calling disallowed tools (policy blocked)'
    case 'MAX_TURNS':
      return 'Stage hit its maximum turn budget without finishing'
    default:
      return `Stage halted: ${stop}`
  }
}

function governedFinalResponse(resp: GovernedStageResponse): string {
  const sections: string[] = []
  const receipts = resp.final_state.receipts ?? {}

  for (const [phase, phaseReceipts] of Object.entries(receipts)) {
    for (const receipt of phaseReceipts) {
      if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) continue
      const record = receipt as Record<string, unknown>

      if (typeof record.story_brief === 'string' && record.story_brief.trim()) {
        const block = [
          `## ${titleFromPhase(phase)} story brief`,
          '',
          record.story_brief.trim(),
          ...formatStringList('Acceptance criteria', record.acceptance_criteria),
          ...formatStringList('Open questions', record.open_questions),
        ].filter(Boolean).join('\n')
        sections.push(block)
        continue
      }

      if (typeof record.summary === 'string' && record.summary.trim()) {
        sections.push([
          `## ${titleFromPhase(phase)} summary`,
          '',
          record.summary.trim(),
        ].join('\n'))
      }

      if (typeof record.recommended_for_approval === 'boolean') {
        const riskSummary = record.risk_summary && typeof record.risk_summary === 'object'
          ? JSON.stringify(record.risk_summary, null, 2)
          : ''
        sections.push([
          `## ${titleFromPhase(phase)} review`,
          '',
          `Recommended for approval: ${record.recommended_for_approval ? 'yes' : 'no'}`,
          riskSummary ? `\nRisk summary:\n\n\`\`\`json\n${riskSummary}\n\`\`\`` : '',
        ].filter(Boolean).join('\n'))
      }
    }
  }

  const llmNotes = resp.turns
    .map(turn => typeof turn.llm?.content === 'string' ? turn.llm.content.trim() : '')
    .filter(Boolean)
    .at(-1)

  if (sections.length === 0 && llmNotes) {
    sections.push(llmNotes)
  }

  if (sections.length === 0) {
    sections.push([
      '## Governed stage completed',
      '',
      `Stop reason: ${resp.stop_reason || 'unknown'}`,
      `Final phase: ${resp.final_state.current_phase || 'unknown'}`,
    ].join('\n'))
  }

  return sections.join('\n\n').slice(0, 20000)
}

function titleFromPhase(phase: string): string {
  return phase
    .toLowerCase()
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || 'Stage'
}

function formatStringList(title: string, value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const items = value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map(item => `- ${item.trim()}`)
  return items.length > 0 ? ['', `### ${title}`, '', ...items] : []
}
