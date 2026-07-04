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

beforeEach(() => {
  // Force the mock MCP path so we don't try a real HTTP call when validation passes.
  process.env.MCP_SERVER_URL = "mock";
  delete process.env.MCP_BEARER_TOKEN;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalMcpServerUrl === undefined) delete process.env.MCP_SERVER_URL;
  else process.env.MCP_SERVER_URL = originalMcpServerUrl;
  if (originalMcpBearerToken === undefined) delete process.env.MCP_BEARER_TOKEN;
  else process.env.MCP_BEARER_TOKEN = originalMcpBearerToken;
  vi.restoreAllMocks();
});

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
