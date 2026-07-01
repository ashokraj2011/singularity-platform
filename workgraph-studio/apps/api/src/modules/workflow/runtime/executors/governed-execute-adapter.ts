/**
 * Task #119 — Adapter that lets workflow AGENT_TASK nodes route through
 * context-fabric's governed-stage endpoint without rewriting the
 * downstream code that reads the legacy ExecuteResponse shape.
 *
 * Two functions:
 *   - executeReqToGovernedStageReq(): map the legacy ExecuteRequest into
 *     a GovernedStageRequest. Best-effort; some legacy fields don't
 *     have a direct equivalent (system_prompt, prior_outputs, etc.) and
 *     get folded into `vars` so the prompt-composer still sees them.
 *   - governedStageRespToExecuteResp(): map the GovernedStageResponse
 *     into an ExecuteResponse-shaped object the AgentTaskExecutor's
 *     persistence + correlation code already knows how to read.
 *
 * Used today by AgentTaskExecutor (workflow-graph nodes). The
 * blueprint coding-stage path has its own purpose-built adapter
 * (coding-agent/orchestrator.ts:adaptGovernedStageToCodingRun) — that
 * one targets a different downstream consumer (CodingRunResult vs
 * ExecuteResponse) so we deliberately don't share code. Both adapters
 * agree on the same conceptual mapping; if you change one, audit the
 * other for drift.
 *
 * Not feature-flagged here — the AgentTaskExecutor caller is. This
 * file just defines the mapping; the caller decides when to use it.
 */
import type { ExecuteRequest, ExecuteResponse } from '../../../../lib/context-fabric/client'
import type {
  GovernedStageRequest,
  GovernedStageResponse,
} from '../../../../lib/context-fabric/client'
import { config } from '../../../../config'

type GovernanceMode = NonNullable<ExecuteRequest['governance_mode']>

/**
 * Map a legacy ExecuteRequest to a GovernedStageRequest. The two shapes
 * overlap mostly in metadata; the actual "what should the LLM do"
 * payload moves from `task` (free-text) to `vars` (where the
 * prompt-composer's templated stage prompts pick it up by name).
 *
 * Stage_key defaults to `loop.stage` — the catch-all policy seeded
 * for the M71 cutover. When operators want a node to use a different
 * policy they pass `governedStageKey` + `governedAgentRole` in the
 * node's cfg (the caller is responsible for plumbing those through;
 * this function just respects them when present).
 */
export function executeReqToGovernedStageReq(req: ExecuteRequest, opts: {
  stageKey?: string
  agentRole?: string
  maxTurns?: number
} = {}): GovernedStageRequest {
  const stageKey = opts.stageKey ?? 'loop.stage'
  // Fold legacy fields the governed path doesn't model into vars so
  // the prompt-composer can still surface them. Names match the
  // legacy ExecuteRequest field names so prompt templates that
  // reference them keep working.
  const vars: Record<string, unknown> = {
    ...(req.vars ?? {}),
    task: req.task ?? '',
    ...(req.system_prompt ? { system_prompt: req.system_prompt } : {}),
    ...(req.prior_outputs ? { prior_outputs: req.prior_outputs } : {}),
    ...(req.artifacts ? { artifacts: req.artifacts } : {}),
    ...(req.globals ? { globals: req.globals } : {}),
  }
  // M91.A (2026-05-27) — Build the workflow's resolved
  // StageExecutionPolicy from the same `vars` fields the caller already
  // populated for template substitution. CF treats this as the
  // override layer on top of the DB-seeded StagePolicy; tool_policy /
  // repo_access from the workflow designer's NodeInspector now actually
  // narrow the runtime tool set instead of being decorative. We populate
  // only when the caller actually set the fields — an empty policy
  // would be a no-op anyway, but skipping the object keeps the wire
  // payload smaller for legacy callers.
  const stageExecPolicy: GovernedStageRequest['stage_execution_policy'] = (() => {
    const contextPolicy = typeof vars.stageContextPolicy === 'string'
      ? vars.stageContextPolicy as string : undefined
    const toolPolicy = typeof vars.stageToolPolicy === 'string'
      ? vars.stageToolPolicy as string : undefined
    const repoAccess = typeof vars.stageRepoAccess === 'boolean'
      ? vars.stageRepoAccess as boolean : undefined
    const promptProfileKey = typeof vars.promptProfileKey === 'string'
      && (vars.promptProfileKey as string).length > 0
      ? vars.promptProfileKey as string : undefined
    if (contextPolicy === undefined && toolPolicy === undefined
        && repoAccess === undefined && promptProfileKey === undefined) {
      return undefined
    }
    return {
      stage_key: stageKey,
      agent_role: opts.agentRole,
      context_policy: contextPolicy,
      tool_policy: toolPolicy,
      repo_access: repoAccess,
      prompt_profile_key: promptProfileKey,
    }
  })()
  return {
    stage_key: stageKey,
    agent_role: opts.agentRole,
    vars,
    initial_history: [],
    run_context: (req.run_context ?? {}) as unknown as Record<string, unknown>,
    bearer: undefined,
    max_turns: opts.maxTurns ?? 25,
    // Thread the idempotency key (AgentTaskExecutor sets it to the AgentRun id) so
    // CF can collapse a duplicate retry onto the in-flight run instead of starting
    // a second governed loop. Previously dropped on this path.
    idempotency_key: req.idempotency_key,
    model_alias: req.model_overrides?.modelAlias,
    ...(stageExecPolicy ? { stage_execution_policy: stageExecPolicy } : {}),
  }
}

/**
 * Map a GovernedStageResponse back to the legacy ExecuteResponse shape
 * the AgentTaskExecutor's downstream code expects. Lossy by design —
 * `turns[]` and `final_state.receipts[]` are richer than ExecuteResponse
 * carries, so we project the salient totals + a synthetic finalResponse.
 *
 * `finalResponse` is built from the receipts; the workflow doesn't
 * stream output the way the chat surface does, so the persisted
 * `agentRunOutput.rawContent` ends up being a structured digest rather
 * than a free-form completion. Operators reading agentRunOutput rows
 * still see what happened; if they need the raw turns they pull them
 * from audit-gov via the cfCallId.
 */
export function governedStageRespToExecuteResp(
  resp: GovernedStageResponse,
  opts: { traceId?: string | null; sessionId?: string | null; governanceMode?: GovernanceMode } = {},
): ExecuteResponse {
  const cfCallId = `governed:${resp.final_state.stage_key}:${resp.turns.length}`
  const governanceMode = opts.governanceMode ?? config.DEFAULT_GOVERNANCE_MODE as GovernanceMode
  // Aggregate tool_invocation_ids across all turns so the legacy
  // correlation table still gets populated (downstream code reads
  // result.correlation.toolInvocationIds).
  const toolInvocationIds: string[] = []
  for (const turn of resp.turns) {
    // Defensive: turns that haven't dispatched tools (LLM-only) won't
    // have a tool_outcomes array. Don't crash on those.
    const outcomes = Array.isArray(turn.tool_outcomes) ? turn.tool_outcomes : []
    for (const outcome of outcomes) {
      if (outcome.tool_invocation_id) toolInvocationIds.push(outcome.tool_invocation_id)
    }
  }
  const finishReason = stopReasonToFinishReason(resp.stop_reason)
  // APPROVAL_PENDING is a HUMAN-gate pause, not a completion. Mapping it to
  // COMPLETED made governed agent tasks silently skip approvalRequired gates;
  // surface it as WAITING_APPROVAL so callers (AgentTaskExecutor) pause + persist
  // the PhaseState for a governed resume. FINALIZED = done; everything else fails.
  const status = resp.stop_reason === 'FINALIZED'
    ? 'COMPLETED' as const
    : resp.stop_reason === 'APPROVAL_PENDING'
      ? 'WAITING_APPROVAL' as const
      : 'FAILED' as const
  // §13.4 piece 2 — surface the copilot_execute receipt (changed files + commit)
  // so the node artifact shows what the stage produced. It lives in
  // final_state.receipts[<phase>] with kind 'copilot_execution'.
  const copilotReceipt = (() => {
    const byPhase = (resp.final_state.receipts ?? {}) as Record<string, Array<Record<string, unknown>>>
    for (const list of Object.values(byPhase)) {
      const r = Array.isArray(list) ? list.find((x) => x && x.kind === 'copilot_execution') : undefined
      if (r) return r
    }
    return undefined
  })()
  const copilotChangedPaths = Array.isArray(copilotReceipt?.changed_paths)
    ? (copilotReceipt!.changed_paths as unknown[]).map(String)
    : []
  const copilotCommitSha = typeof copilotReceipt?.commitSha === 'string' ? copilotReceipt.commitSha as string : null
  // §13.4 — the actual produced files (REQUIREMENTS.md etc.) so the executor can
  // store each as a per-phase artifact, not just the summary.
  const copilotArtifacts = Array.isArray(copilotReceipt?.artifacts)
    ? (copilotReceipt!.artifacts as Array<Record<string, unknown>>)
        .map(a => ({ path: String(a.path ?? ''), content: String(a.content ?? '') }))
        .filter(a => a.path)
    : []
  return {
    status,
    finalResponse: synthesiseFinalResponse(resp),
    finishReason,
    stepsTaken: resp.turns.length,
    correlation: {
      cfCallId,
      traceId: opts.traceId ?? null,
      sessionId: opts.sessionId ?? null,
      promptAssemblyId: null,
      mcpServerId: null,
      mcpInvocationId: null,
      modelAlias: resp.turns.at(-1)?.llm?.model_alias ?? null,
      llmCallIds: [],
      toolInvocationIds,
      artifactIds: [],
      codeChangeIds: [],
      contextPlanHash: null,
      governanceMode,
      executionPosture: 'governed' as const,
      workspaceBranch: null,
      workspaceCommitSha: copilotCommitSha,
      changedPaths: copilotChangedPaths,
      astIndexStatus: null,
      astIndexedFiles: null,
      astIndexedSymbols: null,
    },
    modelUsage: {
      provider: resp.turns.at(-1)?.llm?.provider ?? 'unknown',
      model: resp.turns.at(-1)?.llm?.model ?? 'unknown',
      modelAlias: resp.turns.at(-1)?.llm?.model_alias ?? null,
      inputTokens: resp.totals.input_tokens,
      outputTokens: resp.totals.output_tokens,
      estimatedCost: 0,
      latencyMs: resp.turns.reduce((s, t) => s + (t.llm?.latency_ms ?? 0), 0),
    },
    tokensUsed: {
      input: resp.totals.input_tokens,
      output: resp.totals.output_tokens,
      total: resp.totals.input_tokens + resp.totals.output_tokens,
    },
    metrics: {},
    workspace: copilotReceipt
      ? { workspaceCommitSha: copilotCommitSha ?? undefined, changedPaths: copilotChangedPaths, artifacts: copilotArtifacts }
      : null,
    warnings: resp.error_message ? [resp.error_message] : [],
    pendingApproval: null,
    // Phase-level governed pause payload — the PhaseState the caller persists +
    // rehydrates on resume (only meaningful when status === WAITING_APPROVAL).
    governedFinalState: (resp.final_state as Record<string, unknown> | undefined) ?? null,
    blockedReason: resp.error_code ?? null,
    requiredContextStatus: null,
    contextPlanHash: null,
    governanceMode,
    executionPosture: 'governed' as const,
    prompt: undefined,
    verificationReceipts: [],
  } as unknown as ExecuteResponse
}

function stopReasonToFinishReason(stop: GovernedStageResponse['stop_reason']): string {
  switch (stop) {
    case 'FINALIZED': return 'stop'
    case 'APPROVAL_PENDING': return 'approval_pending'
    case 'MAX_TURNS': return 'length'
    case 'LLM_ERROR': return 'error'
    case 'VALIDATION_BLOCKED': return 'validation_blocked'
    case 'POLICY_BLOCKED': return 'policy_blocked'
    default: return 'stop'
  }
}

/**
 * Build a digest of the run for the legacy `finalResponse` slot. We
 * concatenate receipt summaries by phase — sufficient for the
 * agentRunOutput's rawContent column and for operators eyeballing the
 * run. The structured turns + receipts are recoverable from audit-gov
 * via the cfCallId.
 */
function synthesiseFinalResponse(resp: GovernedStageResponse): string {
  const lines: string[] = []
  lines.push(`# Governed stage \`${resp.final_state.stage_key}\``)
  lines.push(`final phase: ${resp.final_state.current_phase} · stop: ${resp.stop_reason} · turns: ${resp.turns.length}`)
  lines.push('')
  for (const [phase, receiptList] of Object.entries(resp.final_state.receipts ?? {})) {
    for (const receipt of receiptList) {
      if (!receipt || typeof receipt !== 'object') continue
      const r = receipt as Record<string, unknown>
      if (typeof r.summary === 'string') {
        lines.push(`## ${phase}`)
        lines.push(r.summary)
        lines.push('')
      }
    }
  }
  if (resp.error_message) {
    lines.push('')
    lines.push(`## error`)
    lines.push(resp.error_message)
  }
  return lines.join('\n')
}
