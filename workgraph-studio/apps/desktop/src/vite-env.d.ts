/// <reference types="vite/client" />

interface CopilotCliStatus {
  available: boolean
  command?: string
  version?: string
  warning?: string
}

interface Window {
  singularityDesk?: {
    platform: string
    versions: {
      electron?: string
      chrome?: string
      node?: string
    }
    openExternal(url: string): Promise<boolean>
    notify(input: { title?: string; body?: string }): Promise<boolean>
    detectCopilotCli(): Promise<CopilotCliStatus>
  }
}
