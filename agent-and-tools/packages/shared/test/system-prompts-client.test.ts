import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSystemPrompt, invalidateSystemPromptCache } from "../src/system-prompts/client";

const originalFetch = globalThis.fetch;
const originalPromptComposerUrl = process.env.PROMPT_COMPOSER_URL;
const originalTtl = process.env.SYSTEM_PROMPT_CACHE_TTL_SEC;

function promptEnvelope(overrides: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({
    success: true,
    data: {
      key: "event-horizon.system",
      version: 3,
      content: "You are Event Horizon.",
      jsonSchema: null,
      modelHint: "balanced",
      ...overrides,
    },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  process.env.PROMPT_COMPOSER_URL = "http://prompt-composer.test";
  process.env.SYSTEM_PROMPT_CACHE_TTL_SEC = "1";
  invalidateSystemPromptCache();
  vi.useRealTimers();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalPromptComposerUrl === undefined) delete process.env.PROMPT_COMPOSER_URL;
  else process.env.PROMPT_COMPOSER_URL = originalPromptComposerUrl;
  if (originalTtl === undefined) delete process.env.SYSTEM_PROMPT_CACHE_TTL_SEC;
  else process.env.SYSTEM_PROMPT_CACHE_TTL_SEC = originalTtl;
  invalidateSystemPromptCache();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("system prompt client", () => {
  it("fetches and normalizes a system prompt envelope", async () => {
    const fetchMock = vi.fn(async () => promptEnvelope());
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await getSystemPrompt("event-horizon.system");

    expect(result.content).toBe("You are Event Horizon.");
    expect(result.modelHint).toBe("balanced");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://prompt-composer.test/api/v1/system-prompts/event-horizon.system",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("posts render variables to the composer render endpoint", async () => {
    const fetchMock = vi.fn(async () => promptEnvelope({ content: "Hello Ashok" }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await getSystemPrompt("welcome", { name: "Ashok" });

    expect(result.content).toBe("Hello Ashok");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://prompt-composer.test/api/v1/system-prompts/welcome/render",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ vars: { name: "Ashok" } }),
      }),
    );
  });

  it("reports malformed JSON with an upstream body snippet", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("Internal Server Error", { status: 200 }),
    ) as unknown as typeof fetch;

    await expect(getSystemPrompt("bad-json")).rejects.toThrow(
      /SystemPrompt fetch bad-json returned invalid JSON: Internal Server Error/,
    );
  });

  it("rejects incomplete success envelopes clearly", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ success: true, data: { key: "missing-content", version: 1 } }), { status: 200 }),
    ) as unknown as typeof fetch;

    await expect(getSystemPrompt("missing-content")).rejects.toThrow(
      /returned incomplete data/,
    );
  });

  it("returns stale cached prompt when composer later returns malformed JSON", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(promptEnvelope({ content: "cached copy" }))
      .mockResolvedValueOnce(new Response("Internal Server Error", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const first = await getSystemPrompt("event-horizon.system");
    expect(first.content).toBe("cached copy");

    vi.setSystemTime(new Date("2026-01-01T00:00:02.000Z"));
    const second = await getSystemPrompt("event-horizon.system");

    expect(second.content).toBe("cached copy");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to a safe cache TTL when SYSTEM_PROMPT_CACHE_TTL_SEC is invalid", async () => {
    process.env.SYSTEM_PROMPT_CACHE_TTL_SEC = "bad";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const fetchMock = vi.fn(async () => promptEnvelope({ content: "cached under default ttl" }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const first = await getSystemPrompt("event-horizon.system");
    vi.setSystemTime(new Date("2026-01-01T00:00:10.000Z"));
    const second = await getSystemPrompt("event-horizon.system");

    expect(first.content).toBe("cached under default ttl");
    expect(second.content).toBe("cached under default ttl");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("clamps an oversized cache TTL to one day", async () => {
    process.env.SYSTEM_PROMPT_CACHE_TTL_SEC = "999999999";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(promptEnvelope({ content: "day one" }))
      .mockResolvedValueOnce(promptEnvelope({ content: "day three" }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const first = await getSystemPrompt("event-horizon.system");
    vi.setSystemTime(new Date("2026-01-03T00:00:01.000Z"));
    const second = await getSystemPrompt("event-horizon.system");

    expect(first.content).toBe("day one");
    expect(second.content).toBe("day three");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
