// Environment helpers. In dev (Vite proxy mode), API_MODE='proxy' means we hit
// same-origin /api/iam, /api/wg, etc. In production we hit absolute URLs.

const mode = (import.meta.env.VITE_API_MODE ?? 'proxy') as 'proxy' | 'direct'

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

  // M100 P3 — nav targets. Under the edge gateway every UI shares the portal's
  // origin, so these default to same-origin PATH PREFIXES (not localhost URLs).
  // The VITE_LINK_* overrides remain for deployments that still split origins.
  // operationsPortal is '' because Operations is a route of THIS app (/operations).
  links: {
    operationsPortal:   import.meta.env.VITE_LINK_OPERATIONS_PORTAL   ?? '',
    agentAdmin:         import.meta.env.VITE_LINK_AGENT_ADMIN         ?? '/agent',
    iamAdmin:           import.meta.env.VITE_LINK_IAM_ADMIN           ?? '/iam',
    workgraphDesigner:  import.meta.env.VITE_LINK_WORKGRAPH_DESIGNER  ?? '/workflow',
    blueprintWorkbench: import.meta.env.VITE_LINK_BLUEPRINT_WORKBENCH ?? '/workbench',
    codeFoundry:        import.meta.env.VITE_LINK_CODE_FOUNDRY        ?? '/foundry',
  },
}
