import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

function source(file: string): string {
  return readFileSync(path.resolve(__dirname, '..', file), 'utf8')
}

describe('Workgraph -> Context Fabric service auth contract', () => {
  it('centralizes Context Fabric service-token headers', () => {
    const client = source('src/lib/context-fabric/client.ts')

    expect(client).toContain('export function contextFabricServiceHeaders')
    expect(client).toContain("'X-Service-Token': config.CONTEXT_FABRIC_SERVICE_TOKEN")
    expect(client).toContain("tracingHeaders(contextFabricServiceHeaders({ 'content-type': 'application/json' })")
  })

  it('uses service-token headers for workflow event polling and streaming proxies', () => {
    const router = source('src/modules/workflow/instances.router.ts')

    expect(router).toContain("import { contextFabricServiceHeaders } from '../../lib/context-fabric/client'")
    expect(router.match(/headers: contextFabricServiceHeaders\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(3)
    expect(router).not.toContain("context-fabric's stream endpoint is open today")
  })

  it('uses service-token headers for run-insights Context Fabric event reads', () => {
    const router = source('src/modules/workflow/insights.router.ts')

    expect(router).toContain("import { contextFabricServiceHeaders } from '../../lib/context-fabric/client'")
    expect(router).toContain('headers: contextFabricServiceHeaders()')
  })

  it('routes legacy one-shot LLM callers through governed Context Fabric execution', () => {
    const gatewayProvider = source('src/modules/agent/llm/GatewayProvider.ts')
    const llmGatewayAdapter = source('src/modules/connectors/adapters/llm-gateway.adapter.ts')

    expect(gatewayProvider).toContain('contextFabricClient.executeGovernedTurn')
    expect(gatewayProvider).toContain("source_type: 'workgraph-legacy-agent-run'")
    expect(gatewayProvider).not.toContain('/mcp/invoke')
    expect(gatewayProvider).not.toContain('MCP_GATEWAY')

    expect(llmGatewayAdapter).toContain('contextFabricClient.executeGovernedTurn')
    expect(llmGatewayAdapter).toContain("source_type: 'workgraph-llm-gateway-connector'")
    expect(llmGatewayAdapter).toContain("client.post('/mcp/embed'")
    expect(llmGatewayAdapter).not.toContain("client.post('/mcp/invoke'")
    expect(llmGatewayAdapter).not.toContain('modelConfig:')
  })
})
