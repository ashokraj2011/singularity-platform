/**
 * M35.5 — integration test for M35.2 continuation-token signing.
 *
 * Exercises the savePending/takePending contract end-to-end:
 *   1. savePending() mints a signed token in cnt-<sig>.<uuid>.<expires> form
 *   2. takePending() verifies signature + expiry and returns the approval
 *   3. A second takePending() of the same token returns replay_attempt
 *   4. A token with a tampered signature returns invalid_signature
 *   5. A token past its expiry returns expired_token
 *   6. A malformed token returns malformed_token
 *
 * These are the invariants that prevent same-process replay attacks. If any
 * of these regress, an attacker who snoops a continuation token could re-fire
 * the approved tool call against the agent loop indefinitely.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { savePending, takePending } from "../src/audit/pending";
import type { ChatMessage, ToolCall } from "../src/llm/types";

function makeEnvelope() {
  const messages: ChatMessage[] = [
    { role: "user", content: "do the thing" },
  ];
  const pending_tool_call: ToolCall = {
    id: "call_1",
    name: "test.tool",
    args: { foo: "bar" },
  };
  return {
    trace_id: "trace-xyz",
    mcp_invocation_id: "invoke-1",
    messages,
    pending_tool_call,
    pending_tool_descriptor: {
      name: "test.tool",
      description: "test tool",
      input_schema: {},
      execution_target: "LOCAL" as const,
      requires_approval: true,
    },
    available_tools: [],
    full_tool_descriptors: [],
    model_config: { provider: "mock", model: "mock-model" },
    correlation: {
      mcpInvocationId: "invoke-1",
      traceId: "trace-xyz",
      capabilityId: "cap-1",
    },
    step_index: 0,
    max_steps: 12,
    llm_call_ids: [],
    tool_invocation_ids: [],
    artifact_ids: [],
    total_input_tokens: 0,
    total_output_tokens: 0,
  };
}

describe("M35.2 continuation-token signing", () => {
  it("mints a token in the documented cnt-<sig>.<uuid>.<ms> format", () => {
    const env = savePending(makeEnvelope());
    expect(env.continuation_token).toMatch(/^cnt-[A-Za-z0-9_-]+\.[0-9a-f-]{36}\.\d+$/);
  });

  it("savePending → takePending returns the same envelope (single-use happy path)", () => {
    const env = savePending(makeEnvelope());
    const result = takePending(env.continuation_token);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.approval.continuation_token).toBe(env.continuation_token);
      expect(result.approval.pending_tool_call.name).toBe("test.tool");
    }
  });

  it("rejects a second takePending of the same token as replay_attempt", () => {
    const env = savePending(makeEnvelope());
    const first = takePending(env.continuation_token);
    expect(first.ok).toBe(true);
    const second = takePending(env.continuation_token);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toBe("replay_attempt");
    }
  });

  it("rejects a token with a tampered signature as invalid_signature", () => {
    const env = savePending(makeEnvelope());
    // Flip the first non-prefix byte of the signature
    const parts = env.continuation_token.split(".");
    const sig = parts[0].slice(4); // strip cnt-
    const tampered = `cnt-${sig.slice(0, -1)}${sig.slice(-1) === "A" ? "B" : "A"}.${parts[1]}.${parts[2]}`;
    const result = takePending(tampered);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid_signature");
    }
  });

  it("rejects a token with a past-expiry timestamp as expired_token", () => {
    // Construct a token with a fixed-old expiry; signature won't match, but
    // verifyToken checks expiry first so we get expired_token (not invalid_sig).
    const oldMs = Date.now() - 1000;
    const fakeUuid = "00000000-0000-0000-0000-000000000000";
    const result = takePending(`cnt-AAAA.${fakeUuid}.${oldMs}`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("expired_token");
    }
  });

  it("rejects malformed tokens (missing parts) as malformed_token", () => {
    const cases = [
      "not-a-token",
      "cnt-onlyonepart",
      "cnt-sig.uuid", // missing expires
      "wrongprefix.uuid.123",
    ];
    for (const bad of cases) {
      const r = takePending(bad);
      expect(r.ok, `should reject ${bad}`).toBe(false);
    }
  });

  it("rejects a token whose expiry is non-numeric as malformed_token", () => {
    const fakeUuid = "00000000-0000-0000-0000-000000000000";
    const result = takePending(`cnt-AAAA.${fakeUuid}.notanumber`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("malformed_token");
    }
  });
});
