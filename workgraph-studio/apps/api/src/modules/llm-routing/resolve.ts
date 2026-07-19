/**
 * Shared LLM-routing resolver — used by both the /resolve endpoint and the
 * surfaces (chat, governed agents, workbench) so a touch point's connection is
 * resolved the same way everywhere. Precedence: USER > CAPABILITY > DEFAULT.
 *
 * Important security invariant: routing is tenant-local. The old helper queried
 * every tenant's rules and failed open to null on any error, letting callers
 * silently fall back to a default model. In strict tenant mode, a missing tenant
 * is now a hard routing error; in development/no-tenant mode only global rows
 * (`tenantId = null`) are eligible.
 */
import { prisma } from '../../lib/prisma'
import { currentTenantIdForDb } from '../../lib/tenant-db-context'
import { tenantIsolationStrict } from '../../lib/tenant-isolation'

export type LlmRoutingDecision = {
  touchPoint: string
  modelAlias: string | null
  scopeType: string | null
  ruleId: string | null
  tenantId: string | null
}

export class LlmRoutingResolutionError extends Error {
  constructor(public readonly code: 'TENANT_REQUIRED' | 'QUERY_FAILED', message: string) {
    super(message)
    this.name = 'LlmRoutingResolutionError'
  }
}

export type ResolveLlmRoutingOptions = {
  userId?: string | null
  capabilityId?: string | null
  tenantId?: string | null
  strictTenant?: boolean
  failClosed?: boolean
}

function clean(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export async function resolveLlmRoutingDecision(
  touchPoint: string,
  opts: ResolveLlmRoutingOptions = {},
): Promise<LlmRoutingDecision> {
  const normalizedTouchPoint = touchPoint.trim()
  const strict = opts.strictTenant ?? tenantIsolationStrict()
  const tenantId = clean(opts.tenantId) ?? clean(currentTenantIdForDb())

  if (strict && !tenantId) {
    throw new LlmRoutingResolutionError(
      'TENANT_REQUIRED',
      `Tenant context is required to resolve LLM routing for ${normalizedTouchPoint || 'unknown touch point'}.`,
    )
  }

  try {
    const rules = await prisma.llmRouting.findMany({
      where: {
        touchPoint: normalizedTouchPoint,
        enabled: true,
        tenantId: tenantId ?? null,
      },
    })
    const pick = (scopeType: string, scopeId: string) => rules.find(r => r.scopeType === scopeType && r.scopeId === scopeId)
    const userId = clean(opts.userId)
    const capabilityId = clean(opts.capabilityId)
    const match =
      (userId && pick('USER', userId)) ||
      (capabilityId && pick('CAPABILITY', capabilityId)) ||
      pick('DEFAULT', '') ||
      null
    return {
      touchPoint: normalizedTouchPoint,
      modelAlias: match?.modelAlias ?? null,
      scopeType: match?.scopeType ?? null,
      ruleId: match?.id ?? null,
      tenantId,
    }
  } catch (err) {
    if (strict || opts.failClosed) {
      throw new LlmRoutingResolutionError(
        'QUERY_FAILED',
        `Failed to resolve LLM routing for ${normalizedTouchPoint || 'unknown touch point'}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    return { touchPoint: normalizedTouchPoint, modelAlias: null, scopeType: null, ruleId: null, tenantId }
  }
}

export async function resolveLlmRouting(
  touchPoint: string,
  opts: ResolveLlmRoutingOptions = {},
): Promise<string | null> {
  const decision = await resolveLlmRoutingDecision(touchPoint, opts)
  return decision.modelAlias
}
