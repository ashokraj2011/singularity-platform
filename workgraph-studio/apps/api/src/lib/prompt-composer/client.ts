/**
 * Prompt Composer HTTP client — M5 wire.
 *
 * Workgraph's AGENT_TASK executor calls POST /api/v1/compose-and-respond on
 * prompt-composer (port 3004 inside the agent-and-tools network), which:
 *   1. Assembles the layered prompt from PromptProfile + capability context +
 *      knowledge artifacts + distilled memory + tool grants + workflow vars +
 *      artifacts + EXECUTION_OVERRIDE layers.
 *   2. POSTs to context-fabric /chat/respond and returns the unified response.
 *
 * Returns three correlation IDs we persist on AgentRunOutput.structuredPayload:
 *   - promptAssemblyId  → composer.PromptAssembly
 *   - modelCallId       → context-fabric.ModelCall
 *   - contextPackageId  → context-fabric.ContextPackage
 */

import { config } from '../../config'

export interface ComposeArtifact {
  consumableId?: string
  consumableType?: string
  role?: 'INPUT' | 'CONTEXT' | 'REFERENCE'
  label: string
  mediaType?: string
  content?: string
  minioRef?: string
  excerpt?: string
}

export interface ComposeRequest {
  agentTemplateId: string
  agentBindingId?: string
  capabilityId?: string
  task: string
  workflowContext: {
    instanceId: string
    nodeId: string
    phaseId?: string
    vars?: Record<string, unknown>
    globals?: Record<string, unknown>
    priorOutputs?: Record<string, unknown>
  }
  artifacts?: ComposeArtifact[]
  overrides?: {
    additionalLayers?: { layerType?: string; content: string }[]
    systemPromptAppend?: string
    extraContext?: string
  }
  modelOverrides?: {
    provider?: string
    model?: string
    temperature?: number
    maxOutputTokens?: number
  }
  contextPolicy?: {
    optimizationMode?: string
    maxContextTokens?: number
    compareWithRaw?: boolean
  }
  toolDiscovery?: {
    enabled?: boolean
    riskMax?: 'low' | 'medium' | 'high' | 'critical'
    limit?: number
  }
  previewOnly?: boolean
}

export interface ComposeResponse {
  promptAssemblyId: string
  promptHash: string
  estimatedInputTokens: number | null
  layersUsed: { layerType: string; priority: number; layerHash: string; inclusionReason: string }[]
  warnings: string[]
  // Present unless previewOnly:
  modelCallId?: string
  contextPackageId?: string
  response?: string
  optimization?: {
    mode: string
    raw_input_tokens: number
    optimized_input_tokens: number
    tokens_saved: number
    percent_saved: number
    estimated_cost_saved: number
  }
  modelUsage?: {
    provider: string
    model: string
    input_tokens: number
    output_tokens: number
    estimated_cost: number
    latency_ms: number
  }
  // Present only when previewOnly:
  assembled?: { systemPrompt: string; message: string }
}

export class PromptComposerError extends Error {
  constructor(message: string, public status: number, public detail?: unknown) {
    super(message)
  }
}

export const promptComposerClient = {
  async composeAndRespond(input: ComposeRequest): Promise<ComposeResponse> {
    const url = `${config.PROMPT_COMPOSER_URL}/api/v1/compose-and-respond`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(240_000),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new PromptComposerError(
        `prompt-composer /compose-and-respond returned ${res.status}: ${text.slice(0, 500)}`,
        res.status,
      )
    }
    const json = await res.json() as { success: boolean; data: ComposeResponse; error?: unknown }
    if (!json.success) {
      throw new PromptComposerError('prompt-composer returned success=false', 502, json.error)
    }
    return json.data
  },
}
