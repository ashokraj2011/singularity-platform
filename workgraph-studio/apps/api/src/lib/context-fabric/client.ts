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
  capability_id: string
  agent_template_id?: string
  user_id?: string
  trace_id?: string
}

export interface ExecuteRequest {
  trace_id?: string
  idempotency_key?: string
  run_context: ExecuteRunContext
  task: string
  vars?: Record<string, unknown>
  globals?: Record<string, unknown>
  prior_outputs?: Record<string, unknown>
  artifacts?: unknown[]
  overrides?: Record<string, unknown>
  model_overrides?: {
    provider?: string
    model?: string
    temperature?: number
    maxOutputTokens?: number
  }
  context_policy?: Record<string, unknown>
  limits?: { maxSteps?: number; timeoutSec?: number }
  preview_only?: boolean
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
    llmCallIds: string[]
    toolInvocationIds: string[]
    artifactIds: string[]
  }
  tokensUsed?: { input: number; output: number; total: number }
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
      throw new ContextFabricError(
        `context-fabric /execute returned ${res.status}: ${text.slice(0, 500)}`,
        res.status,
      )
    }
    return (await res.json()) as ExecuteResponse
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
