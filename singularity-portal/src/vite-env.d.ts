/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_MODE?: 'proxy' | 'direct'
  readonly VITE_IAM_BASE_URL?: string
  readonly VITE_WORKGRAPH_BASE_URL?: string
  readonly VITE_COMPOSER_BASE_URL?: string
  readonly VITE_CONTEXT_FABRIC_BASE_URL?: string
  readonly VITE_MCP_BASE_URL?: string
  readonly VITE_LINK_AGENT_ADMIN?: string
  readonly VITE_LINK_IAM_ADMIN?: string
  readonly VITE_LINK_WORKGRAPH_DESIGNER?: string
  readonly VITE_EVENT_HORIZON_CAPABILITY_ID?: string
  readonly VITE_EVENT_HORIZON_PROVIDER?: string
  readonly VITE_EVENT_HORIZON_MODEL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
