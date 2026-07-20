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

export interface PromptCacheRequest {
  enabled?: boolean;
  strategy?: "provider_auto" | "anthropic_cache_control" | "copilot_gateway" | string;
  key?: string;
}

export type PromptCacheUsage = Record<string, unknown>;

export interface LlmRequest {
  model_alias?: string;
  // Provider/model are retained only as audit metadata on the MCP side. The
  // gateway call must use model_alias or its configured default alias.
  provider?: string;
  model?: string;
  prompt_cache?: PromptCacheRequest;
  messages: ChatMessage[];
  tools?: ToolDescriptorForLlm[];
  temperature?: number;
  max_output_tokens?: number;

  // ── caller identity (gateway attribution) ────────────────────────────────
  // WHO this call is for. mcp-server already threads a full CorrelationIds
  // through its own audit store; these carry the same identity ONE HOP FURTHER
  // so the gateway's cost row is attributable too.
  //
  // ATTRIBUTION, NOT AUTHORIZATION — the gateway is behind one shared bearer,
  // so any of these is a claim. Do not gate access on them.
  actor_id?: string;
  tenant_id?: string;
  session_id?: string;
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
  provider?: string;
  model?: string;
  model_alias?: string;
  estimated_cost?: number;
  prompt_cache?: PromptCacheUsage;
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
