/**
 * MCP-routed LLM wire types.
 *
 * Preserves the previous chat/embedding request shapes for call sites while
 * the shared client routes chat requests through MCP.
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

/**
 * WHAT a call is for, as opposed to WHICH model it wants.
 *
 * The gateway's policy engine routes on these. Until they existed on this
 * interface every TS caller could only express intent by naming a model, which
 * is why the platform accumulated twenty-odd `*_MODEL_ALIAS` env vars: an alias
 * was the only vocabulary available for saying "this is background distillation,
 * not an agent turn". A caller that sends `task_tag` and no alias is asking the
 * gateway to choose; a caller that sends an alias is pinning, and pins still win.
 */
export interface TaskIdentity {
  /** Coarse bucket: agent_turn, embedding, summarise, judge, capsule_compile, … */
  task_tag?: string;
  /** Narrows the tag when the caller knows the workflow stage. */
  stage?: string;
  /** Narrows the tag when the caller knows the specific job. */
  purpose?: string;
}

export interface ChatCompletionRequest extends TaskIdentity {
  /** Preferred — pick a curated alias from .singularity/llm-models.json. */
  model_alias?: string;

  messages: ChatMessage[];
  tools?: ToolDescriptor[];
  temperature?: number;
  max_output_tokens?: number;

  /** Streaming is not yet implemented. */
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

export interface EmbeddingsRequest extends TaskIdentity {
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
