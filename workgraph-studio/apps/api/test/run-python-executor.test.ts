/**
 * Unit tests for the RUN_PYTHON executor (activateRunPython).
 *
 * The executor returns { passed, output }; the WorkflowRuntime dispatcher
 * advances on pass and failNode()s on fail. We stub global fetch (the call to
 * mcp-server /mcp/tool-run) so no real sandbox is needed, and assert: config
 * parsing, the isolated-sandbox run_context (no source* fields), and the
 * fail-on-nonzero semantics.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest'
import { activateRunPython } from '../src/modules/workflow/runtime/executors/RunPythonExecutor'

type AnyNode = Parameters<typeof activateRunPython>[0]
type AnyInstance = Parameters<typeof activateRunPython>[1]

function node(standard: Record<string, unknown>): AnyNode {
  return { id: 'node-1', config: { standard } } as unknown as AnyNode
}
const instance = { id: 'inst-1' } as unknown as AnyInstance

function mockToolRun(result: Record<string, unknown>, status = 200, success = true) {
  ;(global.fetch as Mock).mockResolvedValue(
    new Response(JSON.stringify({ result, tool_success: success, tool_error: success ? null : 'boom' }), { status }),
  )
}

beforeEach(() => { vi.stubGlobal('fetch', vi.fn()) })
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('activateRunPython', () => {
  it('fails with RUN_PYTHON_NO_CODE when no code is configured', async () => {
    const res = await activateRunPython(node({}), instance)
    expect(res.passed).toBe(false)
    expect(res.output.runPython.code).toBe('RUN_PYTHON_NO_CODE')
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('fails with RUN_PYTHON_BAD_ENV on invalid env JSON', async () => {
    const res = await activateRunPython(node({ code: 'print(1)', env: '{not json}' }), instance)
    expect(res.passed).toBe(false)
    expect(res.output.runPython.code).toBe('RUN_PYTHON_BAD_ENV')
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('passes on exit 0 and sends an isolated (no-source) run_context', async () => {
    mockToolRun({ exit_code: 0, timed_out: false, stdout_excerpt: 'hello world', stderr_excerpt: '', network_mode: 'none' })
    const res = await activateRunPython(
      node({ code: "import os; print('hello ' + os.environ['NAME'])", env: '{"NAME":"world"}', allowNetwork: 'true' }),
      instance,
    )
    expect(res.passed).toBe(true)
    expect(res.output.runPython).toMatchObject({ exitCode: 0, passed: true, stdout: 'hello world' })

    const body = JSON.parse((global.fetch as Mock).mock.calls[0][1].body)
    expect(body.tool_name).toBe('run_python')
    expect(body.args.allow_network).toBe(true)
    expect(body.args.env).toEqual({ NAME: 'world' })
    // isolated empty sandbox → no source* materialisation hints
    expect(body.run_context.sourceUri).toBeUndefined()
    expect(body.run_context.workflowInstanceId).toBe('inst-1')
    expect(body.run_context.nodeId).toBe('node-1')
  })

  it('fails the node on non-zero exit by default (failOnNonZero=true)', async () => {
    mockToolRun({ exit_code: 1, timed_out: false, stdout_excerpt: 'boom', stderr_excerpt: 'err' })
    const res = await activateRunPython(node({ code: 'import sys; sys.exit(1)' }), instance)
    expect(res.passed).toBe(false)
    expect(res.output.runPython.exitCode).toBe(1)
  })

  it('passes on non-zero exit when failOnNonZero=false', async () => {
    mockToolRun({ exit_code: 1, timed_out: false, stdout_excerpt: 'boom', stderr_excerpt: '' })
    const res = await activateRunPython(node({ code: 'import sys; sys.exit(1)', failOnNonZero: 'false' }), instance)
    expect(res.passed).toBe(true)
    expect(res.output.runPython.exitCode).toBe(1)
  })

  it('fails with RUN_PYTHON_DISPATCH_FAILED when tool-run errors', async () => {
    ;(global.fetch as Mock).mockResolvedValue(
      new Response(JSON.stringify({ success: false, error: { message: 'boom' } }), { status: 500 }),
    )
    const res = await activateRunPython(node({ code: 'print(1)' }), instance)
    expect(res.passed).toBe(false)
    expect(res.output.runPython.code).toBe('RUN_PYTHON_DISPATCH_FAILED')
  })
})
