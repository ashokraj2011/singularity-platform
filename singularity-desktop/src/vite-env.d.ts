/// <reference types="vite/client" />

interface CopilotCliStatus {
  available: boolean
  command?: string
  version?: string
  warning?: string
}

interface DeskConfig {
  apiBaseUrl?: string
  token?: string
  repoDir?: string
  workbenchUrl?: string
  copilotCommand?: string
  preferredMode?: 'workbench' | 'copilot'
}

interface CopilotStartInput {
  sessionId?: string
  command?: string
  cwd?: string
  args?: string[]
  env?: Record<string, string>
  initialInput?: string
}

interface CopilotOutput {
  sessionId: string
  stream: 'stdout' | 'stderr' | 'system'
  data: string
  exitCode?: number
}

interface EvidenceResult {
  workdir: string
  changedFiles: string[]
  diffStat: string
  patchExcerpt: string
  correlation: Record<string, unknown>
  warnings: string[]
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
    getConfig(): Promise<DeskConfig>
    setConfig(patch: DeskConfig): Promise<DeskConfig>
    pickRepoDirectory(): Promise<string | null>
    collectEvidence(input: { workdir?: string; baseRef?: string }): Promise<EvidenceResult>
    startCopilot(input: CopilotStartInput): Promise<{ sessionId: string; pid?: number; cwd: string; command: string; args: string[] }>
    sendCopilotInput(sessionId: string, data: string): Promise<boolean>
    stopCopilot(sessionId: string): Promise<boolean>
    onCopilotOutput(handler: (payload: CopilotOutput) => void): () => void
  }
}
