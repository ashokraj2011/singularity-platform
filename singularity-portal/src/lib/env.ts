// Environment helpers. In dev (Vite proxy mode), API_MODE='proxy' means we hit
// same-origin /api/iam, /api/wg, etc. In production we hit absolute URLs.

const mode = (import.meta.env.VITE_API_MODE ?? 'proxy') as 'proxy' | 'direct'

// Runtime config injected by /env.js (window.__ENV__), overwritten per deployment
// by the container at start. Empty in dev → links fall back to VITE_LINK_* / paths.
const rt: Record<string, string> =
  (typeof window !== 'undefined' && (window as unknown as { __ENV__?: Record<string, string> }).__ENV__) || {}

function pick(proxyPath: string, directUrl: string | undefined): string {
  if (mode === 'proxy') return proxyPath
  if (!directUrl) {
    // Fall back to the proxy path even in non-proxy mode if the env var is
    // missing; this keeps localhost dev working without an .env file.
    return proxyPath
  }
  return directUrl
}

export const env = {
  mode,
  iamBase:           pick('/api/iam',      import.meta.env.VITE_IAM_BASE_URL),
  workgraphBase:     pick('/api/wg',       import.meta.env.VITE_WORKGRAPH_BASE_URL),
  runtimeBase:       pick('/api/runtime',  import.meta.env.VITE_AGENT_RUNTIME_BASE_URL),
  composerBase:      pick('/api/composer', import.meta.env.VITE_COMPOSER_BASE_URL),
  contextFabricBase: pick('/api/cf',       import.meta.env.VITE_CONTEXT_FABRIC_BASE_URL),
  mcpBase:           pick('/api/mcp',      import.meta.env.VITE_MCP_BASE_URL),
  auditGovBase:      pick('/api/gov',      import.meta.env.VITE_AUDIT_GOV_BASE_URL),

  // M100 P3 — nav targets. Resolution order per link: RUNTIME config (window.__ENV__
  // from /env.js, written per deployment by the container at start — no rebuild) →
  // build-time VITE_LINK_* → same-origin PATH PREFIX default (correct behind the
  // edge gateway single origin). Standalone deployments set the runtime values to
  // absolute per-app / gateway URLs so the menu doesn't bounce on the portal's own
  // port. operationsPortal is '' because Operations is a route of THIS app.
  links: {
    operationsPortal:   rt.LINK_OPERATIONS_PORTAL   || import.meta.env.VITE_LINK_OPERATIONS_PORTAL   || '',
    agentAdmin:         rt.LINK_AGENT_ADMIN          || import.meta.env.VITE_LINK_AGENT_ADMIN         || '/agent',
    iamAdmin:           rt.LINK_IAM_ADMIN            || import.meta.env.VITE_LINK_IAM_ADMIN           || '/iam',
    workgraphDesigner:  rt.LINK_WORKGRAPH_DESIGNER   || import.meta.env.VITE_LINK_WORKGRAPH_DESIGNER  || '/workflow',
    blueprintWorkbench: rt.LINK_BLUEPRINT_WORKBENCH  || import.meta.env.VITE_LINK_BLUEPRINT_WORKBENCH || '/workbench',
    codeFoundry:        rt.LINK_CODE_FOUNDRY         || import.meta.env.VITE_LINK_CODE_FOUNDRY        || '/foundry',
  },
}
