import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

function source(file: string): string {
  return readFileSync(path.resolve(__dirname, '..', file), 'utf8')
}

describe('Blueprint Workbench upstream response contract', () => {
  it('normalizes MCP worktree JSON/plaintext responses before rendering Workbench data', () => {
    const router = source('src/modules/blueprint/blueprint.router.ts')

    expect(router).toContain('async function readJsonResponseBody(res: Response, source: string): Promise<unknown>')
    expect(router).toContain("import { readUpstreamJsonBody, upstreamSnippet } from '../../lib/upstream-json'")
    expect(router).toContain('const body = await readUpstreamJsonBody(res)')
    expect(router).toContain('function upstreamErrorMessage(body: unknown): string | undefined')
    expect(router).toContain('function upstreamErrorCode(body: unknown): string | undefined')
    expect(router).toContain('function unwrapUpstreamData(body: unknown): unknown')
    expect(router).toContain("const body = await readJsonResponseBody(upstream, 'mcp-server worktree tree')")
    expect(router).toContain("const body = await readJsonResponseBody(upstream, 'mcp-server worktree file')")
    expect(router).toContain("const body = await readJsonResponseBody(upstream, 'mcp-server worktree write')")
    expect(router).toContain("res.status(409).json({ code: 'STALE_EDIT', message: upstreamErrorMessage(body) ?? 'stale edit', upstreamCode: code })")
    expect(router).not.toMatch(/await upstream\.json\(\)/)
    expect(router).not.toMatch(/JSON\.parse\(text\)/)
  })

  it('uses guarded parsing for GitHub repository metadata and tree scans', () => {
    const router = source('src/modules/blueprint/blueprint.router.ts')

    expect(router).toContain('async function readGithubJson<T>(res: Response, source: string): Promise<T>')
    expect(router).toContain('const treeJson = await readGithubJson<{ tree?: Array<{ path: string; type: string; size?: number; sha?: string }> }>')
    expect(router).toContain("const body = await readGithubJson<{ default_branch?: string }>(res, 'GitHub repository lookup')")
    expect(router).not.toMatch(/treeResp\.json\(\)/)
    expect(router).not.toMatch(/await res\.json\(\) as \{ default_branch/)
  })
})
