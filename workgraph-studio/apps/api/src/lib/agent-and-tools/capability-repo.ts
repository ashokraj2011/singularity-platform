import { listRuntimeCapabilities, getRuntimeCapability, listRuntimeCapabilityRepositories } from './client'

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
  const repoFrom = (cap: Record<string, unknown> | null | undefined): string | undefined => {
    const repos = Array.isArray(cap?.repositories) ? (cap!.repositories as Array<Record<string, unknown>>) : []
    // Prefer an ACTIVE repo; fall back to the first linked one (a freshly-attached
    // repo may still be bootstrapping — better to offer it than to say "not resolved").
    const primary = repos.find((r) => String(r?.status ?? '').toUpperCase() === 'ACTIVE') ?? repos[0]
    const url = typeof primary?.repoUrl === 'string' ? primary.repoUrl
      : typeof primary?.url === 'string' ? primary.url : undefined
    return url && url.trim() ? url.trim() : undefined
  }
  // 1) Direct by-id detail — a findUnique on agent-runtime, NOT subject to the list's
  //    scoping, so it resolves capabilities the list wouldn't return. (repos here are
  //    ACTIVE-filtered server-side.)
  const fromDetail = repoFrom((await getRuntimeCapability(capabilityId)) as Record<string, unknown> | null)
  if (fromDetail) return fromDetail
  // 2) Repositories endpoint — returns ALL linked repos (any status). This is the only
  //    path that resolves a repo whose status isn't ACTIVE yet (still bootstrapping),
  //    which both the detail and the list omit.
  const repos = await listRuntimeCapabilityRepositories(capabilityId)
  const fromRepos = repoFrom({ repositories: repos } as Record<string, unknown>)
  if (fromRepos) return fromRepos
  // 3) Fall back to the list scan (back-compat / if the newer endpoints are unavailable).
  try {
    const caps = await listRuntimeCapabilities()
    const cap = caps.find((c) => String((c as Record<string, unknown>).id ?? '') === capabilityId) as Record<string, unknown> | undefined
    return repoFrom(cap)
  } catch {
    return undefined
  }
}
