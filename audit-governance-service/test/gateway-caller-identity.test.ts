/**
 * Caller identity on audit-gov's two gateway call sites.
 *
 * Both POST straight to llm-gateway (they are single-turn evaluations, not
 * agent loops), and both did so with NO task_tag — meaning they would 400 the
 * moment GATEWAY_REQUIRE_TASK_TAG is set, and until then their spend was
 * unattributable. Neither named an actor either.
 *
 * These assert the BODY ACTUALLY SENT, by intercepting fetch, rather than
 * grepping the source: the point is what crosses the wire, and a field can be
 * present in the source and still be dropped by a serialiser or an
 * intermediate object spread.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { GATEWAY_ACTOR_ID, runJudge } from "../src/engine/llm-judge";
import { __test_internals as diagnoseInternals } from "../src/engine/diagnose";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.clearAllMocks();
});

/** Captures the JSON body of the next gateway POST. */
function captureGatewayBody(responseContent: string) {
  const mock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ content: responseContent }),
    text: async () => JSON.stringify({ content: responseContent }),
  });
  globalThis.fetch = mock as unknown as typeof fetch;
  return () => {
    expect(mock).toHaveBeenCalled();
    const [, init] = mock.mock.calls[0] as [string, RequestInit];
    return JSON.parse(String(init.body)) as Record<string, unknown>;
  };
}

describe("the judge names its work and itself", () => {
  it("sends a task_tag from the gateway vocabulary", async () => {
    const read = captureGatewayBody(JSON.stringify({ score: 4, reason: "fine" }));
    await runJudge({ expected: "e", actual: "a" });
    expect(read().task_tag).toBe("judge");
  });

  it("sends a system actor rather than nothing", async () => {
    const read = captureGatewayBody(JSON.stringify({ score: 4, reason: "fine" }));
    await runJudge({ expected: "e", actual: "a" });
    const body = read();
    // The convention that makes null meaningful: a call with no human behind it
    // says so explicitly, so a null actor keeps meaning "somebody forgot".
    expect(body.actor_id).toBe(GATEWAY_ACTOR_ID);
    expect(body.actor_id).not.toBeNull();
    expect(String(body.actor_id)).toMatch(/^system:[a-z0-9-]{3,}$/);
  });

  it("does not invent a tenant it was never given", async () => {
    // JudgeInput carries no tenant. A plausible-looking default here would be
    // indistinguishable from a real tenant downstream, which is strictly worse
    // than an honest absence — cost-by-tenant would silently be wrong rather
    // than visibly incomplete.
    const read = captureGatewayBody(JSON.stringify({ score: 4, reason: "fine" }));
    await runJudge({ expected: "e", actual: "a" });
    expect(read()).not.toHaveProperty("tenant_id");
  });

  it("still sends everything the judge needed before", async () => {
    const read = captureGatewayBody(JSON.stringify({ score: 5, reason: "ok" }));
    await runJudge({ expected: "e", actual: "a" });
    const body = read();
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.temperature).toBe(0);
    expect(String(body.trace_id)).toContain("audit-gov-judge");
  });
});

describe("diagnosis names its work and itself", () => {
  it("sends the same tag and actor as the judge", async () => {
    // Both are audit-gov LLM evaluation; the vocabulary has one bucket for
    // them, and using two would split one cost line for no reason.
    // diagnose fetches its system prompt from prompt-composer BEFORE calling the
    // gateway, and swallows every failure into a heuristic fallback — so a mock
    // that only answers the gateway makes this test pass vacuously by never
    // reaching it. Both hops have to be served.
    const mock = vi.fn(async (url: string) => {
      const body = url.includes("/system-prompts/")
        ? { success: true, data: { content: "You are a diagnosis assistant." } }
        : {
            content: JSON.stringify({
              root_cause: "x", confidence: "high",
              category: "tool_failure", fix_type: "config",
            }),
          };
      return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      };
    });
    globalThis.fetch = mock as unknown as typeof fetch;

    await diagnoseInternals.callLlmForDiagnosis("some prompt");
    const gatewayCall = mock.mock.calls.find(([url]) =>
      String(url).includes("/v1/chat/completions"),
    );
    expect(gatewayCall, "diagnose should reach the gateway").toBeDefined();
    const body = JSON.parse(String((gatewayCall![1] as RequestInit).body));
    expect(body.task_tag).toBe("judge");
    expect(body.actor_id).toBe(GATEWAY_ACTOR_ID);
    expect(body).not.toHaveProperty("tenant_id");
  });
});

describe("the actor constant", () => {
  it("names this service specifically", () => {
    // "system:" alone would be as uninformative as null — the suffix is the
    // part a cost report groups by.
    expect(GATEWAY_ACTOR_ID).toBe("system:audit-governance-service");
  });

  it("is shared by both call sites so they cannot drift apart", async () => {
    const judgeSrc = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../src/engine/diagnose.ts", import.meta.url), "utf8"),
    );
    expect(judgeSrc).toContain("GATEWAY_ACTOR_ID");
    // ...and not a second hand-written copy of the same string.
    expect(judgeSrc).not.toContain('"system:audit-governance-service"');
  });
});
