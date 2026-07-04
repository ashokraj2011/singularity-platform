import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

function source(file: string): string {
  return readFileSync(path.resolve(__dirname, '..', file), 'utf8')
}

describe('Workgraph runtime LLM/MCP proxy response contract', () => {
  it('normalizes MCP JSON/plaintext responses before returning runtime status', () => {
    const router = source('src/modules/runtime/llm-models.router.ts')

    expect(router).toContain('type McpProxyResult')
    expect(router).toContain('function mcpErrorCode(path: string): string')
    expect(router).toContain("import { readUpstreamJsonBody, upstreamSnippet, type UpstreamJsonBody } from '../../lib/upstream-json'")
    expect(router).toContain('async function readMcpBody(res: Response)')
    expect(router).toContain('return readUpstreamJsonBody(res)')
    expect(router).toContain('async function fetchMcpJson(path: string): Promise<McpProxyResult>')
    expect(router).toContain("error: 'MCP_RUNTIME_UNREACHABLE'")
    expect(router).toContain('const body = await readMcpBody(upstream)')
    expect(router).toContain('if (body.parseError)')
    expect(router).toContain('MCP returned invalid JSON for ${path}')
    expect(router).not.toMatch(/await upstream\.json\(\)/)
    expect(router).not.toMatch(/await upstream\.text\(\)/)
    expect(router).not.toMatch(/JSON\.parse\(raw\)/)
  })

  it('keeps endpoint-specific MCP status codes for setup screens', () => {
    const router = source('src/modules/runtime/llm-models.router.ts')

    expect(router).toContain("MCP_WORKSPACE_STATS_UNAVAILABLE")
    expect(router).toContain("MCP_DISCOVERY_UNAVAILABLE")
    expect(router).toContain("MCP_PROVIDER_CATALOG_UNAVAILABLE")
    expect(router).toContain("MCP_MODEL_CATALOG_UNAVAILABLE")
    expect(router).toContain("res.status(upstream.status).json(upstream.body)")
    expect(router).toContain('root.data?.commandExecution ?? null')
  })
})
