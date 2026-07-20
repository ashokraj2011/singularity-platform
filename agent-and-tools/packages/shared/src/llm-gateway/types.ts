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

export interface ChatCompletionRequest {
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

  /**
   * WHAT this call is for — one of the gateway's task-tag vocabulary
   * (llm_gateway_service/app/task_tags.py). This client does NOT default it:
   * every caller has a different bucket (capsule_compile, summarise, judge, …)
   * and a hardcoded default here would relabel all of them as one thing, which
   * is worse than untagged because it looks correct.
   */
  task_tag?: string;
  /** Narrower than task_tag, when the caller knows more. */
  stage?: string;
  purpose?: string;

  /**
   * WHO this call is for.
   *
   * Convention: `actor_id` is never null. A human is a user id; a background
   * call is `system:<service-name>`. That keeps null meaning "somebody forgot to
   * propagate it" instead of blurring into "no human involved".
   *
   * ATTRIBUTION, NOT AUTHORIZATION — the gateway sits behind one shared bearer,
   * so any caller can claim any actor or tenant. Fine for cost reporting;
   * categorically not a basis for tenant isolation.
   */
  actor_id?: string;
  /** Only set this where the caller genuinely has a tenant. Never a default. */
  tenant_id?: string;
  session_id?: string;
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
  /** Defaults to "embedding" at the gateway — there is only one reason to call
   *  this endpoint — so callers only set it to say something more specific. */
  task_tag?: string;
  stage?: string;
  purpose?: string;
  /** See ChatCompletionRequest: attribution, not authorization. */
  actor_id?: string;
  tenant_id?: string;
  session_id?: string;
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
