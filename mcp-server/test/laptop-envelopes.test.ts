/**
 * M75 Slice 1 — laptop-bridge envelope tests.
 *
 * Covers:
 *   • round-trip encode/decode of every InboundFrame variant
 *   • HelloFrame.supported_frame_types capability negotiation
 *   • ToolRunFrame + ToolRunResponsePayload schemas
 *   • backward-compat: pre-M75 hello frames (no supported_frame_types)
 *     parse cleanly with default = ["invoke"]
 *
 * Why these matter: the wire format is the only contract between the
 * platform-side bridge and the laptop binary. If a field drifts here
 * and the other side isn't updated, the laptop bridge silently fails
 * to dispatch (frame parses as null → caller's switch lands in the
 * "unknown frame" branch).
 */
import { describe, expect, it } from "vitest";

import {
  AuthAckFrame,
  DisconnectFrame,
  HelloFrame,
  HeartbeatFrame,
  InvokeFrame,
  PingFrame,
  ResponseFrame,
  SUPPORTED_FRAME_TYPES,
  ToolRunFrame,
  ToolRunPayload,
  ToolRunResponsePayload,
  decodeInbound,
} from "../src/laptop/envelopes";

// ── HelloFrame capability negotiation ──────────────────────────────────────

describe("HelloFrame.supported_frame_types", () => {
  it("new laptop advertises both invoke and tool-run", () => {
    const hello = HelloFrame.parse({
      type: "hello",
      device_id: "dev-1",
      device_name: "Mac",
      agent_version: "1.2.3",
      supported_frame_types: ["invoke", "tool-run"],
    });
    expect(hello.supported_frame_types).toEqual(["invoke", "tool-run"]);
  });

  it("old laptop omits the field; defaults to legacy-only", () => {
    // Backward-compat — pre-M75 laptops have no notion of the field.
    // The bridge must not treat that as "no frames supported"; the
    // safe default is "invoke only" (the legacy path).
    const hello = HelloFrame.parse({
      type: "hello",
      device_id: "dev-old",
      device_name: "OldMac",
      agent_version: "0.9.0",
    });
    expect(hello.supported_frame_types).toEqual(["invoke"]);
  });

  it("rejects unknown frame-type strings", () => {
    // A laptop on a future version that advertises an unknown frame
    // type should fail to parse rather than silently get classified
    // as a known one. The bridge can then fall back to legacy or
    // refuse the connection.
    expect(() =>
      HelloFrame.parse({
        type: "hello",
        device_id: "x",
        device_name: "x",
        agent_version: "x",
        supported_frame_types: ["invoke", "graphql-subscription"],
      }),
    ).toThrow();
  });

  it("SUPPORTED_FRAME_TYPES export matches schema enum", () => {
    // Pin the constant to prevent drift — Slice 2 imports this to
    // build the bridge's capability matcher.
    expect(SUPPORTED_FRAME_TYPES).toEqual(["invoke", "tool-run", "model-run", "code-context"]);
  });
});

// ── ToolRunFrame ───────────────────────────────────────────────────────────

describe("ToolRunFrame", () => {
  it("parses a minimal request", () => {
    const frame = ToolRunFrame.parse({
      type: "tool-run",
      request_id: "req-123",
      payload: {
        tool_name: "read_file",
        args: { path: "src/a.py" },
        run_context: { traceId: "t1", attemptId: "a1" },
      },
    });
    expect(frame.type).toBe("tool-run");
    expect(frame.payload.tool_name).toBe("read_file");
    expect(frame.payload.args).toEqual({ path: "src/a.py" });
  });

  it("preserves an optional ToolInvocationGrant for WS tool-run dispatch", () => {
    const grant = {
      v: 1,
      traceId: "t1",
      stageKey: "stage",
      phase: "ACT",
      toolName: "write_file",
      argsHash: "sha256:abc",
      policyId: "p",
      policyVersion: 1,
      policyHash: "sha256:def",
      issuedAt: 1,
      expiresAt: 2,
      nonce: "n",
      alg: "HMAC-SHA256",
      sig: "sig",
    };
    const frame = ToolRunFrame.parse({
      type: "tool-run",
      request_id: "req-grant",
      payload: {
        tool_name: "write_file",
        args: { path: "a.py", content: "x" },
        run_context: { traceId: "t1" },
        tool_grant: grant,
      },
    });

    expect(frame.payload.tool_grant).toEqual(grant);
  });

  it("defaults args + run_context to empty objects", () => {
    const frame = ToolRunFrame.parse({
      type: "tool-run",
      request_id: "req-2",
      payload: { tool_name: "list_indexed_files" },
    });
    expect(frame.payload.args).toEqual({});
    expect(frame.payload.run_context).toEqual({});
  });

  it("accepts either work_item_id or workspace_id (or neither)", () => {
    // mcp-server's dispatch treats them as aliases. The frame doesn't
    // enforce one — the laptop handler picks based on what's set.
    const withWork = ToolRunFrame.parse({
      type: "tool-run",
      request_id: "r1",
      payload: { tool_name: "x", work_item_id: "WI-1" },
    });
    expect(withWork.payload.work_item_id).toBe("WI-1");

    const withWorkspace = ToolRunFrame.parse({
      type: "tool-run",
      request_id: "r2",
      payload: { tool_name: "x", workspace_id: "WS-2" },
    });
    expect(withWorkspace.payload.workspace_id).toBe("WS-2");

    const withNeither = ToolRunFrame.parse({
      type: "tool-run",
      request_id: "r3",
      payload: { tool_name: "x" },
    });
    expect(withNeither.payload.work_item_id).toBeUndefined();
    expect(withNeither.payload.workspace_id).toBeUndefined();
  });

  it("rejects missing tool_name", () => {
    expect(() =>
      ToolRunFrame.parse({
        type: "tool-run",
        request_id: "r",
        payload: { args: {} },
      }),
    ).toThrow();
  });

  it("optional deadline_ms must be positive integer", () => {
    expect(() =>
      ToolRunFrame.parse({
        type: "tool-run",
        request_id: "r",
        payload: { tool_name: "x" },
        deadline_ms: -1,
      }),
    ).toThrow();
  });
});

// ── ToolRunResponsePayload ─────────────────────────────────────────────────

describe("ToolRunResponsePayload", () => {
  it("parses a success response", () => {
    const out = ToolRunResponsePayload.parse({
      result: { branches: ["main"] },
      duration_ms: 42,
      tool_invocation_id: "ti-1",
      tool_success: true,
      tool_error: null,
    });
    expect(out.tool_success).toBe(true);
    expect(out.duration_ms).toBe(42);
  });

  it("parses a failure response with error string", () => {
    const out = ToolRunResponsePayload.parse({
      result: null,
      duration_ms: 5,
      tool_invocation_id: "ti-2",
      tool_success: false,
      tool_error: "patch failed: hunk #1 didn't apply",
    });
    expect(out.tool_success).toBe(false);
    expect(out.tool_error).toMatch(/hunk #1/);
  });

  it("accepts omitted tool_error (treated as null)", () => {
    const out = ToolRunResponsePayload.parse({
      result: {},
      duration_ms: 0,
      tool_invocation_id: "ti-3",
      tool_success: true,
    });
    expect(out.tool_error).toBeUndefined();
  });

  it("rejects negative duration_ms", () => {
    expect(() =>
      ToolRunResponsePayload.parse({
        result: null,
        duration_ms: -10,
        tool_invocation_id: "ti",
        tool_success: false,
      }),
    ).toThrow();
  });
});

// ── decodeInbound ──────────────────────────────────────────────────────────

describe("decodeInbound", () => {
  it("decodes auth.ack", () => {
    const frame = decodeInbound({
      type: "auth.ack",
      user_id: "u1",
      device_id: "d1",
      registered_at: "2026-05-23T10:00:00Z",
    });
    expect(frame?.type).toBe("auth.ack");
  });

  it("decodes invoke", () => {
    const frame = decodeInbound({
      type: "invoke",
      request_id: "req-x",
      payload: { foo: "bar" },
    });
    expect(frame?.type).toBe("invoke");
  });

  it("decodes tool-run (M75 Slice 1)", () => {
    const frame = decodeInbound({
      type: "tool-run",
      request_id: "req-y",
      payload: { tool_name: "read_file", args: { path: "a.py" } },
    });
    expect(frame?.type).toBe("tool-run");
    if (frame?.type === "tool-run") {
      expect(frame.payload.tool_name).toBe("read_file");
    }
  });

  it("decodes ping", () => {
    expect(decodeInbound({ type: "ping", sent_at: "now" })?.type).toBe("ping");
  });

  it("decodes disconnect", () => {
    expect(decodeInbound({ type: "disconnect", reason: "shutdown" })?.type).toBe("disconnect");
  });

  it("returns null for unknown frame types", () => {
    // The "next protocol version" case — bridge sends a frame the
    // laptop doesn't recognise. Returning null lets the relay-client
    // log + ignore rather than crash.
    expect(decodeInbound({ type: "totally-new-frame", foo: "bar" })).toBeNull();
  });

  it("returns null for non-object input", () => {
    expect(decodeInbound(null)).toBeNull();
    expect(decodeInbound("string")).toBeNull();
    expect(decodeInbound(42)).toBeNull();
    expect(decodeInbound([])).toBeNull();
  });

  it("returns null when type field is missing or non-string", () => {
    expect(decodeInbound({ no_type: true })).toBeNull();
    expect(decodeInbound({ type: 42 })).toBeNull();
  });

  it("throws on shape mismatch within a known type", () => {
    // Different from the unknown-type case: when the type IS known
    // but the payload doesn't match the schema, we want to know
    // (operator-visible) rather than silently drop. Zod throws.
    expect(() =>
      decodeInbound({ type: "tool-run", request_id: "x" /* no payload */ }),
    ).toThrow();
  });
});

// ── round-trip ─────────────────────────────────────────────────────────────
//
// Outbound frames (laptop → bridge) don't have a single decoder helper
// since the bridge knows what it asked for. But round-tripping them
// catches schema drift between encoder and parser.

describe("round-trip", () => {
  it("HelloFrame survives JSON round-trip", () => {
    const original: HelloFrame = {
      type: "hello",
      device_id: "d",
      device_name: "n",
      agent_version: "v",
      capabilities: ["pii_mask"],
      supported_frame_types: ["invoke", "tool-run"],
    };
    const parsed = HelloFrame.parse(JSON.parse(JSON.stringify(original)));
    expect(parsed).toEqual(original);
  });

  it("HeartbeatFrame survives", () => {
    const original: HeartbeatFrame = { type: "heartbeat", sent_at: "2026-01-01T00:00:00Z" };
    expect(HeartbeatFrame.parse(JSON.parse(JSON.stringify(original)))).toEqual(original);
  });

  it("ResponseFrame with payload survives", () => {
    const original: ResponseFrame = {
      type: "response",
      request_id: "r-1",
      payload: { result: { x: 1 }, duration_ms: 5 },
    };
    expect(ResponseFrame.parse(JSON.parse(JSON.stringify(original)))).toEqual(original);
  });

  it("ResponseFrame with error survives", () => {
    const original: ResponseFrame = {
      type: "response",
      request_id: "r-2",
      payload: null,
      error: { code: "BUSY", message: "at capacity" },
    };
    expect(ResponseFrame.parse(JSON.parse(JSON.stringify(original)))).toEqual(original);
  });

  it("ToolRunFrame round-trips through ToolRunResponsePayload validation", () => {
    // The realistic flow: bridge encodes a tool-run frame, laptop
    // decodes it, runs the tool, encodes a ResponseFrame with the
    // result, bridge validates the inner payload against
    // ToolRunResponsePayload to extract typed fields.
    const request = ToolRunFrame.parse({
      type: "tool-run",
      request_id: "req-rt",
      payload: { tool_name: "read_file", args: { path: "a.py" } },
    });
    expect(request.payload.tool_name).toBe("read_file");

    const responsePayload: ToolRunResponsePayload = {
      result: { content: "file content here" },
      duration_ms: 10,
      tool_invocation_id: "ti-rt",
      tool_success: true,
      tool_error: null,
    };
    const wrapped: ResponseFrame = {
      type: "response",
      request_id: request.request_id,
      payload: responsePayload,
    };
    const parsed = ResponseFrame.parse(JSON.parse(JSON.stringify(wrapped)));
    expect(parsed.request_id).toBe("req-rt");
    // Validate the inner payload separately since ResponseFrame's
    // payload is intentionally typed as unknown (it's a union over
    // all possible response shapes).
    const innerParsed = ToolRunResponsePayload.parse(parsed.payload);
    expect(innerParsed.tool_success).toBe(true);
    expect(innerParsed.tool_invocation_id).toBe("ti-rt");
  });
});

// Test for AuthAckFrame, InvokeFrame, PingFrame, DisconnectFrame happens
// via decodeInbound above; no need to duplicate.
const _typeGuardSuppression: AuthAckFrame | InvokeFrame | PingFrame | DisconnectFrame
  | undefined = undefined;
void _typeGuardSuppression;
