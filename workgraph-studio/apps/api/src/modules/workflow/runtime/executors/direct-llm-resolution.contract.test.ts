import assert from 'node:assert/strict'
import { prisma } from '../../../../lib/prisma'
import { resolveDirectLlmConfig } from './DirectLlmTaskExecutor'

type Connection = {
  id: string
  alias: string
  name: string
  provider: string
  model: string
  baseUrl: string | null
  credentialEnv: string | null
  enabled: boolean
  tenantId: string | null
}

const connections: Connection[] = [
  {
    id: 'conn-valid',
    alias: 'tenant-sonnet',
    name: 'Tenant Sonnet',
    provider: 'anthropic',
    model: 'claude-sonnet-test',
    baseUrl: null,
    credentialEnv: 'ANTHROPIC_API_KEY',
    enabled: true,
    tenantId: 'tenant-a',
  },
  {
    id: 'conn-disabled',
    alias: 'disabled-model',
    name: 'Disabled',
    provider: 'anthropic',
    model: 'claude-disabled',
    baseUrl: null,
    credentialEnv: 'ANTHROPIC_API_KEY',
    enabled: false,
    tenantId: 'tenant-a',
  },
]

function node(config: Record<string, unknown>) {
  return {
    id: 'node-1',
    label: 'Verifier',
    nodeType: 'DIRECT_LLM_TASK',
    attempt: 1,
    config: { directLlm: { promptSource: 'INLINE', task: 'Review this document.', ...config } },
  } as never
}

const instance = {
  id: 'instance-1',
  templateId: 'workflow-1',
  createdById: 'user-1',
  tenantId: 'tenant-a',
  context: {},
} as never

async function main() {
  const originalFindFirst = prisma.llmConnection.findFirst
  ;(prisma.llmConnection as unknown as { findFirst: (args: { where: { alias?: string; OR?: Array<{ tenantId: string | null }> } }) => Promise<Connection | null> }).findFirst = async ({ where }) => {
    const tenants = new Set((where.OR ?? []).map(item => item.tenantId))
    return connections.find(connection => connection.alias === where.alias && tenants.has(connection.tenantId)) ?? null
  }
  const originalMockFlag = process.env.WORKGRAPH_DIRECT_LLM_ALLOW_MOCK

  try {
    const missing = await resolveDirectLlmConfig(node({ connectionAlias: 'typo-alias' }), instance)
    assert.equal('code' in missing ? missing.code : null, 'DIRECT_LLM_CONNECTION_NOT_FOUND')

    const disabled = await resolveDirectLlmConfig(node({ connectionAlias: 'disabled-model' }), instance)
    assert.equal('code' in disabled ? disabled.code : null, 'DIRECT_LLM_CONNECTION_DISABLED')

    const valid = await resolveDirectLlmConfig(node({ connectionAlias: 'tenant-sonnet' }), instance)
    assert.equal('config' in valid ? valid.config.connectionId : null, 'conn-valid')
    assert.equal('config' in valid ? valid.config.connectionTenantId : null, 'tenant-a')
    assert.equal('config' in valid ? valid.config.provider : null, 'anthropic')

    delete process.env.WORKGRAPH_DIRECT_LLM_ALLOW_MOCK
    const mockBlocked = await resolveDirectLlmConfig(node({ provider: 'mock' }), instance)
    assert.equal('code' in mockBlocked ? mockBlocked.code : null, 'DIRECT_LLM_MOCK_DISABLED')

    process.env.WORKGRAPH_DIRECT_LLM_ALLOW_MOCK = 'true'
    const mockAllowed = await resolveDirectLlmConfig(node({ provider: 'mock' }), instance)
    assert.equal('config' in mockAllowed ? mockAllowed.config.provider : null, 'mock')
  } finally {
    ;(prisma.llmConnection as unknown as { findFirst: typeof originalFindFirst }).findFirst = originalFindFirst
    if (originalMockFlag === undefined) delete process.env.WORKGRAPH_DIRECT_LLM_ALLOW_MOCK
    else process.env.WORKGRAPH_DIRECT_LLM_ALLOW_MOCK = originalMockFlag
  }
}

void main().then(() => {
  console.log('direct llm resolution contract tests passed')
})
