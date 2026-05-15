import { config } from '../../../config'
import type { LLMProvider, LLMRequest, LLMResponse } from './LLMProvider'

/**
 * M33 — Direct call to the central LLM gateway for the legacy local
 * AgentRun adapter (POST /api/agents/:id/runs). Workgraph never calls
 * provider URLs directly; provider keys live on llm-gateway-service.
 *
 * Previously this routed through MCP /mcp/invoke (an extra hop through the
 * agent loop). For a one-shot completion that's wasteful — talk to the
 * gateway directly. The agent-loop path (full AGENT_TASK execution) is
 * unchanged and still flows through context-fabric → MCP → gateway.
 */
export class GatewayProvider implements LLMProvider {
  readonly providerName = 'LLM_GATEWAY'

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const url = config.LLM_GATEWAY_URL.trim()
    if (!url) throw new Error('LLM_GATEWAY_URL is not configured')

    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = []
    if (request.systemPrompt) {
      messages.push({ role: 'system', content: request.systemPrompt })
    }
    for (const m of request.messages) {
      messages.push({ role: m.role, content: m.content })
    }

    if (url === 'mock') {
      // In-process mock for tests / smoke runs without a live gateway.
      const inputText = messages.map(m => m.content || '').join('\n')
      const reply = `[mock] Received ${messages.length} message(s) (${inputText.length} chars). No tool call needed.`
      return {
        content: reply,
        inputTokens: Math.max(1, Math.ceil(inputText.length / 4)),
        outputTokens: Math.max(1, Math.ceil(reply.length / 4)),
        stopReason: 'stop',
      }
    }

    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (config.LLM_GATEWAY_BEARER) headers.authorization = `Bearer ${config.LLM_GATEWAY_BEARER}`

    const res = await fetch(`${url.replace(/\/$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        // The legacy Agent.model column is treated as a curated gateway alias.
        // Raw provider/model overrides are intentionally not sent.
        model_alias: request.model,
        messages,
        temperature: request.temperature,
        max_output_tokens: request.maxTokens,
      }),
      signal: AbortSignal.timeout(config.LLM_GATEWAY_TIMEOUT_SEC * 1000),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`LLM_GATEWAY_UPSTREAM (${res.status}): ${detail.slice(0, 500)}`)
    }
    const body = await res.json() as {
      content?: string
      input_tokens?: number
      output_tokens?: number
      finish_reason?: string
    }
    return {
      content: body.content ?? '',
      inputTokens: body.input_tokens ?? 0,
      outputTokens: body.output_tokens ?? 0,
      stopReason: body.finish_reason ?? 'stop',
    }
  }
}
