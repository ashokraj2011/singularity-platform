/**
 * M35.5 — tests for M35.4 Zod validation on the LLM gateway client.
 *
 * Proves that malformed ChatCompletionRequest / EmbeddingsRequest shapes
 * fail at the calling service with a clear error message instead of
 * bouncing off the gateway with a generic 422.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const originalFetch = globalThis.fetch;
const originalMcpServerUrl = process.env.MCP_SERVER_URL;
const originalMcpBearerToken = process.env.MCP_BEARER_TOKEN;
const originalGatewayUrl = process.env.LLM_GATEWAY_URL;

beforeEach(() => {
  // Force the mock MCP path so we don't try a real HTTP call when validation passes.
  process.env.MCP_SERVER_URL = "mock";
  delete process.env.MCP_BEARER_TOKEN;
  delete process.env.LLM_GATEWAY_URL;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalMcpServerUrl === undefined) delete process.env.MCP_SERVER_URL;
  else process.env.MCP_SERVER_URL = originalMcpServerUrl;
  if (originalMcpBearerToken === undefined) delete process.env.MCP_BEARER_TOKEN;
  else process.env.MCP_BEARER_TOKEN = originalMcpBearerToken;
  if (originalGatewayUrl === undefined) delete process.env.LLM_GATEWAY_URL;
  else process.env.LLM_GATEWAY_URL = originalGatewayUrl;
  vi.restoreAllMocks();
});

/** Parse the JSON body a mocked fetch was called with. */
function bodyOf(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const init = fetchMock.mock.calls[0]?.[1] as { body?: string } | undefined;
  return JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
}

describe("M35.4 llmRespond validation", () => {
  it("rejects an empty messages array with a clear error", async () => {
    const { llmRespond } = await import("../src/llm-gateway/client");
    await expect(
      llmRespond({ messages: [] as never }),
    ).rejects.toThrow(/messages cannot be empty/);
  });

  it("rejects an invalid role with a clear error", async () => {
    const { llmRespond } = await import("../src/llm-gateway/client");
    await expect(
      llmRespond({
        messages: [{ role: "wizard" as never, content: "hi" }],
      }),
    ).rejects.toThrow(/MCP-routed LLM request validation failed/);
  });

  it("rejects a non-string content with a clear error", async () => {
    const { llmRespond } = await import("../src/llm-gateway/client");
    await expect(
      llmRespond({
        messages: [{ role: "user", content: 123 as never }],
      }),
    ).rejects.toThrow(/MCP-routed LLM request validation failed/);
  });

  it("rejects temperature outside [0, 2]", async () => {
    const { llmRespond } = await import("../src/llm-gateway/client");
    await expect(
      llmRespond({
        messages: [{ role: "user", content: "hi" }],
        temperature: 5 as never,
      }),
    ).rejects.toThrow(/MCP-routed LLM request validation failed/);
  });

  it("rejects non-positive max_output_tokens", async () => {
    const { llmRespond } = await import("../src/llm-gateway/client");
    await expect(
      llmRespond({
        messages: [{ role: "user", content: "hi" }],
        max_output_tokens: 0 as never,
      }),
    ).rejects.toThrow(/MCP-routed LLM request validation failed/);
  });
});

describe("M35.4 llmEmbed validation", () => {
  it("rejects empty input array with a clear error", async () => {
    const { llmEmbed } = await import("../src/llm-gateway/client");
    await expect(
      llmEmbed({ input: [] as never }),
    ).rejects.toThrow(/input cannot be empty/);
  });
});

describe("MCP response parsing", () => {
  it("maps a valid /mcp/invoke envelope into a chat completion", async () => {
    process.env.MCP_SERVER_URL = "http://mcp.test";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      data: {
        finalResponse: "done",
        finishReason: "stop",
        tokensUsed: { input: 4, output: 2 },
        modelUsage: { provider: "anthropic", model: "claude", modelAlias: "balanced" },
      },
    }), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { llmRespond } = await import("../src/llm-gateway/client");
    const result = await llmRespond({ messages: [{ role: "user", content: "hi" }] });

    expect(result.content).toBe("done");
    expect(result.provider).toBe("anthropic");
    expect(result.input_tokens).toBe(4);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://mcp.test/mcp/invoke",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("rejects plain-text /mcp/invoke responses with a body snippet", async () => {
    process.env.MCP_SERVER_URL = "http://mcp.test";
    globalThis.fetch = vi.fn(async () =>
      new Response("Internal Server Error", { status: 200 }),
    ) as unknown as typeof fetch;

    const { llmRespond } = await import("../src/llm-gateway/client");
    await expect(
      llmRespond({ messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow(/MCP \/mcp\/invoke returned malformed JSON: Internal Server Error/);
  });

  it("rejects non-object /mcp/invoke envelopes instead of returning an empty completion", async () => {
    process.env.MCP_SERVER_URL = "http://mcp.test";
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify([]), { status: 200 }),
    ) as unknown as typeof fetch;

    const { llmRespond } = await import("../src/llm-gateway/client");
    await expect(
      llmRespond({ messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow(/response was not a JSON object/);
  });

  it("rejects /mcp/invoke success envelopes with no data", async () => {
    process.env.MCP_SERVER_URL = "http://mcp.test";
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    ) as unknown as typeof fetch;

    const { llmRespond } = await import("../src/llm-gateway/client");
    await expect(
      llmRespond({ messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow(/returned no invocation data/);
  });

  it("maps a valid /mcp/embed envelope into embeddings", async () => {
    process.env.MCP_SERVER_URL = "http://mcp.test";
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      data: {
        data: [{ index: 0, embedding: [0.1, 0.2] }],
        model: "embedder",
        provider: "mcp",
        dimensions: 2,
        latency_ms: 12,
      },
    }), { status: 200 })) as unknown as typeof fetch;

    const { llmEmbed } = await import("../src/llm-gateway/client");
    const result = await llmEmbed({ input: ["hello"] });

    expect(result.data[0].embedding).toEqual([0.1, 0.2]);
    expect(result.dimensions).toBe(2);
  });

  it("rejects /mcp/embed success envelopes with no data", async () => {
    process.env.MCP_SERVER_URL = "http://mcp.test";
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    ) as unknown as typeof fetch;

    const { llmEmbed } = await import("../src/llm-gateway/client");
    await expect(llmEmbed({ input: ["hello"] })).rejects.toThrow(/returned no embedding data/);
  });
});

/**
 * Task identity has to SURVIVE the hop, not merely be accepted by the type.
 *
 * The direct-to-gateway path is the one that matters: it is where the gateway's
 * policy engine can act on task_tag. These tests assert on the serialized body
 * because that is the only place a silent drop is visible — a dropped field
 * still type-checks, still validates, and still returns a perfectly good
 * completion from whatever model the gateway defaulted to.
 */
describe("task identity reaches the gateway", () => {
  const okChat = () => new Response(JSON.stringify({
    content: "ok", finish_reason: "stop", input_tokens: 1, output_tokens: 1,
    latency_ms: 0, provider: "anthropic", model: "claude",
  }), { status: 200 });

  const okEmbed = () => new Response(JSON.stringify({
    embeddings: [[0.1]], dim: 1, provider: "openai", model: "embedder", input_tokens: 1, latency_ms: 0,
  }), { status: 200 });

  it("forwards task_tag/stage/purpose on the direct chat path", async () => {
    process.env.MCP_SERVER_URL = "http://mcp.test";
    process.env.LLM_GATEWAY_URL = "http://gateway.test";
    const fetchMock = vi.fn(async () => okChat());
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { llmRespond } = await import("../src/llm-gateway/client");
    await llmRespond({
      messages: [{ role: "user", content: "hi" }],
      task_tag: "summarise",
      stage: "develop",
      purpose: "symbol_summary",
    });

    const body = bodyOf(fetchMock);
    expect(body.task_tag).toBe("summarise");
    expect(body.stage).toBe("develop");
    expect(body.purpose).toBe("symbol_summary");
    // No alias sent → the gateway is being asked to choose, not told.
    expect(body.model_alias).toBeUndefined();
  });

  it("keeps an explicit model_alias winning alongside task_tag", async () => {
    process.env.MCP_SERVER_URL = "http://mcp.test";
    process.env.LLM_GATEWAY_URL = "http://gateway.test";
    const fetchMock = vi.fn(async () => okChat());
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { llmRespond } = await import("../src/llm-gateway/client");
    await llmRespond({
      messages: [{ role: "user", content: "hi" }],
      task_tag: "summarise",
      model_alias: "operator-pinned",
    });

    const body = bodyOf(fetchMock);
    // Both cross the hop. Precedence is the GATEWAY's call (model_alias is a hard
    // pin that skips policy) — the client must not decide it by dropping a field.
    expect(body.model_alias).toBe("operator-pinned");
    expect(body.task_tag).toBe("summarise");
  });

  it("forwards task identity on the direct EMBEDDINGS path", async () => {
    // Regression guard. This path used to rebuild the body as {input, model_alias?},
    // so task_tag would have been dropped on the floor and embeddings — the
    // highest-volume traffic on the gateway — would have arrived untagged.
    process.env.MCP_SERVER_URL = "http://mcp.test";
    process.env.LLM_GATEWAY_URL = "http://gateway.test";
    const fetchMock = vi.fn(async () => okEmbed());
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { llmEmbed } = await import("../src/llm-gateway/client");
    await llmEmbed({
      input: ["hello"],
      task_tag: "embedding",
      purpose: "capability_grounding",
      trace_id: "trace-1",
      capability_id: "cap-1",
    });

    const body = bodyOf(fetchMock);
    expect(body.task_tag).toBe("embedding");
    expect(body.purpose).toBe("capability_grounding");
    // trace_id/capability_id were ALSO being dropped by the old rebuild — they
    // are what make a cost row attributable, so they are asserted here too.
    expect(body.trace_id).toBe("trace-1");
    expect(body.capability_id).toBe("cap-1");
    expect(body.input).toEqual(["hello"]);
  });

  it("accepts task identity through Zod validation rather than rejecting it", async () => {
    const { llmRespond } = await import("../src/llm-gateway/client");
    // MCP_SERVER_URL=mock from beforeEach → validation runs, then short-circuits.
    await expect(
      llmRespond({ messages: [{ role: "user", content: "hi" }], task_tag: "judge" }),
    ).resolves.toBeDefined();
  });
});
