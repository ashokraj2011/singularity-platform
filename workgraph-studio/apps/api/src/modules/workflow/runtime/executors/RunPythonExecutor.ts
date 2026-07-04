import { type WorkflowInstance, type WorkflowNode } from '@prisma/client'
import { config } from '../../../../config'
import { redactSecrets } from '../../../../lib/redact'
import { requestOperationalMcpToolGrant } from './mcpToolGrant'
import { readUpstreamJsonBody, upstreamSnippet } from '../../../../lib/upstream-json'

/**
 * RUN_PYTHON executor — runs an inline Python program in the mcp-server sandbox.
 *
 * Contract mirrors EvalGate/PolicyCheck: returns { passed, output }; the
 * WorkflowRuntime dispatcher advances on pass and failNode()s on fail. The node
 * runs in an ISOLATED empty sandbox (we omit sourceUri so tool-run skips
 * source materialisation) and only opts into outbound network when configured.
 */

type RunPythonOutput = {
  runPython: {
    exitCode: number | null
    passed: boolean
    stdout: string
    stderr: string
    timedOut: boolean
    durationMs?: number
    networkMode?: string
    runnerReceiptId?: string
    error?: string
    code?: string
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function cfgValue(node: WorkflowNode, key: string): unknown {
  const cfg = isRecord(node.config) ? node.config : {}
  const standard = isRecord(cfg.standard) ? cfg.standard : {}
  return cfg[key] ?? standard[key]
}

function cfgString(node: WorkflowNode, key: string): string | undefined {
  const value = cfgValue(node, key)
  return typeof value === 'string' && value.trim() ? value : undefined
}

function cfgNumber(node: WorkflowNode, key: string, fallback: number): number {
  const value = cfgValue(node, key)
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(n) ? n : fallback
}

function cfgBool(node: WorkflowNode, key: string, fallback: boolean): boolean {
  const value = cfgValue(node, key)
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return value.trim().toLowerCase() === 'true'
  return fallback
}

function cfgStringArray(node: WorkflowNode, key: string): string[] {
  const value = cfgValue(node, key)
  if (Array.isArray(value)) return value.map(String)
  if (typeof value === 'string' && value.trim()) {
    return value.split(/[\n,]/).map(s => s.trim()).filter(Boolean)
  }
  return []
}

function parseEnv(node: WorkflowNode): { env: Record<string, string> } | { error: string } {
  const raw = cfgValue(node, 'env')
  if (raw == null || raw === '') return { env: {} }
  let obj: unknown = raw
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw)
    } catch {
      return { error: 'env must be valid JSON (an object of string→string)' }
    }
  }
  if (!isRecord(obj)) return { error: 'env must be a JSON object of string→string' }
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(obj)) env[k] = String(v)
  return { env }
}

function fail(code: string, error: string): { passed: false; output: RunPythonOutput } {
  return {
    passed: false,
    output: { runPython: { exitCode: null, passed: false, stdout: '', stderr: '', timedOut: false, error, code } },
  }
}

type DispatchResult = { receipt: Record<string, unknown> } | { error: string }
type ToolRunPayload = {
  tool_name: string
  args: Record<string, unknown>
  run_context: Record<string, unknown>
  grant?: unknown
}

async function parseToolRunBody(response: Response, source: string): Promise<{ body: Record<string, unknown> } | { error: string }> {
  const parsed = await readUpstreamJsonBody(response)
  if (!parsed.raw.trim()) return { body: {} }
  if (parsed.parseError) {
    return { error: `${source} returned invalid JSON (${parsed.parseError}): ${upstreamSnippet(parsed.raw, 700)}` }
  }
  if (isRecord(parsed.data)) return { body: parsed.data }
  return { error: `${source} returned a non-object response body` }
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

// Prefer Context Fabric runtime dispatch so a laptop/remote MCP that only dials
// into CF still runs the tool; fall back to direct mcp-server HTTP (debug /
// back-compat) only when CF is unconfigured, unreachable, or refuses the dispatch.
async function dispatchToolRun(payload: ToolRunPayload, timeoutMs: number): Promise<DispatchResult> {
  const cfUrl = config.CONTEXT_FABRIC_URL?.replace(/\/$/, '')
  if (cfUrl) {
    try {
      const resp = await fetch(`${cfUrl}/api/runtime-bridge/tool-run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Service-Token': config.CONTEXT_FABRIC_SERVICE_TOKEN ?? '' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs + 10_000),
      })
      if (resp.ok) {
        const parsed = await parseToolRunBody(resp, 'Context Fabric runtime bridge')
        if ('error' in parsed) return { error: parsed.error }
        const body = parsed.body
        const toolError = stringField(body.tool_error)
        if (body.tool_success === false) return { error: `run_python failed${toolError ? `: ${toolError}` : ''}` }
        if (isRecord(body.result)) return { receipt: body.result }
        return { error: `run_python returned no receipt${toolError ? `: ${toolError}` : ''}` }
      }
      // CF reachable but refused/failed the dispatch — fall through to mcp HTTP.
    } catch {
      // CF unreachable — fall through to mcp HTTP.
    }
  }
  return dispatchToolRunViaMcp(payload, timeoutMs)
}

// Direct mcp-server HTTP — the legacy transport, now a fallback.
async function dispatchToolRunViaMcp(payload: ToolRunPayload, timeoutMs: number): Promise<DispatchResult> {
  const { grant, ...rest } = payload
  let response: Response
  try {
    response = await fetch(`${config.MCP_SERVER_URL.replace(/\/$/, '')}/mcp/tool-run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.MCP_BEARER_TOKEN}` },
      body: JSON.stringify({ ...rest, ...(grant ? { tool_grant: grant } : {}) }),
      signal: AbortSignal.timeout(timeoutMs + 10_000),
    })
  } catch (err) {
    return { error: `run_python dispatch failed: MCP tool-run unreachable: ${(err as Error).message}` }
  }
  const parsed = await parseToolRunBody(response, 'MCP tool-run')
  if ('error' in parsed) return { error: `run_python dispatch failed: ${parsed.error}` }
  const body = parsed.body
  const data = isRecord(body.data) ? body.data : {}
  const errorObject = isRecord(body.error) ? body.error : null
  const errorText = typeof body.error === 'string'
    ? body.error
    : stringField(errorObject?.message)
  const success = body.success === undefined ? response.ok : body.success === true
  if (!response.ok || !success) {
    const msg = errorText ?? `tool-run returned ${response.status}`
    return { error: `run_python dispatch failed: ${msg}` }
  }
  const result = data.result
  if (!isRecord(result)) {
    const toolErr = stringField(data.toolError)
    return { error: `run_python returned no receipt${toolErr ? `: ${toolErr}` : ''}` }
  }
  return { receipt: result }
}

export async function activateRunPython(
  node: WorkflowNode,
  instance: WorkflowInstance,
  _actorId?: string,
): Promise<{ passed: boolean; output: RunPythonOutput }> {
  const code = cfgString(node, 'code')
  if (!code) return fail('RUN_PYTHON_NO_CODE', 'RUN_PYTHON node has no `code` to run')

  const envResult = parseEnv(node)
  if ('error' in envResult) return fail('RUN_PYTHON_BAD_ENV', envResult.error)

  const scriptArgs = cfgStringArray(node, 'args')
  const timeoutMs = Math.min(Math.max(cfgNumber(node, 'timeoutMs', 120_000), 1), 600_000)
  const allowNetwork = cfgBool(node, 'allowNetwork', false)
  const failOnNonZero = cfgBool(node, 'failOnNonZero', true)
  const toolArgs = {
    code,
    args: scriptArgs,
    env: envResult.env,
    timeout_ms: timeoutMs,
    allow_network: allowNetwork,
    max_output_chars: 12_000,
  }
  const runContext = {
    traceId: `run-python-${instance.id}-${node.id}`,
    runId: instance.id,
    workflowInstanceId: instance.id,
    nodeId: node.id,
  }

  let receipt: Record<string, unknown>
  try {
    // run_python is not a git operation, so only the grant is used here; the
    // broker never mints a gitCredential for it (see _GIT_TOOL_OPERATIONS in CF).
    const { grant: toolGrant } = await requestOperationalMcpToolGrant({
      toolName: 'run_python',
      args: toolArgs,
      runContext,
      workflowPolicy: {
        nodeType: 'RUN_PYTHON',
        allowNetwork,
      },
    })
    // Route through Context Fabric (laptop/remote-MCP dial-in aware); falls back
    // to direct mcp-server HTTP. No source* fields → isolated empty sandbox;
    // workflowInstanceId + nodeId key the sandbox per instance.
    const dispatched = await dispatchToolRun(
      {
        tool_name: 'run_python',
        args: toolArgs,
        run_context: runContext,
        ...(toolGrant ? { grant: toolGrant } : {}),
      },
      timeoutMs,
    )
    if ('error' in dispatched) {
      return fail('RUN_PYTHON_DISPATCH_FAILED', dispatched.error)
    }
    receipt = dispatched.receipt
  } catch (err) {
    return fail('RUN_PYTHON_DISPATCH_FAILED', `run_python dispatch error: ${(err as Error).message}`)
  }

  const exitCode = typeof receipt.exit_code === 'number' ? receipt.exit_code : null
  const timedOut = receipt.timed_out === true
  const ok = !failOnNonZero || (exitCode === 0 && !timedOut)

  const output: RunPythonOutput = {
    runPython: redactSecrets({
      exitCode,
      passed: ok,
      stdout: typeof receipt.stdout_excerpt === 'string' ? receipt.stdout_excerpt : '',
      stderr: typeof receipt.stderr_excerpt === 'string' ? receipt.stderr_excerpt : '',
      timedOut,
      durationMs: typeof receipt.duration_ms === 'number' ? receipt.duration_ms : undefined,
      networkMode: typeof receipt.network_mode === 'string' ? receipt.network_mode : undefined,
      runnerReceiptId: typeof receipt.runner_receipt_id === 'string' ? receipt.runner_receipt_id : undefined,
    }),
  }
  return { passed: ok, output }
}
