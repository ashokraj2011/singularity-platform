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
  artifacts?: unknown[]
  overrides?: Record<string, unknown>
  model_overrides?: {
    modelAlias?: string
    provider?: string
    model?: string
    temperature?: number
    maxOutputTokens?: number
  }
  context_policy?: Record<string, unknown>
  limits?: {
    maxSteps?: number
    timeoutSec?: number
    inputTokenBudget?: number
    outputTokenBudget?: number
    maxHistoryMessages?: number
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
    workspaceBranch?: string
    workspaceCommitSha?: string
    changedPaths?: string[]
    astIndexStatus?: string
    astIndexedFiles?: number
    astIndexedSymbols?: number
  }
  workspace?: {
    workspaceBranch?: string
    workspaceCommitSha?: string
    changedPaths?: string[]
    astIndexStatus?: string
    astIndexedFiles?: number
    astIndexedSymbols?: number
  }
  tokensUsed?: { input: number; output: number; total: number }
  usage?: {
    inputTokens?: number | null
    outputTokens?: number | null
    totalTokens?: number | null
    estimatedCost?: number | null
    modelAlias?: string | null
    provider?: string | null
    model?: string | null
    tokensSaved?: number | null
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
  }
  prompt?: {
    estimatedInputTokens?: number | null
    budgetWarnings?: string[]
    retrievalStats?: Record<string, unknown>
    contextPlan?: Record<string, unknown> | null
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
  async listCodeChanges(cfCallId: string): Promise<CodeChangeListResponse> {
    const url = `${config.CONTEXT_FABRIC_URL.replace(/\/$/, '')}/internal/mcp/code-changes?cf_call_id=${encodeURIComponent(cfCallId)}`
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
