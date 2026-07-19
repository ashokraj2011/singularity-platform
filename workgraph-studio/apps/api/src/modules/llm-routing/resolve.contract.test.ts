import assert from 'node:assert/strict'
import { prisma } from '../../lib/prisma'
import { LlmRoutingResolutionError, resolveLlmRoutingDecision } from './resolve'

type Rule = {
  id: string
  touchPoint: string
  scopeType: string
  scopeId: string
  modelAlias: string
  enabled: boolean
  tenantId: string | null
}

const rules: Rule[] = [
  { id: 'tenant-a-default', touchPoint: 'CHAT', scopeType: 'DEFAULT', scopeId: '', modelAlias: 'tenant-a-default-model', enabled: true, tenantId: 'tenant-a' },
  { id: 'tenant-a-user', touchPoint: 'CHAT', scopeType: 'USER', scopeId: 'user-1', modelAlias: 'tenant-a-user-model', enabled: true, tenantId: 'tenant-a' },
  { id: 'tenant-b-default', touchPoint: 'CHAT', scopeType: 'DEFAULT', scopeId: '', modelAlias: 'tenant-b-default-model', enabled: true, tenantId: 'tenant-b' },
  { id: 'global-default', touchPoint: 'CHAT', scopeType: 'DEFAULT', scopeId: '', modelAlias: 'global-model', enabled: true, tenantId: null },
]

async function main() {
  const originalFindMany = prisma.llmRouting.findMany
  const capturedWhere: unknown[] = []
  ;(prisma.llmRouting as unknown as { findMany: (args: { where: Partial<Rule> }) => Promise<Rule[]> }).findMany = async ({ where }) => {
    capturedWhere.push(where)
    return rules.filter(rule => (
      rule.touchPoint === where.touchPoint &&
      rule.enabled === where.enabled &&
      rule.tenantId === where.tenantId
    ))
  }

  try {
    const userScoped = await resolveLlmRoutingDecision('CHAT', { tenantId: 'tenant-a', userId: 'user-1', strictTenant: true })
    assert.equal(userScoped.modelAlias, 'tenant-a-user-model')
    assert.equal(userScoped.ruleId, 'tenant-a-user')
    assert.equal((capturedWhere.at(-1) as { tenantId?: string }).tenantId, 'tenant-a')

    const tenantScoped = await resolveLlmRoutingDecision('CHAT', { tenantId: 'tenant-b', userId: 'user-1', strictTenant: true })
    assert.equal(tenantScoped.modelAlias, 'tenant-b-default-model')
    assert.equal(tenantScoped.ruleId, 'tenant-b-default')
    assert.equal((capturedWhere.at(-1) as { tenantId?: string }).tenantId, 'tenant-b')

    const globalOnly = await resolveLlmRoutingDecision('CHAT', { userId: 'user-1', strictTenant: false })
    assert.equal(globalOnly.modelAlias, 'global-model')
    assert.equal((capturedWhere.at(-1) as { tenantId?: string | null }).tenantId, null)

    await assert.rejects(
      () => resolveLlmRoutingDecision('CHAT', { strictTenant: true }),
      (err) => err instanceof LlmRoutingResolutionError && err.code === 'TENANT_REQUIRED',
    )
  } finally {
    ;(prisma.llmRouting as unknown as { findMany: typeof originalFindMany }).findMany = originalFindMany
  }
}

void main().then(() => {
  console.log('llm routing resolve contract tests passed')
})
