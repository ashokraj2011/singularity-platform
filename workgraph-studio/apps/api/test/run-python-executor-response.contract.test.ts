import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

function source(file: string): string {
  return readFileSync(path.resolve(__dirname, '..', file), 'utf8')
}

describe('RUN_PYTHON executor response parsing contract', () => {
  it('normalizes Context Fabric and MCP tool-run responses before reading receipts', () => {
    const executor = source('src/modules/workflow/runtime/executors/RunPythonExecutor.ts')

    expect(executor).toContain("import { readUpstreamJsonBody, upstreamSnippet } from '../../../../lib/upstream-json'")
    expect(executor).toContain('async function parseToolRunBody(response: Response, source: string)')
    expect(executor).toContain('const parsed = await readUpstreamJsonBody(response)')
    expect(executor).toContain('returned invalid JSON')
    expect(executor).toContain("const parsed = await parseToolRunBody(resp, 'Context Fabric runtime bridge')")
    expect(executor).toContain("const parsed = await parseToolRunBody(response, 'MCP tool-run')")
    expect(executor).toContain("return { error: parsed.error }")
    expect(executor).toContain("return { error: `run_python dispatch failed: ${parsed.error}` }")
    expect(executor).toContain('MCP tool-run unreachable')
    expect(executor).not.toMatch(/const body = \(text \? JSON\.parse\(text\)/)
    expect(executor).not.toMatch(/JSON\.parse\(text\)/)
  })

  it('keeps user-provided env JSON validation separate from upstream response parsing', () => {
    const executor = source('src/modules/workflow/runtime/executors/RunPythonExecutor.ts')

    expect(executor).toContain("return { error: 'env must be valid JSON (an object of string→string)' }")
    expect(executor).toMatch(/function parseEnv[\s\S]*?JSON\.parse\(raw\)/)
  })
})
