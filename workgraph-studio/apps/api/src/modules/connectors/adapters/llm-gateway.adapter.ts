import axios from 'axios'
import type { ConnectorAdapter, OperationDef } from '../connector-adapter'

/**
 * MCP-routed LLM connector adapter.
 *
 * Compatibility adapter for existing "LLM Gateway" connector rows. Runtime
 * calls point at MCP; MCP is the only service allowed to talk to the gateway.
 *
 * baseUrl examples:
 *   docker-compose:  http://mcp-server-demo:7100
 *   bare-metal dev:  http://localhost:7100
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
    // MCP accepts an optional bearer; only attach when the connector config supplied one.
    if (this.creds?.apiKey) headers.Authorization = `Bearer ${this.creds.apiKey}`
    return axios.create({
      baseURL: this.config.baseUrl.replace(/\/$/, ''),
      headers,
      timeout: 120_000,
    })
  }

  async testConnection() {
    try { await this.client.get('/health'); return { ok: true } }
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
    const systemPrompt = messages
      .filter(m => m.role === 'system')
      .map(m => m.content)
      .join('\n\n')
      .trim()
    const conversational = messages.filter(m => m.role !== 'system')
    const lastUserIndex = conversational.map(m => m.role).lastIndexOf('user')
    const messageIndex = lastUserIndex >= 0 ? lastUserIndex : conversational.length - 1
    const selected = conversational[messageIndex]

    const r = await this.client.post('/mcp/invoke', {
      ...(systemPrompt ? { systemPrompt } : {}),
      history: conversational.filter((_, index) => index !== messageIndex),
      message: selected?.content ?? String(p.prompt ?? 'Continue.'),
      tools: [],
      modelConfig: {
        ...(modelAlias ? { modelAlias } : {}),
        ...(p.temperature !== undefined ? { temperature: p.temperature } : (this.config.defaultTemperature !== undefined ? { temperature: this.config.defaultTemperature } : {})),
        ...(p.maxTokens !== undefined ? { maxTokens: p.maxTokens } : (this.config.defaultMaxTokens !== undefined ? { maxTokens: this.config.defaultMaxTokens } : {})),
      },
      runContext: { traceId: `connector-llm-${Date.now()}` },
      limits: {
        maxSteps: 1,
        timeoutSec: 120,
        compressToolResults: true,
        includeLocalTools: false,
      },
    })
    const data = r.data?.data ?? {}
    const usage = data.tokensUsed ?? {}
    const modelUsage = data.modelUsage ?? {}
    return {
      content: data.finalResponse ?? '',
      model: modelUsage.model,
      provider: modelUsage.provider,
      modelAlias: modelUsage.modelAlias,
      finishReason: data.finishReason,
      usage: {
        input_tokens: usage.input ?? modelUsage.inputTokens,
        output_tokens: usage.output ?? modelUsage.outputTokens,
        latency_ms: data.metrics?.mcpLatencyMs,
      },
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
      throw new Error('MCP embed: `input` must be a non-empty string or string[]')
    }
    const modelAlias = (p.modelAlias as string) ?? this.config.defaultModelAlias
    const r = await this.client.post('/mcp/embed', {
      ...(modelAlias ? { modelAlias } : {}),
      input,
      runContext: { traceId: `connector-emb-${Date.now()}` },
    })
    const data = r.data?.data ?? {}
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
        label: 'LLM Chat (via MCP)',
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
        label: 'LLM Complete (via MCP)',
        params: [
          { key: 'prompt', label: 'Prompt', type: 'text', required: true },
          { key: 'modelAlias', label: 'Model alias', type: 'string' },
          { key: 'systemPrompt', label: 'System prompt', type: 'text' },
        ],
      },
      {
        id: 'embed',
        label: 'Embeddings (via MCP)',
        params: [
          { key: 'input', label: 'Input text or string[]', type: 'text', required: true },
          { key: 'modelAlias', label: 'Embeddings alias', type: 'string' },
        ],
      },
    ]
  }
}
