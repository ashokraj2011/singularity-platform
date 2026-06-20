import axios from 'axios'
import type { ConnectorAdapter, OperationDef } from '../connector-adapter'
import { assertEventTargetUrlAllowed } from '../../../lib/eventbus/target-url-policy'
import { contextFabricClient } from '../../../lib/context-fabric/client'

const LOCAL_MCP_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  'host.docker.internal',
  'mcp-server',
  'singularity-mcp-server',
])

/**
 * Governed LLM connector adapter.
 *
 * Compatibility adapter for existing "LLM Gateway" connector rows. Runtime
 * chat/complete calls route through Context Fabric's governed single-turn API.
 * Embeddings stay on MCP's active /mcp/embed endpoint.
 *
 * baseUrl examples:
 *   docker-compose:  http://mcp-server:7100
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

  private async safeBaseUrl(): Promise<string> {
    let parsed: URL
    try {
      parsed = new URL(this.config.baseUrl)
    } catch {
      throw new Error('LLM Gateway connector baseUrl must be absolute')
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('LLM Gateway connector baseUrl must use http or https')
    }
    if (parsed.username || parsed.password) {
      throw new Error('LLM Gateway connector baseUrl must not include embedded credentials')
    }
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    if (LOCAL_MCP_HOSTS.has(host)) return parsed.toString().replace(/\/$/, '')
    const safePublicUrl = await assertEventTargetUrlAllowed(parsed.toString())
    if (safePublicUrl.protocol !== 'https:') {
      throw new Error('Remote LLM Gateway connector baseUrl must use https')
    }
    return safePublicUrl.toString().replace(/\/$/, '')
  }

  private async client() {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    // MCP accepts an optional bearer; only attach when the connector config supplied one.
    if (this.creds?.apiKey) headers.Authorization = `Bearer ${this.creds.apiKey}`
    return axios.create({
      baseURL: await this.safeBaseUrl(),
      headers,
      timeout: 120_000,
    })
  }

  async testConnection() {
    try {
      const client = await this.client()
      await client.get('/health')
      return { ok: true }
    }
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
    const conversational = messages.filter((
      m,
    ): m is { role: 'user' | 'assistant' | 'tool'; content: string } => m.role !== 'system')
    const lastUserIndex = conversational.map(m => m.role).lastIndexOf('user')
    const messageIndex = lastUserIndex >= 0 ? lastUserIndex : conversational.length - 1
    const selected = conversational[messageIndex]

    const task = this.formatConversationTask(
      conversational.filter((_, index) => index !== messageIndex),
      selected?.content ?? String(p.prompt ?? 'Continue.'),
    )
    const response = await contextFabricClient.executeGovernedTurn({
      trace_id: `connector-llm-${Date.now()}`,
      run_context: {
        source_type: 'workgraph-llm-gateway-connector',
        workflow_node_id: 'connector-llm-gateway',
      },
      task,
      ...(systemPrompt ? { system_prompt: systemPrompt } : {}),
      model_overrides: {
        ...(modelAlias ? { modelAlias } : {}),
        ...(p.temperature !== undefined ? { temperature: Number(p.temperature) } : (this.config.defaultTemperature !== undefined ? { temperature: this.config.defaultTemperature } : {})),
        ...(p.maxTokens !== undefined ? { maxOutputTokens: Number(p.maxTokens) } : (this.config.defaultMaxTokens !== undefined ? { maxOutputTokens: this.config.defaultMaxTokens } : {})),
      },
      limits: {
        timeoutSec: 120,
        ...(p.maxTokens !== undefined ? { outputTokenBudget: Number(p.maxTokens) } : (this.config.defaultMaxTokens !== undefined ? { outputTokenBudget: this.config.defaultMaxTokens } : {})),
      },
    })
    const usage: { input?: number; output?: number } = response.tokensUsed ?? {}
    const modelUsage = response.modelUsage ?? response.usage ?? {}
    return {
      content: response.finalResponse ?? '',
      model: modelUsage.model,
      provider: modelUsage.provider,
      modelAlias: modelUsage.modelAlias,
      finishReason: response.finishReason,
      usage: {
        input_tokens: usage.input ?? modelUsage.inputTokens,
        output_tokens: usage.output ?? modelUsage.outputTokens,
        latency_ms: response.metrics?.mcpLatencyMs,
      },
    }
  }

  private formatConversationTask(
    history: Array<{ role: 'user' | 'assistant' | 'tool'; content: string }>,
    currentMessage: string,
  ): string {
    if (history.length === 0) return currentMessage
    const prior = history
      .map(m => `${m.role.toUpperCase()}: ${m.content}`)
      .join('\n')
    return `${prior}\nUSER: ${currentMessage}`
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
    const client = await this.client()
    const r = await client.post('/mcp/embed', {
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
        label: 'LLM Chat (governed)',
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
        label: 'LLM Complete (governed)',
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
