import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

function source(file: string): string {
  return readFileSync(path.resolve(__dirname, '..', file), 'utf8')
}

describe('GIT_PUSH executor response parsing contract', () => {
  it('normalizes Context Fabric and MCP finish-branch responses before reading push output', () => {
    const executor = source('src/modules/workflow/runtime/executors/GitPushExecutor.ts')

    expect(executor).toContain("import { readUpstreamJsonBody, upstreamSnippet } from '../../../../lib/upstream-json'")
    expect(executor).toContain('async function readJsonObjectResponse(response: Response, source: string)')
    expect(executor).toContain('const parsed = await readUpstreamJsonBody(response)')
    expect(executor).toContain('returned invalid JSON')
    expect(executor).toContain("const parsed = await readJsonObjectResponse(cfResp, 'Context Fabric finish-branch')")
    expect(executor).toContain("if ('error' in parsed) throw new Error(redactSecrets(parsed.error))")
    expect(executor).toContain("const parsed = await readJsonObjectResponse(response, 'MCP finish-branch')")
    expect(executor).toContain("const parsed = await readJsonObjectResponse(response, 'MCP tool invocation receipt')")
    expect(executor).not.toMatch(/JSON\.parse\(cfText\)/)
    expect(executor).not.toMatch(/response\.json\(\)/)
    expect(executor).not.toMatch(/body = text \? JSON\.parse\(text\)/)
    expect(executor).not.toMatch(/JSON\.parse\(raw\)/)
  })

  it('does not fall through to direct MCP after a malformed successful Context Fabric finish-branch response', () => {
    const executor = source('src/modules/workflow/runtime/executors/GitPushExecutor.ts')
    const cfParseIndex = executor.indexOf("const parsed = await readJsonObjectResponse(cfResp, 'Context Fabric finish-branch')")
    const directMcpIndex = executor.indexOf("fetch(`${config.MCP_SERVER_URL.replace(/\\/$/, '')}/mcp/work/finish-branch`")

    expect(cfParseIndex).toBeGreaterThan(0)
    expect(directMcpIndex).toBeGreaterThan(cfParseIndex)
    expect(executor.slice(cfParseIndex, directMcpIndex)).toContain("throw new Error(redactSecrets(parsed.error))")
  })
})
