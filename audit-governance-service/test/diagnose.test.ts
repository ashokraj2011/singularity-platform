/**
 * diagnose.ts unit tests.
 *
 * Repair of a silent regression: the original implementation POSTed to
 * mcp-server's /mcp/invoke, which returns 410 GONE after the M71
 * cutover. Every LLM-driven diagnosis call has silently fallen back
 * to the heuristic since then. These tests pin the new routing
 * (direct call to llm-gateway, llm-judge.ts pattern) so the regression
 * can't sneak back.
 *
 * Pinned contracts:
 *   • Fetch URL ends with /v1/chat/completions on the llm-gateway —
 *     NEVER /mcp/invoke.
 *   • Gateway request body is the {messages, temperature,
 *     max_output_tokens, trace_id} shape, NOT the legacy
 *     {systemPrompt, message, tools, modelConfig, runContext, limits}
 *     mcp-invoke envelope.
 *   • model_alias passed when ENGINE_MODEL_ALIAS is set; omitted otherwise.
 *   • Response parsing: extract the first {...} block from `content`.
 *   • Failure modes fall back to the heuristic — never throws.
 *
 * Strategy: stub global fetch with vitest.fn. The first fetch call is
 * the prompt-composer system-prompt lookup; the second is the gateway
 * call. We assert the second fetch's URL + body.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __test_internals } from "../src/engine/diagnose";

const { callLlmForDiagnosis, heuristicDiagnosis } = __test_internals;

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.clearAllMocks();
});

/**
 * Build a fetch mock that returns a canned system prompt on the
 * prompt-composer URL and a canned gateway response on the
 * llm-gateway URL. Returns the mock so tests can assert call
 * arguments.
 */
function stubGatewayFlow(opts: {
  systemPrompt?: string;
  gatewayContent?: string;
  gatewayStatus?: number;
  gatewayThrows?: Error;
  gatewayRawText?: string;
}) {
  const mock = vi.fn(async (url: string) => {
    if (url.includes("/system-prompts/")) {
      const body = {
        success: true,
        data: { content: opts.systemPrompt ?? "You are a diagnosis assistant." },
      };
      return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      };
    }
    if (url.includes("/v1/chat/completions")) {
      if (opts.gatewayThrows) throw opts.gatewayThrows;
      const body = { content: opts.gatewayContent ?? "" };
      return {
        ok: (opts.gatewayStatus ?? 200) < 400,
        status: opts.gatewayStatus ?? 200,
        json: async () => body,
        text: async () => opts.gatewayRawText ?? JSON.stringify(body),
      };
    }
    throw new Error(`unexpected fetch URL in test: ${url}`);
  });
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
}

/**
 * Reset the in-process system-prompt cache between tests so each
 * test sees a fresh prompt-composer fetch. The cache lives at module
 * level; clearing it requires re-importing the module. Using
 * vi.resetModules() so the second import re-initialises.
 */
beforeEach(async () => {
  vi.resetModules();
});

// A valid diagnosis JSON the gateway might emit. Matches DiagnosisResult.
const VALID_JSON = JSON.stringify({
  root_cause: "Repeated tool call without progress",
  confidence: "high",
  category: "tool_failure",
  fix_type: "prompt",
  fix_summary: "Add guardrail",
  fix_detail: "Cap repair_attempts to 3",
  evaluator_hint: "Flag traces with >5 identical tool calls",
});

describe("callLlmForDiagnosis — routing", () => {
  it("POSTs to llm-gateway /v1/chat/completions, NOT /mcp/invoke", async () => {
    const fetchMock = stubGatewayFlow({ gatewayContent: VALID_JSON });
    await callLlmForDiagnosis("test prompt");

    // First call: prompt-composer. Second: gateway. We assert the
    // gateway URL — the failure mode being repaired is exactly that
    // it used to be /mcp/invoke.
    const calls = fetchMock.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const gatewayCall = calls.find((c) =>
      String(c[0]).includes("/v1/chat/completions"),
    );
    expect(gatewayCall).toBeDefined();
    expect(String(gatewayCall![0])).toMatch(/\/v1\/chat\/completions$/);
    // Negative: no call should hit /mcp/invoke.
    for (const c of calls) {
      expect(String(c[0])).not.toContain("/mcp/invoke");
    }
  });

  it("sends the gateway-shaped body (messages, not mcp-invoke envelope)", async () => {
    const fetchMock = stubGatewayFlow({ gatewayContent: VALID_JSON });
    await callLlmForDiagnosis("the diagnosis prompt body");

    const gatewayCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes("/v1/chat/completions"),
    )!;
    const init = gatewayCall[1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[1].role).toBe("user");
    expect(body.messages[1].content).toBe("the diagnosis prompt body");
    expect(body.temperature).toBe(0);
    expect(typeof body.max_output_tokens).toBe("number");
    expect(body.trace_id).toMatch(/^audit-gov-diagnose-/);
    // Negative: the old mcp-invoke envelope fields must NOT appear.
    expect(body.systemPrompt).toBeUndefined();
    expect(body.message).toBeUndefined();
    expect(body.tools).toBeUndefined();
    expect(body.modelConfig).toBeUndefined();
    expect(body.limits).toBeUndefined();
  });
});

describe("callLlmForDiagnosis — response parsing", () => {
  it("returns the parsed DiagnosisResult when gateway emits valid JSON", async () => {
    stubGatewayFlow({ gatewayContent: VALID_JSON });
    const result = await callLlmForDiagnosis("p");
    expect(result.root_cause).toBe("Repeated tool call without progress");
    expect(result.confidence).toBe("high");
    expect(result.fix_type).toBe("prompt");
  });

  it("extracts JSON from a chatty-preamble response", async () => {
    // The model sometimes wraps its JSON in commentary; the regex
    // matches the outermost {...} span.
    const chatty = `Sure, here is the analysis:\n\n${VALID_JSON}\n\nLet me know if you need more detail.`;
    stubGatewayFlow({ gatewayContent: chatty });
    const result = await callLlmForDiagnosis("p");
    expect(result.root_cause).toBe("Repeated tool call without progress");
  });
});

describe("callLlmForDiagnosis — failure modes fall back to heuristic", () => {
  it("falls back to heuristic on gateway 5xx", async () => {
    stubGatewayFlow({ gatewayContent: "", gatewayStatus: 503 });
    const result = await callLlmForDiagnosis("latency timeout pattern");
    // The latency-keyword heuristic is the right branch for this input.
    expect(result.category).toBe("latency_spike");
  });

  it("falls back to heuristic on gateway exception", async () => {
    stubGatewayFlow({ gatewayThrows: new Error("ECONNREFUSED") });
    const result = await callLlmForDiagnosis("tool not registered");
    expect(result.category).toBe("tool_failure");
  });

  it("falls back to heuristic on malformed gateway content (no JSON)", async () => {
    stubGatewayFlow({ gatewayContent: "no json here, just chatter" });
    const result = await callLlmForDiagnosis("token blowout exceed budget");
    expect(result.category).toBe("token_blowout");
  });

  it("falls back to heuristic on invalid gateway JSON envelope", async () => {
    stubGatewayFlow({ gatewayRawText: "Internal Server Error" });
    const result = await callLlmForDiagnosis("latency timeout pattern");
    expect(result.category).toBe("latency_spike");
  });

  it("never throws — heuristic always wins as last resort", async () => {
    stubGatewayFlow({ gatewayThrows: new Error("anything") });
    // Use an input the heuristic doesn't recognise so we land on the
    // "unknown" branch — this asserts the function doesn't bubble
    // the gateway exception up to the caller.
    const result = await callLlmForDiagnosis("completely unrecognisable issue");
    expect(result.category).toBe("unknown");
    expect(result.confidence).toBe("low");
  });
});

describe("heuristicDiagnosis — directly", () => {
  it("returns the unknown branch for unrecognised input", () => {
    const r = heuristicDiagnosis("nothing matches here");
    expect(r.confidence).toBe("low");
    expect(r.category).toBe("unknown");
  });

  it("matches tool-not-registered keywords", () => {
    const r = heuristicDiagnosis("tool was not registered properly");
    expect(r.category).toBe("tool_failure");
    expect(r.confidence).toBe("high");
  });

  it("matches latency/timeout keywords", () => {
    const r = heuristicDiagnosis("the call had a timeout");
    expect(r.category).toBe("latency_spike");
  });

  it("matches token blowout keywords", () => {
    const r = heuristicDiagnosis("token usage exceeded budget");
    expect(r.category).toBe("token_blowout");
  });
});
