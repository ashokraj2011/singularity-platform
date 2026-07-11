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

import { Agent } from 'undici'
import { config } from '../../config'
import { tracingHeaders } from '../observability/http-trace'
import { isJsonObject, readUpstreamJsonBody, upstreamSnippet, type UpstreamJsonBody } from '../upstream-json'

// undici (Node's built-in fetch) enforces its own default headers/body timeouts
// (~300s) PER CONNECTION, independent of the fetch AbortSignal. A governed stage
// is one long synchronous request — Context Fabric returns no response bytes
// until the whole agent loop finishes — so DEVELOP (now running a full pre-edit
// `mvn test` baseline + the agent loop + post-edit verification) routinely
// exceeds 300s and undici severs the socket, surfacing as a bare `fetch failed`
// while CF actually completes the work. Disable undici's internal timeouts
// (0 = no timeout) so the explicit `AbortSignal.timeout(...)` envelope below is
// the single authoritative deadline.
const longCallDispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 })

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
  workitem_branch?: string
  source_type?: string
  source_uri?: string
  source_ref?: string
  // §13.4 — when 'copilot', CF dispatches the copilot_execute tool to mcp-server
  // (laptop-routed) instead of running the function-calling loop. `task` rides
  // here too so the governed-stage route (no top-level task) can read it.
  executor?: string
  task?: string
  // Explicit opt-in for Context Fabric to call a provider directly. This is
  // intentionally separate from WorkGraph's `llmRoute: workgraph` path.
  llm_route?: 'context_fabric_direct'
  direct_llm?: {
    provider?: string
    model?: string
    base_url?: string
    credential_env?: string
  }
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
  // Governed path only — the PhaseState dict from a stage that paused at the
  // approval gate (status WAITING_APPROVAL via APPROVAL_PENDING). The caller
  // persists it so the resume can rehydrate + apply the decision. The governed
  // pause is phase-level (not a tool pause), so pendingApproval stays null.
  governedFinalState?: Record<string, unknown> | null
}

export interface ResumeRequest {
  cf_call_id?: string
  continuation_token?: string
  decision: 'approved' | 'rejected'
  reason?: string
  args_override?: Record<string, unknown>
}

// Governed single-turn request — mirrors GovernedTurnRequest in execute.py.
// The caller supplies the prompt VERBATIM (system_prompt + task); CF runs ONE
// gateway turn with no per-phase re-assembly. Returns an ExecuteResponse.
export interface GovernedTurnRequest {
  trace_id?: string
  idempotency_key?: string
  run_context?: Record<string, unknown>
  system_prompt?: string
  task: string
  model_overrides?: {
    modelAlias?: string
    provider?: string
    model?: string
    expectedProvider?: string
    expectedModel?: string
    temperature?: number
    maxOutputTokens?: number
  }
  limits?: { outputTokenBudget?: number; timeoutSec?: number }
  governance_overlay?: Record<string, unknown>
  governance_waivers?: string[]
  governance_mode?: 'fail_open' | 'fail_closed' | 'degraded' | 'human_approval_required'
}

// M71 Slice F — Governed-stage request shape. Mirrors the GovernedStageRequest
// Pydantic model in context-fabric's execute.py.
export interface GovernedStageRequest {
  stage_key: string
  agent_role?: string
  phase_state?: Record<string, unknown> | null
  // Phase 3 — approval-gate resume. With phase_state, a decision drives
  // SELF_REVIEW→FINALIZE (approved) / →REPAIR (rejected/changes_requested);
  // reason surfaces as eval_feedback. Omitted ⇒ plain run/continuation.
  decision?: string
  reason?: string
  args_override?: Record<string, unknown>
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
  // Laptop bridge requirement (parity with legacy /execute). true ⇒ the governed
  // stage must run on the user's laptop mcp-server; CF returns 503 MCP_NOT_CONNECTED
  // if no live bridge. Also honoured via run_context.prefer_laptop.
  prefer_laptop?: boolean
  // Correlation/dedup passthrough — shape parity with the legacy ExecuteRequest.
  idempotency_key?: string
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
    llm_route?: 'context-fabric-direct' | 'gateway-or-runtime' | string
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

type ContextFabricBody = UpstreamJsonBody

async function readContextFabricBody(res: Response): Promise<ContextFabricBody> {
  return readUpstreamJsonBody(res)
}

function contextFabricDetail(body: ContextFabricBody): unknown {
  if (isJsonObject(body.data) && 'detail' in body.data) return body.data.detail
  if (body.parseError) return { body: upstreamSnippet(body.raw, 500), parseError: body.parseError }
  return body.data
}

function contextFabricMessage(path: string, status: number, body: ContextFabricBody, max = 500): string {
  const text = body.raw.trim() || (typeof body.data === 'string' ? body.data : '')
  return `context-fabric ${path} returned ${status}: ${upstreamSnippet(text, max) || 'empty response body'}`
}

async function readContextFabricJson<T>(res: Response, path: string): Promise<T> {
  const body = await readContextFabricBody(res)
  if (!res.ok) {
    throw new ContextFabricError(
      contextFabricMessage(path, res.status, body),
      res.status,
      contextFabricDetail(body),
    )
  }
  if (body.parseError) {
    throw new ContextFabricError(
      `context-fabric ${path} returned invalid JSON (${body.parseError}): ${upstreamSnippet(body.raw, 500) || 'empty response body'}`,
      502,
      contextFabricDetail(body),
    )
  }
  return body.data as T
}

export function contextFabricServiceHeaders(baseHeaders: Record<string, string> = {}): Record<string, string> {
  return config.CONTEXT_FABRIC_SERVICE_TOKEN
    ? { ...baseHeaders, 'X-Service-Token': config.CONTEXT_FABRIC_SERVICE_TOKEN }
    : baseHeaders
}

export const contextFabricClient = {
  async execute(input: ExecuteRequest): Promise<ExecuteResponse> {
    const url = `${config.CONTEXT_FABRIC_URL.replace(/\/$/, '')}/execute`
    const res = await fetch(url, {
      method: 'POST',
      headers: tracingHeaders(contextFabricServiceHeaders({ 'content-type': 'application/json' }), input.trace_id ?? input.run_context.trace_id),
      body: JSON.stringify(input),
      dispatcher: longCallDispatcher,
      signal: AbortSignal.timeout((input.limits?.timeoutSec ?? 240) * 1000 + 10_000),
    } as RequestInit & { dispatcher: Agent })
    return readContextFabricJson<ExecuteResponse>(res, '/execute')
  },

  // Governed VERBATIM single-turn execution — POST /api/v1/execute-governed-single-turn.
  // One LLM turn with the caller's prompt VERBATIM (no phase machine, no
  // per-phase re-assembly) wrapped in the governed audit trail + 'governed'
  // posture. For single-shot callers that already hold their assembled/frozen
  // prompt (event-horizon chat, prompt-composer respond, contracts replay) and
  // must NOT be re-assembled. Distinct from /api/v1/execute-governed-turn (the
  // phase-machine single turn). Returns the same ExecuteResponse shape as /execute.
  async executeGovernedTurn(input: GovernedTurnRequest): Promise<ExecuteResponse> {
    const url = `${config.CONTEXT_FABRIC_URL.replace(/\/$/, '')}/api/v1/execute-governed-single-turn`
    const res = await fetch(url, {
      method: 'POST',
      headers: tracingHeaders(contextFabricServiceHeaders({ 'content-type': 'application/json' }), input.trace_id),
      body: JSON.stringify(input),
      dispatcher: longCallDispatcher,
      signal: AbortSignal.timeout((input.limits?.timeoutSec ?? 240) * 1000 + 10_000),
    } as RequestInit & { dispatcher: Agent })
    return readContextFabricJson<ExecuteResponse>(res, '/execute-governed-single-turn')
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
      headers: tracingHeaders(contextFabricServiceHeaders()),
      signal:  AbortSignal.timeout(15_000),
    })
    return readContextFabricJson<CodeChangeListResponse>(res, '/internal/mcp/code-changes')
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
      headers: tracingHeaders(contextFabricServiceHeaders({ 'content-type': 'application/json' }), input.run_context?.trace_id as string | undefined),
      body: JSON.stringify(input),
      // undici's default ~300s headers/body timeout would sever this long
      // synchronous call before CF responds; longCallDispatcher disables it so
      // the AbortSignal below is the authoritative deadline.
      dispatcher: longCallDispatcher,
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
    } as RequestInit & { dispatcher: Agent })
    const json = await readContextFabricJson<{ success: boolean; data: GovernedStageResponse }>(
      res,
      '/execute-governed-stage',
    )
    if (!json.success) {
      throw new ContextFabricError('context-fabric returned success=false', 502, json)
    }
    return json.data
  },

  async resume(input: ResumeRequest): Promise<ExecuteResponse> {
    const url = `${config.CONTEXT_FABRIC_URL.replace(/\/$/, '')}/execute/resume`
    const res = await fetch(url, {
      method: 'POST',
      headers: tracingHeaders(contextFabricServiceHeaders({ 'content-type': 'application/json' })),
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(250_000),
    })
    return readContextFabricJson<ExecuteResponse>(res, '/execute/resume')
  },
}
