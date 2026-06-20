import { type WorkflowInstance, type WorkflowNode } from '@prisma/client'
import { config } from '../../../../config'
import { redactSecrets } from '../../../../lib/redact'
import { requestOperationalMcpToolGrant } from './mcpToolGrant'

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
    const toolGrant = await requestOperationalMcpToolGrant({
      toolName: 'run_python',
      args: toolArgs,
      runContext,
      workflowPolicy: {
        nodeType: 'RUN_PYTHON',
        allowNetwork,
      },
    })
    const response = await fetch(`${config.MCP_SERVER_URL.replace(/\/$/, '')}/mcp/tool-run`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.MCP_BEARER_TOKEN}`,
      },
      // No source* fields → tool-run skips materialisation = isolated empty sandbox.
      // workflowInstanceId + nodeId key the sandbox per instance (not shared /workspace).
      body: JSON.stringify({
        tool_name: 'run_python',
        args: toolArgs,
        run_context: runContext,
        ...(toolGrant ? { tool_grant: toolGrant } : {}),
      }),
      signal: AbortSignal.timeout(timeoutMs + 10_000),
    })
    const text = await response.text()
    const body = (text ? JSON.parse(text) : {}) as {
      success?: boolean
      data?: { result?: unknown; toolSuccess?: boolean; toolError?: string | null }
      error?: { message?: string } | string
    }
    if (!response.ok || body.success === false) {
      const msg = typeof body.error === 'string' ? body.error : body.error?.message ?? `tool-run returned ${response.status}`
      return fail('RUN_PYTHON_DISPATCH_FAILED', `run_python dispatch failed: ${msg}`)
    }
    const result = body.data?.result
    if (!isRecord(result)) {
      const toolErr = body.data?.toolError
      return fail('RUN_PYTHON_DISPATCH_FAILED', `run_python returned no receipt${toolErr ? `: ${toolErr}` : ''}`)
    }
    receipt = result
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
