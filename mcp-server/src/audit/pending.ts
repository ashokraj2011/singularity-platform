/**
 * Pending-approval store (M9.z).
 *
 * When the agent loop hits a tool with `requires_approval=true` we don't
 * just fail — we persist a "continuation envelope" containing everything
 * needed to resume the loop after a human approves the tool call:
 *
 *   - message history up to (but not including) the approval-blocked tool
 *   - the pending tool_call exactly as the LLM emitted it
 *   - the available-tool list (so resume uses the same catalogue)
 *   - model config + correlation set + step counter
 *
 * On `/mcp/resume`, we look up the envelope by `continuation_token`,
 * execute the approved tool (or skip if rejected), append the result, and
 * call back into the agent loop.
 *
 * v0 = in-memory map with TTL. M9.z+ may persist to disk so restarts don't
 * drop pending approvals.
 */
import { v4 as uuidv4 } from "uuid";
import { ChatMessage, ToolCall, ToolDescriptorForLlm } from "../llm/types";
import { CorrelationIds } from "./store";

export interface PendingApproval {
  continuation_token: string;
  trace_id?: string;
  mcp_invocation_id: string;
  created_at: string;
  expires_at: string;
  // Loop state
  messages: ChatMessage[];
  pending_tool_call: ToolCall;
  pending_tool_descriptor: PendingToolDescriptor;
  available_tools: ToolDescriptorForLlm[];
  full_tool_descriptors: PendingToolDescriptor[];
  model_config: {
    provider: string;
    model: string;
    temperature?: number;
    maxTokens?: number;
  };
  correlation: CorrelationIds;
  step_index: number;
  max_steps: number;
  // Accumulated audit so the resumed run preserves history across the pause
  llm_call_ids: string[];
  tool_invocation_ids: string[];
  artifact_ids: string[];
  /** M13 — preserved across approval pauses so code-change provenance survives. */
  code_change_ids?: string[];
  total_input_tokens: number;
  total_output_tokens: number;
}

export interface PendingToolDescriptor {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  execution_target: "LOCAL" | "SERVER";
  natural_language?: string;
  risk_level?: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  requires_approval?: boolean;
}

const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const store = new Map<string, PendingApproval>();

function purgeExpired(): void {
  const now = Date.now();
  for (const [token, env] of store) {
    if (Date.parse(env.expires_at) < now) store.delete(token);
  }
}

export function savePending(
  input: Omit<PendingApproval, "continuation_token" | "created_at" | "expires_at">,
): PendingApproval {
  purgeExpired();
  const continuation_token = `cnt-${uuidv4()}`;
  const now = new Date();
  const env: PendingApproval = {
    continuation_token,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + TTL_MS).toISOString(),
    ...input,
  };
  store.set(continuation_token, env);
  return env;
}

export function takePending(token: string): PendingApproval | undefined {
  purgeExpired();
  const env = store.get(token);
  if (env) store.delete(token); // single-use
  return env;
}

export function peekPending(token: string): PendingApproval | undefined {
  purgeExpired();
  return store.get(token);
}

export function recentPending(limit = 50): PendingApproval[] {
  purgeExpired();
  return Array.from(store.values()).slice(-limit).reverse();
}
