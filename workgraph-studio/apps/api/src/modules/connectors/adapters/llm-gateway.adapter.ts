import axios from 'axios'
import type { ConnectorAdapter, OperationDef } from '../connector-adapter'

interface LlmGatewayConfig {
  baseUrl: string
  defaultModelAlias?: string
  defaultModel?: string
  defaultMaxTokens?: number
  defaultTemperature?: number
}
interface LlmGatewayCredentials { apiKey: string }

export class LlmGatewayAdapter implements ConnectorAdapter {
  constructor(private config: LlmGatewayConfig, private creds: LlmGatewayCredentials) {}

  private get client() {
    return axios.create({
      baseURL: this.config.baseUrl.replace(/\/$/, ''),
      headers: { Authorization: `Bearer ${this.creds.apiKey}`, 'Content-Type': 'application/json' },
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
    const messages = Array.isArray(p.messages) ? p.messages as Array<{ role?: string; content?: string }> : []
    const last = messages[messages.length - 1]
    const history = messages.slice(0, -1).map(m => ({
      role: m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user',
      content: String(m.content ?? ''),
    }))
    const r = await this.client.post('/mcp/invoke', {
      systemPrompt: p.systemPrompt,
      history,
      message: String(last?.content ?? p.prompt ?? ''),
      tools: [],
      modelConfig: {
        modelAlias: (p.modelAlias as string) ?? this.config.defaultModelAlias ?? (p.model as string) ?? this.config.defaultModel,
        temperature: (p.temperature as number) ?? this.config.defaultTemperature,
        maxTokens: (p.maxTokens as number) ?? this.config.defaultMaxTokens,
      },
      runContext: { traceId: `connector-llm-${Date.now()}` },
      limits: { maxSteps: 1, timeoutSec: 120 },
    })
    const data = r.data?.data ?? r.data
    return {
      content: data?.finalResponse ?? '',
      model: data?.modelUsage?.model,
      usage: data?.modelUsage ?? data?.tokensUsed,
    }
  }

  private async complete(p: Record<string, unknown>) {
    // Builds a single-turn messages array from a prompt string
    return this.chat({
      ...p,
      messages: [{ role: 'user', content: p.prompt }],
    })
  }

  private async embed(_p: Record<string, unknown>) {
    throw new Error('Direct LLM gateway embeddings are disabled. Use the platform embedding provider config or MCP tools.')
  }

  listOperations(): OperationDef[] {
    return [
      { id: 'chat', label: 'MCP Chat', params: [{ key: 'messages', label: 'Messages (JSON array)', type: 'json', required: true }, { key: 'modelAlias', label: 'MCP Model Alias', type: 'string' }, { key: 'systemPrompt', label: 'System Prompt', type: 'text' }, { key: 'maxTokens', label: 'Max Tokens', type: 'number' }, { key: 'temperature', label: 'Temperature', type: 'number' }] },
      { id: 'complete', label: 'MCP Complete', params: [{ key: 'prompt', label: 'Prompt', type: 'text', required: true }, { key: 'modelAlias', label: 'MCP Model Alias', type: 'string' }, { key: 'systemPrompt', label: 'System Prompt', type: 'text' }] },
      { id: 'embed', label: 'Embeddings', params: [{ key: 'input', label: 'Input text or array', type: 'text', required: true }, { key: 'model', label: 'Embedding Model', type: 'string' }] },
    ]
  }
}
