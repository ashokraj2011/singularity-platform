/**
 * Prompt Composer HTTP client — M5 wire.
 *
 * Legacy Prompt Composer HTTP client.
 *
 * Workgraph AGENT_TASK now calls context-fabric /execute directly. Context
 * Fabric invokes prompt-composer in preview mode, then dispatches through MCP.
 * This client is kept for older code paths and direct preview tooling.
 *
 * POST /api/v1/compose-and-respond on prompt-composer:
 *   1. Assembles the layered prompt from PromptProfile + capability context +
 *      knowledge artifacts + distilled memory + tool grants + workflow vars +
 *      artifacts + EXECUTION_OVERRIDE layers.
 *   2. For non-preview calls, delegates to context-fabric /execute and returns
 *      the unified response.
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

// M36.1 — Stage-prompt resolution. Callers stop hardcoding prompt strings
// in TS source and instead pass {stageKey, agentRole?, vars} here. Composer
// reads StagePromptBinding → PromptProfile, renders the taskTemplate
// (Mustache `{{var}}` substitution), and returns the ready-to-use task body
// plus a system-prompt fragment to splice into the /compose-and-respond call.
export interface ResolveStageRequest {
  stageKey: string
  agentRole?: string
  vars?: Record<string, unknown>
}

export interface ResolveStageResponse {
  task: string
  systemPromptAppend: string
  // M36.6 — rendered extraContext (empty string if the bound profile has no
  // extraContextTemplate). Workbench loop runner uses this so the
  // per-execution policy block is also DB-owned.
  extraContext: string
  promptProfileId: string
  bindingId: string
  stageKey: string
  agentRole: string | null
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

  // M36.1 — Resolve a (stageKey, agentRole) tuple to a rendered task + system
  // prompt. Replaces inline architectTask/developerTask/qaTask/stageSystemPrompt
  // /loopStageTask/loopStageSystemPrompt in workgraph-api source. Edit the
  // prompts via prompt-composer's seed.ts (or live via a future admin UI);
  // workgraph-api carries no prompt text after M36.2.
  async resolveStage(input: ResolveStageRequest): Promise<ResolveStageResponse> {
    const url = `${config.PROMPT_COMPOSER_URL}/api/v1/stage-prompts/resolve`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new PromptComposerError(
        `prompt-composer /stage-prompts/resolve returned ${res.status}: ${text.slice(0, 500)}`,
        res.status,
      )
    }
    const json = await res.json() as { success: boolean; data: ResolveStageResponse; error?: unknown }
    if (!json.success) {
      throw new PromptComposerError('prompt-composer stage resolve returned success=false', 502, json.error)
    }
    return json.data
  },
}
