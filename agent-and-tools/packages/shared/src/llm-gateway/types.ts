/**
 * M33 — Wire types for the central LLM gateway.
 *
 * Mirrors `context-fabric/services/llm_gateway_service/app/types.py`. The
 * shared package owns this contract so every TS consumer (mcp-server,
 * workgraph-api, prompt-composer, agent-runtime, …) imports the same
 * request/response shapes.
 */

export type Role = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: Role;
  content: string;
  tool_call_id?: string;
  tool_name?: string;
}

export interface ToolDescriptor {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export type FinishReason = "stop" | "tool_call" | "length" | "error";

export interface ChatCompletionRequest {
  /** Preferred — pick a curated alias from .singularity/mcp-models.json. */
  model_alias?: string;

  messages: ChatMessage[];
  tools?: ToolDescriptor[];
  temperature?: number;
  max_output_tokens?: number;

  /** Streaming is not yet implemented; gateway returns 400 if true. */
  stream?: boolean;

  /** Optional caller context for audit emission. */
  trace_id?: string;
  run_id?: string;
  capability_id?: string;
}

export interface ChatCompletionResponse {
  content: string;
  tool_calls?: ToolCall[];
  finish_reason: FinishReason;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
  provider: string;
  model: string;
  model_alias?: string;
}

export interface EmbeddingsRequest {
  model_alias?: string;
  input: string[];
  trace_id?: string;
  capability_id?: string;
}

export interface EmbeddingsResponse {
  embeddings: number[][];
  dim: number;
  provider: string;
  model: string;
  model_alias?: string;
  input_tokens: number;
  latency_ms: number;
}

/** Used by /llm/providers introspection. */
export interface GatewayProviderStatus {
  name: string;
  ready: boolean;
  allowed: boolean;
  default_model: string | null;
  warnings: string[];
}
