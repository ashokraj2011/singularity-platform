import { listRuntimeCapabilities } from './client'

/**
 * §13.4 working-dir — resolve a capability's primary repo (from agent-runtime).
 *
 * Two callers:
 *   - AgentTaskExecutor: a copilot SDLC node clones the capability's LINKED repo
 *     when the work item gives no per-item repoUrl.
 *   - GitPushExecutor (P0 #2): supply `repo` to the Git credential broker so CF
 *     can mint a repo-scoped, short-lived credential bound to the user's grant.
 *
 * Best-effort by design: returns undefined on any failure (no capability match,
 * no linked repo, agent-runtime unreachable). Callers fall back to the node's
 * configured sourceUri, or — for the broker — simply skip credential issuance
 * (CF brokers nothing when `repo` is absent), leaving the legacy path intact.
 */
export async function resolveCapabilityRepo(capabilityId: string): Promise<string | undefined> {
  try {
    const caps = await listRuntimeCapabilities()
    const cap = caps.find((c) => String((c as Record<string, unknown>).id ?? '') === capabilityId) as Record<string, unknown> | undefined
    const repos = Array.isArray(cap?.repositories) ? (cap!.repositories as Array<Record<string, unknown>>) : []
    const primary = repos.find((r) => String(r?.status ?? '').toUpperCase() === 'ACTIVE') ?? repos[0]
    const url = typeof primary?.repoUrl === 'string' ? primary.repoUrl
      : typeof primary?.url === 'string' ? primary.url : undefined
    return url && url.trim() ? url.trim() : undefined
  } catch {
    return undefined
  }
}
