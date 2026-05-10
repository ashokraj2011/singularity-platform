import axios from 'axios'
import type { ConnectorAdapter, OperationDef } from '../connector-adapter'

interface LlmGatewayConfig {
  baseUrl: string
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
    try { await this.client.get('/models'); return { ok: true } }
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
    const r = await this.client.post('/chat/completions', {
      model: (p.model as string) ?? this.config.defaultModel ?? 'claude-sonnet-4-6',
      messages: p.messages,
      max_tokens: (p.maxTokens as number) ?? this.config.defaultMaxTokens ?? 4096,
      temperature: (p.temperature as number) ?? this.config.defaultTemperature ?? 1,
      system: p.systemPrompt,
    })
    const choice = r.data.choices?.[0]
    return {
      content: choice?.message?.content ?? r.data.content?.[0]?.text ?? '',
      model: r.data.model,
      usage: r.data.usage,
    }
  }

  private async complete(p: Record<string, unknown>) {
    // Builds a single-turn messages array from a prompt string
    return this.chat({
      ...p,
      messages: [{ role: 'user', content: p.prompt }],
    })
  }

  private async embed(p: Record<string, unknown>) {
    const r = await this.client.post('/embeddings', {
      model: (p.model as string) ?? this.config.defaultModel,
      input: p.input,
    })
    return r.data
  }

  listOperations(): OperationDef[] {
    return [
      { id: 'chat', label: 'Chat Completion', params: [{ key: 'messages', label: 'Messages (JSON array)', type: 'json', required: true }, { key: 'model', label: 'Model', type: 'string' }, { key: 'systemPrompt', label: 'System Prompt', type: 'text' }, { key: 'maxTokens', label: 'Max Tokens', type: 'number' }, { key: 'temperature', label: 'Temperature', type: 'number' }] },
      { id: 'complete', label: 'Complete (single prompt)', params: [{ key: 'prompt', label: 'Prompt', type: 'text', required: true }, { key: 'model', label: 'Model', type: 'string' }, { key: 'systemPrompt', label: 'System Prompt', type: 'text' }] },
      { id: 'embed', label: 'Embeddings', params: [{ key: 'input', label: 'Input text or array', type: 'text', required: true }, { key: 'model', label: 'Embedding Model', type: 'string' }] },
    ]
  }
}
