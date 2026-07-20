/**
 * Task + caller identity through the SHARED gateway client.
 *
 * This client has a dozen unrelated callers (capsule compile, symbol summarise,
 * grounding, …), which is exactly why it must PASS THROUGH what a caller gives
 * rather than stamp a tag of its own: one hardcoded tag here would file every
 * caller's spend under a single wrong bucket, and it would look correct.
 *
 * It also has TWO transports — D1 direct-to-gateway and the mcp relay — chosen
 * by an env var. Identity that survives one and not the other means the same
 * call is attributed differently depending on deployment config, which is worse
 * than no attribution at all because it is invisible.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const originalFetch = globalThis.fetch;
const originalMcpServerUrl = process.env.MCP_SERVER_URL;
const originalGatewayUrl = process.env.LLM_GATEWAY_URL;

beforeEach(() => {
  process.env.MCP_SERVER_URL = "http://mcp-server:7100";
  vi.resetModules();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalMcpServerUrl === undefined) delete process.env.MCP_SERVER_URL;
  else process.env.MCP_SERVER_URL = originalMcpServerUrl;
  if (originalGatewayUrl === undefined) delete process.env.LLM_GATEWAY_URL;
  else process.env.LLM_GATEWAY_URL = originalGatewayUrl;
  vi.restoreAllMocks();
});

/** Intercepts fetch and returns a reader for the body of the matching call. */
function captureBody(match: string, response: unknown) {
  const mock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => response,
    text: async () => JSON.stringify(response),
  }));
  globalThis.fetch = mock as unknown as typeof fetch;
  return () => {
    const call = mock.mock.calls.find(([url]) => String(url).includes(match));
    expect(call, `expected a call to ${match}`).toBeDefined();
    return JSON.parse(String((call![1] as RequestInit).body)) as Record<string, unknown>;
  };
}

const IDENTITY = {
  task_tag: "capsule_compile",
  actor_id: "system:prompt-composer",
  tenant_id: "t-9",
  session_id: "s-3",
} as const;

describe("chat: direct-to-gateway transport", () => {
  beforeEach(() => {
    process.env.LLM_GATEWAY_URL = "http://llm-gateway:8001";
  });

  it("forwards the caller's own tag and identity untouched", async () => {
    const read = captureBody("/v1/chat/completions", { content: "ok", finish_reason: "stop" });
    const { llmRespond } = await import("../src/llm-gateway/client");
    await llmRespond({ messages: [{ role: "user", content: "hi" }], ...IDENTITY });
    expect(read()).toMatchObject(IDENTITY);
  });

  it("does not invent a tag when the caller gave none", async () => {
    // A default here would be a lie about every caller but one. Untagged is
    // visible at the gateway (it warns, then 400s once required); a wrong tag
    // is not visible at all.
    const read = captureBody("/v1/chat/completions", { content: "ok", finish_reason: "stop" });
    const { llmRespond } = await import("../src/llm-gateway/client");
    await llmRespond({ messages: [{ role: "user", content: "hi" }] });
    expect(read()).not.toHaveProperty("task_tag");
  });
});

describe("chat: mcp relay transport", () => {
  beforeEach(() => {
    delete process.env.LLM_GATEWAY_URL;
  });

  it("carries identity across the relay hop too", async () => {
    // Without this the same call is attributed on one transport and anonymous
    // on the other, decided by an env var nobody associates with cost reporting.
    const read = captureBody("/mcp/invoke", {
      success: true,
      data: { status: "COMPLETED", finalResponse: "ok", finishReason: "stop" },
    });
    const { llmRespond } = await import("../src/llm-gateway/client");
    await llmRespond({ messages: [{ role: "user", content: "hi" }], ...IDENTITY });
    const runContext = read().runContext as Record<string, unknown>;
    expect(runContext.userId).toBe(IDENTITY.actor_id);
    expect(runContext.tenantId).toBe(IDENTITY.tenant_id);
    expect(runContext.sessionId).toBe(IDENTITY.session_id);
  });
});

describe("embeddings: direct-to-gateway transport", () => {
  beforeEach(() => {
    process.env.LLM_GATEWAY_URL = "http://llm-gateway:8001";
  });

  it("forwards identity instead of dropping it on the floor", async () => {
    // This path builds its body field-by-field rather than spreading the
    // request, so anything not explicitly named vanishes with NO error — a
    // caller would have set actor_id, seen no failure, and got nothing.
    const read = captureBody("/v1/embeddings", { embeddings: [[0.1]], dim: 1 });
    const { llmEmbed } = await import("../src/llm-gateway/client");
    await llmEmbed({
      input: ["hello"],
      trace_id: "tr-1",
      capability_id: "cap-1",
      actor_id: "system:agent-runtime",
      tenant_id: "t-4",
    });
    const body = read();
    expect(body.actor_id).toBe("system:agent-runtime");
    expect(body.tenant_id).toBe("t-4");
    expect(body.trace_id).toBe("tr-1");
    expect(body.capability_id).toBe("cap-1");
    expect(body.input).toEqual(["hello"]);
  });

  it("omits what the caller did not set rather than sending nulls", async () => {
    const read = captureBody("/v1/embeddings", { embeddings: [[0.1]], dim: 1 });
    const { llmEmbed } = await import("../src/llm-gateway/client");
    await llmEmbed({ input: ["hello"] });
    const body = read();
    for (const key of ["actor_id", "tenant_id", "session_id", "task_tag"]) {
      expect(body, `${key} should be absent, not null`).not.toHaveProperty(key);
    }
  });
});

describe("validation still accepts the new fields", () => {
  it("does not reject a request that carries identity", async () => {
    // The Zod schema strips unknown keys, so an undeclared field would have
    // validated fine and then confused anyone reading the schema for the
    // contract. Declaring them keeps schema and wire in agreement.
    process.env.LLM_GATEWAY_URL = "http://llm-gateway:8001";
    const read = captureBody("/v1/chat/completions", { content: "ok", finish_reason: "stop" });
    const { llmRespond } = await import("../src/llm-gateway/client");
    await expect(
      llmRespond({ messages: [{ role: "user", content: "hi" }], ...IDENTITY }),
    ).resolves.toBeDefined();
    expect(read().actor_id).toBe(IDENTITY.actor_id);
  });
});
