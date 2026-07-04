import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

function source(file: string): string {
  return readFileSync(path.resolve(__dirname, '..', file), 'utf8')
}

describe('Workgraph auth and runtime setup response contracts', () => {
  it('keeps IAM login proxy from forwarding malformed successful auth bodies', () => {
    const router = source('src/modules/identity/auth.router.ts')

    expect(router).toContain('type UpstreamAuthBody')
    expect(router).toContain("import { isJsonObject, readUpstreamJsonBody, upstreamSnippet } from '../../lib/upstream-json'")
    expect(router).toContain('async function readUpstreamAuthBody(upstream: Response): Promise<UpstreamAuthBody>')
    expect(router).toContain('const body = await readUpstreamJsonBody(upstream)')
    expect(router).toContain('function authBodyMessage(body: UpstreamAuthBody, fallback: string): string')
    expect(router).toContain("code: 'IAM_LOGIN_INVALID_RESPONSE'")
    expect(router).toContain('res.status(upstream.status).json(body.value)')
    expect(router).not.toMatch(/await upstream\.json\(\)/)
    expect(router).not.toMatch(/JSON\.parse\(raw\)/)
    expect(router).not.toContain('res.status(upstream.status).json(body)')
  })

  it('validates MCP session token mint responses before using them', () => {
    const service = source('src/modules/laptop/laptop.service.ts')

    expect(service).toContain('type McpSessionTokenResponse')
    expect(service).toContain("import { isJsonObject, readUpstreamJsonBody, upstreamSnippet } from '../../lib/upstream-json'")
    expect(service).toContain('async function readMcpSessionTokenResponse(res: Response): Promise<McpSessionTokenResponse>')
    expect(service).toContain('const responseBody = await readUpstreamJsonBody(res)')
    expect(service).toContain('MCP session token mint returned invalid JSON')
    expect(service).toContain('MCP session token mint response was missing required fields')
    expect(service).toContain('return readMcpSessionTokenResponse(res)')
    expect(service).not.toMatch(/return await res\.json\(\)/)
    expect(service).not.toMatch(/JSON\.parse\(text\)/)
  })
})
