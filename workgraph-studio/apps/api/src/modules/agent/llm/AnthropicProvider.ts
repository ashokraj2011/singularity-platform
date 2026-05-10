import axios from 'axios'
import { config } from '../../../config'
import type { LLMProvider, LLMRequest, LLMResponse } from './LLMProvider'

export class AnthropicProvider implements LLMProvider {
  readonly providerName = 'ANTHROPIC'

  async complete(request: LLMRequest): Promise<LLMResponse> {
    if (!config.ANTHROPIC_API_KEY) {
      // Return a mock response when no API key is configured
      return {
        content: `[Mock response for: ${request.messages[request.messages.length - 1]?.content ?? 'unknown'}]`,
        inputTokens: 0,
        outputTokens: 0,
        stopReason: 'end_turn',
      }
    }

    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: request.model,
        max_tokens: request.maxTokens ?? 4096,
        ...(request.systemPrompt && { system: request.systemPrompt }),
        messages: request.messages,
      },
      {
        headers: {
          'x-api-key': config.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
      },
    )

    const data = response.data
    return {
      content: data.content[0]?.text ?? '',
      inputTokens: data.usage?.input_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
      stopReason: data.stop_reason ?? 'end_turn',
    }
  }
}
