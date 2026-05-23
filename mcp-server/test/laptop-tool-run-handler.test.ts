/**
 * M75 Slice 2 — laptop bridge tool-run handler tests.
 *
 * The handler lives inside LaptopRelayClient and is exercised in
 * production via WebSocket events. To unit-test it we'd need to mock
 * the full WS lifecycle, which is heavy. Instead we test the
 * extracted runToolByName function (the part both transports share)
 * directly, plus the envelope-translation pieces. Integration of the
 * two is small enough to verify by inspection.
 *
 * What's tested:
 *   • runToolByName happy path returns a populated ToolRunOutcome
 *   • runToolByName missing tool name → NotFoundError
 *   • runToolByName tool failure (handler returns success=false)
 *     surfaces in the outcome, not as a throw
 *   • runToolByName tool exception → throws AppError with the
 *     toolInvocationId attached (matches HTTP route behavior)
 *   • Wire-format: ToolRunResponsePayload schema accepts the shape
 *     the laptop relay-client builds
 *
 * Tools register globally; we use unique names per test (freshName) so
 * leftover state from earlier tests doesn't cause collisions. The
 * registry has no unregister hook today; small leak is acceptable for
 * the test process lifetime.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { runToolByName, type ToolRunOutcome } from "../src/mcp/tool-run";
import { ToolRunResponsePayload } from "../src/laptop/envelopes";
import { registerLocalTool } from "../src/tools/registry";

let toolNameCounter = 0;
const freshName = (prefix: string) => `${prefix}_${++toolNameCounter}`;

afterEach(() => {
  vi.restoreAllMocks();
});

function registerNoOpTool(
  name: string,
  execute: (args: Record<string, unknown>) => Promise<{
    output: unknown;
    success: boolean;
    error?: string;
  }>,
) {
  registerLocalTool({
    descriptor: {
      name,
      description: "test-only fixture",
      natural_language: "test-only fixture",
      input_schema: { type: "object" },
      risk_level: "LOW",
      requires_approval: false,
    },
    execute,
  });
}

describe("runToolByName — happy path", () => {
  it("returns a populated outcome on a success", async () => {
    const name = freshName("noop_ok");
    registerNoOpTool(name, async (args) => ({
      success: true,
      output: { echo: args },
    }));

    const outcome = await runToolByName({
      tool_name: name,
      args: { ping: "pong" },
      work_item_id: undefined,
      workspace_id: undefined,
      run_context: {},
    });

    expect(outcome.toolSuccess).toBe(true);
    expect(outcome.toolError).toBeNull();
    expect(outcome.toolInvocationId).toMatch(/.+/);
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
    expect(outcome.result).toEqual({ echo: { ping: "pong" } });
  });
});

describe("runToolByName — error surfaces", () => {
  it("missing tool name → NotFoundError before any side effect", async () => {
    await expect(
      runToolByName({
        tool_name: "definitely_not_registered_tool_xyz",
        args: {},
        work_item_id: undefined,
        workspace_id: undefined,
        run_context: {},
      }),
    ).rejects.toThrow(/not in local registry/);
  });

  it("tool returns success=false → outcome carries toolSuccess=false, NOT a throw", async () => {
    // The tool ran. It reported failure. CF needs both pieces of
    // information so the LLM can see the verdict — surfacing it as
    // an outcome instead of a throw keeps the failure structured.
    const name = freshName("noop_softfail");
    registerNoOpTool(name, async () => ({
      success: false,
      output: null,
      error: "patch did not apply cleanly",
    }));

    const outcome = await runToolByName({
      tool_name: name,
      args: {},
      work_item_id: undefined,
      workspace_id: undefined,
      run_context: {},
    });

    expect(outcome.toolSuccess).toBe(false);
    expect(outcome.toolError).toBe("patch did not apply cleanly");
    expect(outcome.result).toBeNull();
  });

  it("tool throws → AppError with toolInvocationId attached", async () => {
    // A tool that throws unexpectedly is a runtime error, not a
    // tool-level failure. The HTTP route translates this to a 500;
    // the WS handler translates it to a ResponseFrame error. Both
    // need the toolInvocationId so audit-gov can join the ledger row.
    const name = freshName("hardfail");
    registerNoOpTool(name, async () => {
      throw new Error("kaboom");
    });

    // AppError stores HTTP status under `status` and the message is on the
    // Error prototype (non-enumerable). Check both explicitly rather than
    // via toMatchObject which can't see non-enumerable fields.
    const err = await runToolByName({
      tool_name: name,
      args: {},
      work_item_id: undefined,
      workspace_id: undefined,
      run_context: {},
    }).catch((e) => e as { status?: number; code?: string; message?: string; details?: Record<string, unknown> });

    expect(err.status).toBe(500);
    expect(err.code).toBe("TOOL_EXECUTION_ERROR");
    expect(err.message).toContain("kaboom");
    expect(err.details).toMatchObject({
      toolInvocationId: expect.any(String),
      durationMs: expect.any(Number),
    });
  });
});

describe("wire-format ↔ runner integration", () => {
  it("the relay-client's response shape validates as ToolRunResponsePayload", async () => {
    // Pins the contract between the laptop relay handler and the
    // bridge. If we ever change field names in runToolByName's
    // outcome or the relay-client's payload mapping, the schema
    // parse fails loudly here.
    const name = freshName("noop_validate");
    registerNoOpTool(name, async () => ({
      success: true,
      output: { hello: "world" },
    }));

    const outcome: ToolRunOutcome = await runToolByName({
      tool_name: name,
      args: {},
      work_item_id: undefined,
      workspace_id: undefined,
      run_context: {},
    });

    // Mirror the exact mapping the relay-client does when wrapping
    // outcome into ResponseFrame.payload.
    const wirePayload = {
      result: outcome.result,
      duration_ms: outcome.durationMs,
      tool_invocation_id: outcome.toolInvocationId,
      tool_success: outcome.toolSuccess,
      tool_error: outcome.toolError,
    };
    const parsed = ToolRunResponsePayload.parse(wirePayload);
    expect(parsed.tool_success).toBe(true);
    expect(parsed.tool_invocation_id).toBe(outcome.toolInvocationId);
  });

  it("ToolRunResponsePayload accepts a tool-error null and a tool-error string", () => {
    // Both branches of the failure-mode rendering — the relay-client
    // sends `tool_error: null` on success and `tool_error: string`
    // on a tool soft-failure. Both must validate.
    const passing = ToolRunResponsePayload.parse({
      result: {},
      duration_ms: 1,
      tool_invocation_id: "ti-1",
      tool_success: true,
      tool_error: null,
    });
    expect(passing.tool_error).toBeNull();

    const failing = ToolRunResponsePayload.parse({
      result: null,
      duration_ms: 2,
      tool_invocation_id: "ti-2",
      tool_success: false,
      tool_error: "diff did not apply",
    });
    expect(failing.tool_error).toBe("diff did not apply");
  });
});
