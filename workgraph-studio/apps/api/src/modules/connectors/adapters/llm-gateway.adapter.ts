import axios from 'axios'
import type { ConnectorAdapter, OperationDef } from '../connector-adapter'

/**
 * M33 — LLM Gateway connector adapter.
 *
 * Points at the central llm-gateway-service (context-fabric, port 8001).
 * The gateway is the only place provider keys live; there is no provider
 * fallback chain — gateway errors propagate. The only allowed fallback is
 * the gateway's `mock` provider.
 *
 * baseUrl examples:
 *   docker-compose:  http://llm-gateway:8001
 *   bare-metal dev:  http://localhost:8001
 *   tests:           mock                       (not yet wired; use real gateway)
 */
interface LlmGatewayConfig {
  baseUrl: string
  defaultModelAlias?: string
  defaultMaxTokens?: number
  defaultTemperature?: number
}
interface LlmGatewayCredentials { apiKey?: string }

export class LlmGatewayAdapter implements ConnectorAdapter {
  constructor(private config: LlmGatewayConfig, private creds: LlmGatewayCredentials) {}

  private get client() {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    // The gateway accepts an optional bearer (LLM_GATEWAY_BEARER); only
    // attach when the connector config supplied one.
    if (this.creds?.apiKey) headers.Authorization = `Bearer ${this.creds.apiKey}`
    return axios.create({
      baseURL: this.config.baseUrl.replace(/\/$/, ''),
      headers,
      timeout: 120_000,
    })
  }

  async testConnection() {
    try { await this.client.get('/llm/models'); return { ok: true } }
    catch (e: any) { return { ok: false, error: e?.message } }
  }

  async invoke(operation: string, params: Record<string, unknown>) {
    switch (operation) {
      case 'chat':      return this.chat(params)
      case 'complete':  return this.complete(params)
      case 'embed':     return this.embed(params)
      default: throw new Error(`Unknown LLM Gateway operation: ${operation}`)
    }
  }

  private async chat(p: Record<string, unknown>) {
    const rawMessages = Array.isArray(p.messages)
      ? (p.messages as Array<{ role?: string; content?: string }>)
      : []
    const messages: Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content: string }> = []
    if (typeof p.systemPrompt === 'string' && p.systemPrompt.trim().length > 0) {
      messages.push({ role: 'system', content: String(p.systemPrompt) })
    }
    for (const m of rawMessages) {
      const role = m.role === 'assistant' ? 'assistant'
                 : m.role === 'system'    ? 'system'
                 : m.role === 'tool'      ? 'tool'
                 :                          'user'
      messages.push({ role, content: String(m.content ?? '') })
    }
    if (messages.filter(m => m.role !== 'system').length === 0 && typeof p.prompt === 'string') {
      messages.push({ role: 'user', content: String(p.prompt) })
    }

    const modelAlias = (p.modelAlias as string) ?? this.config.defaultModelAlias

    const r = await this.client.post('/v1/chat/completions', {
      ...(modelAlias ? { model_alias: modelAlias } : {}),
      messages,
      ...(p.temperature !== undefined ? { temperature: p.temperature } : (this.config.defaultTemperature !== undefined ? { temperature: this.config.defaultTemperature } : {})),
      ...(p.maxTokens !== undefined ? { max_output_tokens: p.maxTokens } : (this.config.defaultMaxTokens !== undefined ? { max_output_tokens: this.config.defaultMaxTokens } : {})),
      trace_id: `connector-llm-${Date.now()}`,
    })
    const data = r.data ?? {}
    return {
      content: data.content ?? '',
      model: data.model,
      provider: data.provider,
      modelAlias: data.model_alias,
      finishReason: data.finish_reason,
      usage: { input_tokens: data.input_tokens, output_tokens: data.output_tokens, latency_ms: data.latency_ms },
    }
  }

  private async complete(p: Record<string, unknown>) {
    return this.chat({ ...p, messages: [{ role: 'user', content: p.prompt }] })
  }

  private async embed(p: Record<string, unknown>) {
    const rawInput = p.input
    const input = Array.isArray(rawInput)
      ? rawInput.map(v => String(v))
      : (typeof rawInput === 'string' ? [rawInput] : [])
    if (input.length === 0) {
      throw new Error('LLM Gateway embed: `input` must be a non-empty string or string[]')
    }
    const modelAlias = (p.modelAlias as string) ?? this.config.defaultModelAlias
    const r = await this.client.post('/v1/embeddings', {
      ...(modelAlias ? { model_alias: modelAlias } : {}),
      input,
      trace_id: `connector-emb-${Date.now()}`,
    })
    const data = r.data ?? {}
    return {
      embeddings: data.embeddings ?? [],
      dim: data.dim,
      model: data.model,
      provider: data.provider,
      modelAlias: data.model_alias,
      usage: { input_tokens: data.input_tokens, latency_ms: data.latency_ms },
    }
  }

  listOperations(): OperationDef[] {
    return [
      {
        id: 'chat',
        label: 'LLM Chat (via gateway)',
        params: [
          { key: 'messages', label: 'Messages (JSON array)', type: 'json', required: true },
          { key: 'modelAlias', label: 'Model alias (e.g. fast, balanced, mock)', type: 'string' },
          { key: 'systemPrompt', label: 'System prompt', type: 'text' },
          { key: 'maxTokens', label: 'Max output tokens', type: 'number' },
          { key: 'temperature', label: 'Temperature', type: 'number' },
        ],
      },
      {
        id: 'complete',
        label: 'LLM Complete (via gateway)',
        params: [
          { key: 'prompt', label: 'Prompt', type: 'text', required: true },
          { key: 'modelAlias', label: 'Model alias', type: 'string' },
          { key: 'systemPrompt', label: 'System prompt', type: 'text' },
        ],
      },
      {
        id: 'embed',
        label: 'Embeddings (via gateway)',
        params: [
          { key: 'input', label: 'Input text or string[]', type: 'text', required: true },
          { key: 'modelAlias', label: 'Embeddings alias', type: 'string' },
        ],
      },
    ]
  }
}
