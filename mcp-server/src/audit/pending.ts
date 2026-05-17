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
import { createHmac } from "node:crypto";
import { ChatMessage, ToolCall, ToolDescriptorForLlm } from "../llm/types";
import { CorrelationIds } from "./store";
import type { GovernanceMode } from "../lib/audit-gov-check";
import { config } from "../config";

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
    modelAlias?: string;
    provider: string;
    model: string;
    temperature?: number;
    maxTokens?: number;
    warnings?: string[];
  };
  correlation: CorrelationIds;
  step_index: number;
  max_steps: number;
  max_tool_result_chars?: number;
  // Accumulated audit so the resumed run preserves history across the pause
  llm_call_ids: string[];
  tool_invocation_ids: string[];
  artifact_ids: string[];
  /** M13 — preserved across approval pauses so code-change provenance survives. */
  code_change_ids?: string[];
  /** Workspace branch/index metadata preserved across approval pauses. */
  workspace?: {
    branch?: {
      branch: string;
      baseBranch?: string;
      headSha?: string;
      workspaceRoot?: string;
      reused: boolean;
    } | null;
    workspaceRoot?: string;
    commitSha?: string;
    changedPaths?: string[];
    astIndexStatus?: string;
    astIndexedFiles?: number;
    astIndexedSymbols?: number;
  };
  total_input_tokens: number;
  total_output_tokens: number;
  governance_mode?: GovernanceMode;
  context_plan_hash?: string;
  degraded_actions_allowed?: string[];
  allow_autonomous_mutation?: boolean;
  tool_use_nudge_count?: number;
}

export interface PendingToolDescriptor {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  execution_target: "LOCAL" | "SERVER";
  version?: string;
  natural_language?: string;
  risk_level?: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  requires_approval?: boolean;
}

const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const store = new Map<string, PendingApproval>();
const redeemed = new Set<string>(); // Track single-use tokens that have been consumed

function purgeExpired(): void {
  const now = Date.now();
  for (const [token, env] of store) {
    if (Date.parse(env.expires_at) < now) store.delete(token);
  }
}

/**
 * M35.2 — Sign continuation token as:
 * cnt-<base64url(HMAC-SHA256(uuid||expires_at_ms, MCP_BEARER_TOKEN))>.<uuid>.<expires_at_ms>
 *
 * This prevents same-process replay attacks and ensures only this server
 * (with MCP_BEARER_TOKEN) can mint valid tokens.
 */
function signToken(uuid: string, expiresAtMs: number): string {
  const message = `${uuid}||${expiresAtMs}`;
  const hmac = createHmac("sha256", config.MCP_BEARER_TOKEN);
  hmac.update(message);
  const sig = hmac.digest("base64url");
  return `cnt-${sig}.${uuid}.${expiresAtMs}`;
}

/**
 * M35.2 — Verify continuation token signature and expiry.
 * Returns { valid: true } or { valid: false, reason: string }
 */
function verifyToken(
  token: string,
): { valid: true } | { valid: false; reason: "invalid_signature" | "expired_token" | "malformed_token" } {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[0].startsWith("cnt-")) {
    return { valid: false, reason: "malformed_token" };
  }
  const [prefixWithSig, uuid, expiresAtMsStr] = parts;
  const sig = prefixWithSig.slice(4); // Remove "cnt-" prefix

  const expiresAtMs = Number(expiresAtMsStr);
  if (isNaN(expiresAtMs)) {
    return { valid: false, reason: "malformed_token" }; // Invalid format → malformed
  }

  // Check expiry before verifying signature (fail fast)
  const now = Date.now();
  if (expiresAtMs < now) {
    return { valid: false, reason: "expired_token" };
  }

  // Verify HMAC signature
  const expected = signToken(uuid, expiresAtMs);
  const expectedSig = expected.split(".")[0].slice(4); // Extract just the signature part
  if (sig !== expectedSig) {
    return { valid: false, reason: "invalid_signature" }; // Signature mismatch
  }

  return { valid: true };
}

export function savePending(
  input: Omit<PendingApproval, "continuation_token" | "created_at" | "expires_at">,
): PendingApproval {
  purgeExpired();
  const uuid = uuidv4();
  const now = new Date();
  const expiresAtMs = now.getTime() + TTL_MS;
  const continuation_token = signToken(uuid, expiresAtMs); // M35.2 — signed token
  const env: PendingApproval = {
    continuation_token,
    created_at: now.toISOString(),
    expires_at: new Date(expiresAtMs).toISOString(),
    ...input,
  };
  store.set(continuation_token, env);
  return env;
}

export type TakePendingResult =
  | { ok: true; approval: PendingApproval }
  | { ok: false; reason: "invalid_signature" | "expired_token" | "malformed_token" | "replay_attempt" | "not_found" };

export function takePending(token: string): TakePendingResult {
  purgeExpired();

  // M35.2 — Verify token signature and expiry
  const verification = verifyToken(token);
  if (!verification.valid) {
    // Type-safe mapping from verification failure to TakePendingResult reason
    const failureReason: "invalid_signature" | "expired_token" | "malformed_token" = verification.reason;
    return { ok: false, reason: failureReason };
  }

  // M35.2 — Reject single-use tokens that have been redeemed
  if (redeemed.has(token)) {
    return { ok: false, reason: "replay_attempt" };
  }

  const env = store.get(token);
  if (!env) {
    return { ok: false, reason: "not_found" };
  }

  // Mark as redeemed (single-use)
  redeemed.add(token);
  store.delete(token);
  return { ok: true, approval: env };
}

export function peekPending(token: string): PendingApproval | undefined {
  purgeExpired();
  // M35.2 — Verify signature before peeking
  const verification = verifyToken(token);
  if (!verification.valid) return undefined;
  return store.get(token);
}

export function recentPending(limit = 50): PendingApproval[] {
  purgeExpired();
  return Array.from(store.values()).slice(-limit).reverse();
}
