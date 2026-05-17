/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_LINK_OPERATIONS_PORTAL?: string
  readonly VITE_LINK_AGENT_ADMIN?: string
  readonly VITE_LINK_IAM_ADMIN?: string
  readonly VITE_LINK_WORKGRAPH_DESIGNER?: string
  readonly VITE_LINK_BLUEPRINT_WORKBENCH?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
