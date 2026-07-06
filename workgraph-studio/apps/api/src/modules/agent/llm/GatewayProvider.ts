import { config } from '../../../config'
import { contextFabricClient } from '../../../lib/context-fabric/client'
import { traceIdFromParts } from '@workgraph/shared-types'
import type { LLMProvider, LLMRequest, LLMResponse } from './LLMProvider'

/**
 * Routes one-shot legacy agent completions through Context Fabric's governed
 * single-turn endpoint. The retired MCP loop is intentionally not used;
 * Context Fabric owns the audit trail and policy posture for this path.
 *
 * Used by the legacy POST /api/agents/:id/runs adapter. The full
 * AGENT_TASK execution path is unchanged.
 */
export class GatewayProvider implements LLMProvider {
  readonly providerName = 'CONTEXT_FABRIC_GATEWAY'

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const systemPrompt = request.systemPrompt || undefined
    const userMessage = request.messages
      .filter(m => m.role === 'user')
      .map(m => m.content)
      .join('\n') || 'No user message provided.'

    if (config.CONTEXT_FABRIC_URL.trim() === 'mock') {
      // In-process mock for tests / smoke runs without a live MCP server.
      const inputText = [systemPrompt ?? '', ...request.messages.map(m => m.content || '')].join('\n')
      const reply = `[mock] Received ${request.messages.length} message(s) (${inputText.length} chars). No tool call needed.`
      return {
        content: reply,
        inputTokens: Math.max(1, Math.ceil(inputText.length / 4)),
        outputTokens: Math.max(1, Math.ceil(reply.length / 4)),
        stopReason: 'stop',
      }
    }

    const response = await contextFabricClient.executeGovernedTurn({
      trace_id: traceIdFromParts(['legacy-agent-run', Date.now()]),
      run_context: {
        source_type: 'workgraph-legacy-agent-run',
        workflow_node_id: 'legacy-agent-run',
      },
      task: userMessage,
      ...(systemPrompt ? { system_prompt: systemPrompt } : {}),
      model_overrides: {
        modelAlias: request.model,
        temperature: request.temperature,
        maxOutputTokens: request.maxTokens,
      },
      limits: {
        outputTokenBudget: request.maxTokens,
        timeoutSec: config.LLM_GATEWAY_TIMEOUT_SEC,
      },
    })

    return {
      content: response.finalResponse ?? '',
      inputTokens: response.usage?.inputTokens ?? response.modelUsage?.inputTokens ?? response.tokensUsed?.input ?? 0,
      outputTokens: response.usage?.outputTokens ?? response.modelUsage?.outputTokens ?? response.tokensUsed?.output ?? 0,
      stopReason: response.finishReason ?? 'stop',
    }
  }
}
