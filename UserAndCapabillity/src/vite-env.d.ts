/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_EVENT_HORIZON_CAPABILITY_ID?: string
  readonly VITE_EVENT_HORIZON_PROVIDER?: string
  readonly VITE_EVENT_HORIZON_MODEL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
