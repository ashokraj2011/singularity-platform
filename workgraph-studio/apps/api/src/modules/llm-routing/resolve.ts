/**
 * Shared LLM-routing resolver — used by both the /resolve endpoint and the
 * surfaces (chat, governed agents, workbench) so a touch point's connection is
 * resolved the same way everywhere. Precedence: USER > CAPABILITY > DEFAULT.
 * Best-effort: returns null on any error so a surface never breaks on routing.
 */
import { prisma } from '../../lib/prisma'

export async function resolveLlmRouting(
  touchPoint: string,
  opts: { userId?: string | null; capabilityId?: string | null } = {},
): Promise<string | null> {
  try {
    const rules = await prisma.llmRouting.findMany({ where: { touchPoint, enabled: true } })
    if (rules.length === 0) return null
    const pick = (scopeType: string, scopeId: string) => rules.find(r => r.scopeType === scopeType && r.scopeId === scopeId)
    const match =
      (opts.userId && pick('USER', opts.userId)) ||
      (opts.capabilityId && pick('CAPABILITY', opts.capabilityId)) ||
      pick('DEFAULT', '') ||
      null
    return match?.modelAlias ?? null
  } catch {
    return null
  }
}
