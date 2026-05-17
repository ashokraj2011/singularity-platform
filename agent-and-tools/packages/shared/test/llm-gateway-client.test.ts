/**
 * M35.5 — tests for M35.4 Zod validation on the LLM gateway client.
 *
 * Proves that malformed ChatCompletionRequest / EmbeddingsRequest shapes
 * fail at the calling service with a clear error message instead of
 * bouncing off the gateway with a generic 422.
 */
import { describe, it, expect, beforeEach } from "vitest";

beforeEach(() => {
  // Force the mock gateway path so we don't try a real HTTP call when the
  // validation passes.
  process.env.LLM_GATEWAY_URL = "mock";
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
    ).rejects.toThrow(/llm gateway request validation failed/);
  });

  it("rejects a non-string content with a clear error", async () => {
    const { llmRespond } = await import("../src/llm-gateway/client");
    await expect(
      llmRespond({
        messages: [{ role: "user", content: 123 as never }],
      }),
    ).rejects.toThrow(/llm gateway request validation failed/);
  });

  it("rejects temperature outside [0, 2]", async () => {
    const { llmRespond } = await import("../src/llm-gateway/client");
    await expect(
      llmRespond({
        messages: [{ role: "user", content: "hi" }],
        temperature: 5 as never,
      }),
    ).rejects.toThrow(/llm gateway request validation failed/);
  });

  it("rejects non-positive max_output_tokens", async () => {
    const { llmRespond } = await import("../src/llm-gateway/client");
    await expect(
      llmRespond({
        messages: [{ role: "user", content: "hi" }],
        max_output_tokens: 0 as never,
      }),
    ).rejects.toThrow(/llm gateway request validation failed/);
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
