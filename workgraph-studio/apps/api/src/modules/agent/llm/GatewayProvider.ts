import { config } from '../../../config'
import type { LLMProvider, LLMRequest, LLMResponse } from './LLMProvider'

/**
 * M33→M34 — Routes one-shot LLM completions through the MCP Server's
 * /mcp/invoke endpoint. The legacy llm-gateway-service has been retired;
 * all LLM egress now flows through the MCP Server which owns provider
 * keys, retry logic, and cost tracking.
 *
 * Used by the legacy POST /api/agents/:id/runs adapter. The full
 * AGENT_TASK execution path (context-fabric → MCP → LLM) is unchanged.
 */
export class GatewayProvider implements LLMProvider {
  readonly providerName = 'MCP_GATEWAY'

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const mcpUrl = config.MCP_SERVER_URL.trim()
    if (!mcpUrl) throw new Error('MCP_SERVER_URL is not configured')

    // Build the message for the MCP invoke payload.
    const systemPrompt = request.systemPrompt || undefined
    const userMessage = request.messages
      .filter(m => m.role === 'user')
      .map(m => m.content)
      .join('\n') || 'No user message provided.'

    const history = request.messages
      .filter(m => m.role === 'assistant')
      .map(m => ({ role: m.role as 'assistant', content: m.content }))

    if (mcpUrl === 'mock') {
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

    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (config.MCP_BEARER_TOKEN) headers.authorization = `Bearer ${config.MCP_BEARER_TOKEN}`

    const res = await fetch(`${mcpUrl.replace(/\/$/, '')}/mcp/invoke`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        message: userMessage,
        systemPrompt,
        history,
        tools: [],       // one-shot completion — no tools
        maxSteps: 1,     // single LLM turn, no loop
        modelConfig: {
          modelAlias: request.model,
          temperature: request.temperature,
          maxTokens: request.maxTokens,
        },
      }),
      signal: AbortSignal.timeout(config.LLM_GATEWAY_TIMEOUT_SEC * 1000),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`MCP_GATEWAY (${res.status}): ${detail.slice(0, 500)}`)
    }
    const envelope = await res.json() as {
      success?: boolean
      data?: {
        finalResponse?: string
        tokensUsed?: { input?: number; output?: number }
        finishReason?: string
      }
    }
    const data = envelope.data ?? {}
    return {
      content: data.finalResponse ?? '',
      inputTokens: data.tokensUsed?.input ?? 0,
      outputTokens: data.tokensUsed?.output ?? 0,
      stopReason: data.finishReason ?? 'stop',
    }
  }
}
