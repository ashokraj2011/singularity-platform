/**
 * Context-fabric HTTP client (M8).
 *
 * Workgraph's AGENT_TASK executor calls context-fabric `/execute` instead of
 * prompt-composer (which was the M5 wire). context-fabric is now the
 * orchestrator: it composes the prompt, enriches with memory, resolves the
 * tenant's MCP server (via IAM), invokes it, persists the audit chain.
 *
 * Returns a unified response with seven correlation IDs:
 *   cfCallId, traceId, sessionId, promptAssemblyId,
 *   mcpServerId, mcpInvocationId, plus llm/tool/artifact arrays.
 */

import { config } from '../../config'

export interface ExecuteRunContext {
  workflow_instance_id?: string
  workflow_node_id?: string
  agent_run_id?: string
  work_item_id?: string
  work_item_code?: string
  capability_id: string
  tenant_id?: string
  agent_template_id?: string
  user_id?: string
  trace_id?: string
  branch_base?: string
  branch_name?: string
  source_type?: string
  source_uri?: string
  source_ref?: string
}

export interface ExecuteRequest {
  trace_id?: string
  idempotency_key?: string
  run_context: ExecuteRunContext
  system_prompt?: string
  task: string
  vars?: Record<string, unknown>
  globals?: Record<string, unknown>
  prior_outputs?: Record<string, unknown>
  // M66 — Receipts from previously-completed stages in a multi-stage
  // Blueprint Workbench workflow. Caller (blueprint.router) accumulates
  // receipts from each runCodingStage result and threads the union into
  // every subsequent stage so finish_work_branch's formal verifier sees the
  // verification evidence. Empty/omitted for the first stage.
  prior_verification_receipts?: Array<Record<string, unknown>>
  artifacts?: unknown[]
  overrides?: Record<string, unknown>
  model_overrides?: {
    modelAlias?: string
    provider?: string
    model?: string
    temperature?: number
    maxOutputTokens?: number
    promptCache?: {
      enabled?: boolean
      strategy?: string
      key?: string
    }
  }
  context_policy?: Record<string, unknown>
  limits?: {
    maxSteps?: number
    timeoutSec?: number
    inputTokenBudget?: number
    outputTokenBudget?: number
    maxHistoryMessages?: number
    maxHistoryTokens?: number
    summaryEveryMessages?: number
    compressToolResults?: boolean
    maxToolResultChars?: number
    maxPromptChars?: number
  }
  preview_only?: boolean
  allow_autonomous_mutation?: boolean
  // M26 — when true, require the calling user's laptop mcp-server (via the
  // context-fabric laptop-bridge). When false, force the shared HTTP mcp.
  // When unset, cf auto-prefers laptop if a connection exists for the user.
  prefer_laptop?: boolean
  governance_mode?: 'fail_open' | 'fail_closed' | 'degraded' | 'human_approval_required'
}

export interface PendingApproval {
  continuation_token: string
  tool_name: string
  tool_args: Record<string, unknown>
  tool_descriptor: {
    name: string
    description?: string
    input_schema?: Record<string, unknown>
    execution_target?: string
    risk_level?: string
  }
}

export interface ExecuteResponse {
  status: 'COMPLETED' | 'WAITING_APPROVAL' | 'FAILED' | string
  finalResponse: string
  correlation: {
    cfCallId: string
    traceId: string
    sessionId: string
    promptAssemblyId?: string
    mcpServerId?: string
    mcpInvocationId?: string
    modelAlias?: string
    contextPlanHash?: string
    governanceMode?: string
    executionPosture?: string
    llmCallIds: string[]
    toolInvocationIds: string[]
    artifactIds: string[]
    codeChangeIds?: string[]
    verificationReceipts?: Array<Record<string, unknown>>
    workspaceRoot?: string
    workspaceBranch?: string
    workspaceCommitSha?: string
    changedPaths?: string[]
    astIndexStatus?: string
    astIndexedFiles?: number
    astIndexedSymbols?: number
  }
  workspace?: {
    workspaceRoot?: string
    workspaceBranch?: string
    workspaceCommitSha?: string
    changedPaths?: string[]
    astIndexStatus?: string
    astIndexedFiles?: number
    astIndexedSymbols?: number
  }
  verificationReceipts?: Array<Record<string, unknown>>
  tokensUsed?: {
    input: number
    output: number
    total: number
    estimatedCost?: number
    estimated_cost?: number
    promptCache?: Record<string, unknown>
  }
  usage?: {
    inputTokens?: number | null
    outputTokens?: number | null
    totalTokens?: number | null
    estimatedCost?: number | null
    modelAlias?: string | null
    provider?: string | null
    model?: string | null
    tokensSaved?: number | null
    promptCache?: Record<string, unknown> | null
    promptAssemblyId?: string | null
    cfCallId?: string | null
  }
  modelUsage?: {
    modelAlias?: string | null
    provider?: string | null
    model?: string | null
    inputTokens?: number | null
    outputTokens?: number | null
    totalTokens?: number | null
    estimatedCost?: number | null
    promptCache?: Record<string, unknown> | null
  }
  promptCache?: Record<string, unknown> | null
  prompt?: {
    estimatedInputTokens?: number | null
    budgetWarnings?: string[]
    retrievalStats?: Record<string, unknown>
    contextPlan?: Record<string, unknown> | null
    promptCache?: Record<string, unknown> | null
  }
  contextPlanHash?: string | null
  requiredContextStatus?: Record<string, unknown> | null
  governanceMode?: string | null
  executionPosture?: string | null
  blockedReason?: string | null
  finishReason?: string
  stepsTaken?: number
  metrics?: { mcpLatencyMs?: number }
  warnings?: string[]
  pendingApproval?: PendingApproval | null
}

export interface ResumeRequest {
  cf_call_id?: string
  continuation_token?: string
  decision: 'approved' | 'rejected'
  reason?: string
  args_override?: Record<string, unknown>
}

// M71 Slice F — Governed-stage request shape. Mirrors the GovernedStageRequest
// Pydantic model in context-fabric's execute.py.
export interface GovernedStageRequest {
  stage_key: string
  agent_role?: string
  phase_state?: Record<string, unknown> | null
  vars?: Record<string, unknown>
  initial_history?: unknown[]
  model_alias?: string
  // M100 — per-phase model override. Maps a governed Phase value
  // (PLAN/EXPLORE/ACT/VERIFY/REPAIR/SELF_REVIEW/FINALIZE) → model alias.
  // The current phase's entry wins over `model_alias`; unset/unknown phases
  // fall back to `model_alias`, then the gateway default. Omitted = the
  // single-model-per-stage behavior (back-compat). Mirrors the
  // GovernedStageRequest.phase_model_aliases field in context-fabric.
  phase_model_aliases?: Record<string, string>
  bearer?: string
  run_context?: Record<string, unknown>
  // Safety cap on LLM turns; defaults to context-fabric's DEFAULT_MAX_TURNS (25).
  max_turns?: number
  // Wall-clock budget for the entire CF execute call. Drives the HTTP
  // client AbortSignal here, and (when honored on the server) the
  // per-stage deadline inside context-fabric's loop driver. Unset =
  // the 15-minute envelope below. The blueprint router computes this
  // via resolveStageTimeoutSec() so workflow-declared
  // `stage.limits.timeoutSec` wins over the role-class default.
  timeout_sec?: number
  // M91.A (2026-05-27) — Workflow-resolved stage execution policy.
  // Mirrors the StageExecutionPolicy Pydantic model on the CF side.
  // CF uses this as an override layer on top of the DB-seeded
  // StagePolicy: per-phase allowed_tools are filtered by tool_policy
  // / repo_access. Optional — omitting it falls back to the seeded
  // base policy verbatim.
  stage_execution_policy?: StageExecutionPolicy
  // Capability Governance Model (G4) — resolved governance overlay + active
  // waiver controlKeys for this run. When the overlay is BLOCKING/REQUIRED, the
  // CF enforcement gate halts promotion with stop_reason=GOVERNANCE_BLOCKED
  // unless controls are satisfied or waived. Populated by the executor from
  // resolveGovernance() + activeWaiverControlKeys(); omitted ⇒ no enforcement.
  governance_overlay?: Record<string, unknown>
  governance_waivers?: string[]
}

// M91.A — workflow's resolved stage intent. Built by blueprint.router
// from workflow_design_nodes.config + workflow defaults at the moment
// of stage spawn, shipped to CF as runtime authority on tool exposure.
export interface StageExecutionPolicy {
  stage_key: string
  agent_role?: string
  context_policy?: string
  tool_policy?: string
  repo_access?: boolean
  prompt_profile_key?: string
  approval_required?: boolean
  // M99 — Phase 0 automation flags. CF reads these (snake_case; it also
  // accepts the camelCase aliases) and gates each automation on BOTH its env
  // flag AND the matching policy flag. Omitted → CF's env-flag default.
  auto_localize?: boolean
  auto_baseline?: boolean
  auto_verify?: boolean
  git_preflight_required?: boolean
}

// M71 Slice F — Governed-stage response shape. Mirrors StageRunResult.to_dict()
// in context-fabric. The adapter in coding-agent/orchestrator.ts maps this
// into the existing CodingRunResult so the rest of workgraph-api doesn't
// change shape.
export interface GovernedStageToolOutcome {
  tool_name: string
  phase: string
  allowed: boolean
  refusal_reason: string | null
  allowed_tools: string[]
  // The tool's dispatched result envelope (whatever /mcp/tool-run returned).
  // Null on refusal or dispatch_error.
  result: unknown
  duration_ms: number
  tool_invocation_id: string | null
  tool_success: boolean | null
  tool_error: string | null
  dispatch_error: string | null
}

export interface GovernedStageTurn {
  turn_index: number
  from_phase: string
  to_phase: string
  phase_advanced: boolean
  tool_outcomes: GovernedStageToolOutcome[]
  validation_error: Record<string, unknown> | null
  llm: {
    content?: string
    finish_reason?: string
    input_tokens?: number
    output_tokens?: number
    latency_ms?: number
    provider?: string
    model?: string
    model_alias?: string | null
    estimated_cost?: number | null
    tool_call_count?: number
  }
  prompt: {
    binding_id?: string
    prompt_profile_id?: string
    phase_used?: string | null
    stage_key?: string
    agent_role?: string | null
  }
}

export interface GovernedStageResponse {
  final_state: {
    stage_key: string
    agent_role: string | null
    current_phase: string
    repair_attempts: number
    receipts: Record<string, Array<Record<string, unknown>>>
    history: Array<Record<string, unknown>>
    approval_pending: boolean
  }
  turns: GovernedStageTurn[]
  stop_reason: 'FINALIZED' | 'APPROVAL_PENDING' | 'VALIDATION_BLOCKED' | 'POLICY_BLOCKED' | 'MAX_TURNS' | 'LLM_ERROR' | ''
  error_code: string | null
  error_message: string | null
  totals: {
    input_tokens: number
    output_tokens: number
    tool_calls: number
    tools_refused: number
  }
}

export interface CodeChangeRecord {
  id: string
  tool_name?: string
  paths_touched?: string[]
  diff?: string
  patch?: string
  commit_sha?: string
  language?: string
  lines_added?: number
  lines_removed?: number
  timestamp?: string
  stale?: boolean
}

export interface CodeChangeListResponse {
  cfCallId: string
  items: CodeChangeRecord[]
  stale: boolean
}

export class ContextFabricError extends Error {
  constructor(
    message: string,
    public status: number,
    public detail?: unknown,
  ) {
    super(message)
  }
}

export const contextFabricClient = {
  async execute(input: ExecuteRequest): Promise<ExecuteResponse> {
    const url = `${config.CONTEXT_FABRIC_URL.replace(/\/$/, '')}/execute`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout((input.limits?.timeoutSec ?? 240) * 1000 + 10_000),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      // FastAPI returns structured errors as { detail: { code, message, ... } }.
      // Parse so callers (M26 AgentTaskExecutor) can branch on err.detail.code.
      let parsedDetail: unknown
      try {
        const obj = JSON.parse(text) as { detail?: unknown }
        parsedDetail = obj?.detail
      } catch { /* leave undefined */ }
      throw new ContextFabricError(
        `context-fabric /execute returned ${res.status}: ${text.slice(0, 500)}`,
        res.status,
        parsedDetail,
      )
    }
    return (await res.json()) as ExecuteResponse
  },

  // M13 — fetch all code-changes captured by a single cf execute call.
  // Hits /internal/mcp/code-changes which joins the persisted call_log row
  // to the live MCP `/resources/code-changes` records.
  async listCodeChanges(cfCallId: string, options?: { codeChangeIds?: string[]; mcpServerId?: string | null }): Promise<CodeChangeListResponse> {
    const params = new URLSearchParams({ cf_call_id: cfCallId })
    if (options?.codeChangeIds?.length) params.set('ids', options.codeChangeIds.join(','))
    if (options?.mcpServerId) params.set('mcp_server_id', options.mcpServerId)
    const url = `${config.CONTEXT_FABRIC_URL.replace(/\/$/, '')}/internal/mcp/code-changes?${params.toString()}`
    const res = await fetch(url, {
      method:  'GET',
      headers: { 'X-Service-Token': config.CONTEXT_FABRIC_SERVICE_TOKEN ?? '' },
      signal:  AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new ContextFabricError(
        `context-fabric /internal/mcp/code-changes returned ${res.status}: ${text.slice(0, 300)}`,
        res.status,
      )
    }
    return (await res.json()) as CodeChangeListResponse
  },

  // M71 Slice F — Multi-turn governed stage driver.
  //
  // Calls context-fabric's POST /api/v1/execute-governed-stage which loops
  // LLM turns server-side until the stage finalizes or hits human approval.
  // mcp-server's old /invoke is bypassed entirely; tool dispatch goes
  // through /mcp/tool-run with hard-refuse policy enforcement.
  async executeGovernedStage(input: GovernedStageRequest): Promise<GovernedStageResponse> {
    const url = `${config.CONTEXT_FABRIC_URL.replace(/\/$/, '')}/api/v1/execute-governed-stage`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
      // Per-stage budget when the caller declared one (workflow node's
      // `stage.limits.timeoutSec`), with a 30s buffer so the server has
      // room to format its terminal response after its own internal
      // deadline fires. Falls back to a 15-minute envelope when the
      // caller didn't supply a value. workgraph-api enforces its own
      // per-attempt budget upstream; this is the HTTP-level safety net.
      signal: AbortSignal.timeout(
        input.timeout_sec && input.timeout_sec > 0
          ? input.timeout_sec * 1000 + 30_000
          : 900_000,
      ),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      let parsedDetail: unknown
      try {
        const obj = JSON.parse(text) as { detail?: unknown }
        parsedDetail = obj?.detail
      } catch { /* leave undefined */ }
      throw new ContextFabricError(
        `context-fabric /execute-governed-stage returned ${res.status}: ${text.slice(0, 500)}`,
        res.status,
        parsedDetail,
      )
    }
    const json = (await res.json()) as { success: boolean; data: GovernedStageResponse }
    if (!json.success) {
      throw new ContextFabricError('context-fabric returned success=false', 502, json)
    }
    return json.data
  },

  async resume(input: ResumeRequest): Promise<ExecuteResponse> {
    const url = `${config.CONTEXT_FABRIC_URL.replace(/\/$/, '')}/execute/resume`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(250_000),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new ContextFabricError(
        `context-fabric /execute/resume returned ${res.status}: ${text.slice(0, 500)}`,
        res.status,
      )
    }
    return (await res.json()) as ExecuteResponse
  },
}
