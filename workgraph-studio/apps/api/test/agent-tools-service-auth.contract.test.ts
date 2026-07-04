import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

function source(file: string): string {
  return readFileSync(path.resolve(__dirname, '..', file), 'utf8')
}

describe('Workgraph -> agent-and-tools service auth contract', () => {
  it('uses the caller bearer when present and a Workgraph service JWT otherwise', () => {
    const client = source('src/lib/agent-and-tools/client.ts')

    expect(client).toContain("import { getIamServiceToken } from '../iam/service-token'")
    expect(client).toContain('async function resolvedAgentToolsAuthHeader')
    expect(client).toContain("return callerHeader.startsWith('Bearer ') ? callerHeader : `Bearer ${callerHeader}`")
    expect(client).toContain('const token = await getIamServiceToken()')
    expect(client).toContain('return token ? `Bearer ${token}` : undefined')
  })

  it('applies the resolved Authorization header to GET, POST, and PATCH upstream calls', () => {
    const client = source('src/lib/agent-and-tools/client.ts')
    const assignments = client.match(/headers\.authorization = authorization/g) ?? []

    expect(client).toContain('const authorization = await resolvedAgentToolsAuthHeader(authHeader)')
    expect(assignments.length).toBeGreaterThanOrEqual(3)
  })

  it('normalizes Agent Runtime and Tool Service response bodies through the shared parser', () => {
    const client = source('src/lib/agent-and-tools/client.ts')

    expect(client).toContain("import { readUpstreamJsonBody, upstreamSnippet, type UpstreamJsonBody } from '../upstream-json'")
    expect(client).toContain('async function readAgentToolsBody(res: Response): Promise<AgentToolsBody>')
    expect(client).toContain('return readUpstreamJsonBody(res)')
    expect(client).toContain('function agentToolsInvalidJsonError(path: string, body: AgentToolsBody): AgentAndToolsError')
    expect(client).toContain('if (body.parseError) throw agentToolsInvalidJsonError(path, body)')
    expect(client).toContain('if (bodyOut.parseError) throw agentToolsInvalidJsonError(`PATCH /agents/templates/${id}`, bodyOut)')
    expect(client).not.toMatch(/await res\.json\(\)/)
    expect(client).not.toMatch(/JSON\.parse\(text\)/)
    expect(client).not.toMatch(/JSON\.parse\(raw\)/)
  })

  it('documents production token availability in the Workgraph startup guard', () => {
    const config = source('src/config.ts')

    expect(config).toContain('set IAM_SERVICE_TOKEN or IAM_BOOTSTRAP_USERNAME/IAM_BOOTSTRAP_PASSWORD')
    expect(config).toContain('Prompt Composer, agent-and-tools, and IAM')
  })
})
