// Cross-app navigation targets. Under the Docker edge-gateway every UI shares
// the portal origin, so Agent Studio defaults to the same-origin path prefix
// '/agent'. In split-origin deployments (bare-metal) VITE_LINK_AGENT_ADMIN
// points at Agent Studio's own host (e.g. http://localhost:3000), so the link
// resolves there instead of bouncing back on this app's router.
import { viteEnv } from 'identity-web/vite-env-compat'

const AGENT_BASE = (viteEnv.VITE_LINK_AGENT_ADMIN ?? '/agents').replace(/\/+$/, '')

/** Link to the Agent Studio capabilities page (optionally a specific capability). */
export function agentStudioCapabilitiesHref(capabilityId?: string): string {
  const base = `${AGENT_BASE}/capabilities`
  return capabilityId ? `${base}/${capabilityId}` : base
}
