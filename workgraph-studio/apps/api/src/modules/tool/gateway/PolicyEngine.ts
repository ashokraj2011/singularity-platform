import { prisma } from '../../../lib/prisma'

export type PolicyDecision = 'ALLOW' | 'DENY' | 'REQUIRES_APPROVAL'

export async function evaluateToolPolicy(
  toolId: string,
  requestedById: string,
  input: Record<string, unknown>,
): Promise<PolicyDecision> {
  const policies = await prisma.policy.findMany({
    where: { resourceType: 'TOOL_RUN', isActive: true },
    include: { conditions: true, actions: true },
    orderBy: { priority: 'asc' },
  })

  for (const policy of policies) {
    const matches = policy.conditions.every(cond => {
      const contextValue = cond.fieldPath === 'toolId' ? toolId : cond.fieldPath === 'requestedById' ? requestedById : undefined
      const expected = cond.value as unknown
      switch (cond.operator) {
        case '==': return contextValue === expected
        case '!=': return contextValue !== expected
        default: return false
      }
    })

    if (matches) {
      for (const action of policy.actions) {
        if (action.actionType === 'DENY') return 'DENY'
        if (action.actionType === 'REQUIRE_APPROVAL') return 'REQUIRES_APPROVAL'
        if (action.actionType === 'ALLOW') return 'ALLOW'
      }
    }
  }

  // Default: tool-level requires_approval determines
  void input
  return 'ALLOW'
}
