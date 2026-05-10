export interface LLMMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface LLMRequest {
  model: string
  systemPrompt?: string
  messages: LLMMessage[]
  maxTokens?: number
  temperature?: number
}

export interface LLMResponse {
  content: string
  inputTokens: number
  outputTokens: number
  stopReason: string
}

export interface LLMProvider {
  readonly providerName: string
  complete(request: LLMRequest): Promise<LLMResponse>
}
