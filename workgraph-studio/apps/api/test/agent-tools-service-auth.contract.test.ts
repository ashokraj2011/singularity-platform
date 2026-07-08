import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

function source(file: string): string {
  return readFileSync(path.resolve(__dirname, '..', file), 'utf8')
}

function repoSource(file: string): string {
  return readFileSync(path.resolve(__dirname, '../../../..', file), 'utf8')
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

  it('forwards caller auth through capability repository resolution', () => {
    const resolver = source('src/lib/agent-and-tools/capability-repo.ts')
    const connectors = source('src/modules/connectors/connectors.router.ts')

    expect(resolver).toContain('resolveCapabilityRepo(capabilityId: string, authHeader?: string)')
    expect(resolver).toContain('getRuntimeCapability(capabilityId, authHeader)')
    expect(resolver).toContain('listRuntimeCapabilityRepositories(capabilityId, authHeader)')
    expect(resolver).toContain('listRuntimeCapabilities(authHeader)')
    expect(connectors).toContain('resolveCapabilityRepo(capabilityId, req.headers.authorization)')
    expect(connectors).toContain('req.user?.id ?? req.user?.userId')
    expect(connectors).toContain('req.user?.iamUserId')
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

  it('starts bare-metal Workgraph with IAM bootstrap credentials for service-token minting', () => {
    const bareMetal = repoSource('bin/bare-metal.sh')

    expect(bareMetal).toContain('boot workgraph-api')
    expect(bareMetal).toContain('IAM_BOOTSTRAP_USERNAME=\\"$LOCAL_SUPER_ADMIN_EMAIL\\"')
    expect(bareMetal).toContain('IAM_BOOTSTRAP_PASSWORD=\\"$LOCAL_SUPER_ADMIN_PASSWORD\\"')
    expect(bareMetal).toContain('IAM_SERVICE_TOKEN=\\"${IAM_SERVICE_TOKEN:-}\\"')
    expect(bareMetal).toContain('IAM_SERVICE_TOKEN_TENANT_IDS=\\"$IAM_SERVICE_TOKEN_TENANT_IDS\\"')
  })

  it('keeps demo-up MCP relaunch wired to laptop Git credentials', () => {
    const demoUp = repoSource('bin/demo-up.sh')

    expect(demoUp).toContain('if [ -f "$ROOT/.env.laptop" ]; then')
    expect(demoUp).toContain('GITHUB_TOKEN="${GITHUB_TOKEN:-}"')
    expect(demoUp).toContain('GH_TOKEN="${GH_TOKEN:-}"')
    expect(demoUp).toContain('MCP_GIT_AUTH_MODE="${MCP_GIT_AUTH_MODE:-}"')
    expect(demoUp).toContain('MCP_GIT_PUSH_ENABLED="${MCP_GIT_PUSH_ENABLED:-}"')
  })
})
