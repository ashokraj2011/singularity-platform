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
  composerBase:      pick('/api/composer', import.meta.env.VITE_COMPOSER_BASE_URL),
  contextFabricBase: pick('/api/cf',       import.meta.env.VITE_CONTEXT_FABRIC_BASE_URL),

  // Deep-link targets (always absolute — they open external apps)
  links: {
    agentAdmin:        import.meta.env.VITE_LINK_AGENT_ADMIN        ?? 'http://localhost:3000',
    iamAdmin:          import.meta.env.VITE_LINK_IAM_ADMIN          ?? 'http://localhost:5175',
    workgraphDesigner: import.meta.env.VITE_LINK_WORKGRAPH_DESIGNER ?? 'http://localhost:5174',
  },
}
