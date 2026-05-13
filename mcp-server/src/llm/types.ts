export type Role = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: Role;
  content: string;
  tool_call_id?: string;
  tool_name?: string;
}

export interface ToolDescriptorForLlm {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface LlmRequest {
  provider: string;
  model: string;
  messages: ChatMessage[];
  tools?: ToolDescriptorForLlm[];
  temperature?: number;
  max_output_tokens?: number;
}

export interface LlmStreamHooks {
  onDelta?: (delta: { content: string; index?: number; raw?: unknown }) => void | Promise<void>;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export type FinishReason = "stop" | "tool_call" | "length" | "error";

export interface LlmResponse {
  content: string;
  tool_calls?: ToolCall[];
  finish_reason: FinishReason;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
}
