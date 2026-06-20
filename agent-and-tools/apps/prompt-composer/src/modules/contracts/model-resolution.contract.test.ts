import assert from "node:assert/strict";
import { ValidationError } from "../../shared/errors";

type FetchResponse = {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
  text?: () => Promise<string>;
};

const originalFetch = globalThis.fetch;

function mockFetch(response: FetchResponse) {
  globalThis.fetch = (async () => response) as unknown as typeof fetch;
}

async function expectValidationError(fn: () => Promise<unknown>, pattern: RegExp) {
  try {
    await fn();
  } catch (err) {
    assert(err instanceof ValidationError);
    assert.match(err.message, pattern);
    return;
  }
  assert.fail("expected ValidationError");
}

async function main() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://test:test@localhost:5432/test";
  const { resolveModelAlias } = await import("./contracts.service");

  mockFetch({
    ok: true,
    status: 200,
    json: async () => ({
      success: true,
      data: {
        defaultModelAlias: "balanced",
        models: [
          { id: "balanced", provider: "anthropic", model: "claude-sonnet-4-5-20251001", version: "2026-06-19" },
          { id: "fast", provider: "openai", model: "gpt-4o-mini" },
        ],
      },
    }),
  });

  const defaultResolution = await resolveModelAlias(undefined);
  assert.equal(defaultResolution.alias, "balanced");
  assert.equal(defaultResolution.provider, "anthropic");
  assert.equal(defaultResolution.model, "claude-sonnet-4-5-20251001");
  assert.equal(defaultResolution.version, "2026-06-19");

  const explicitResolution = await resolveModelAlias("fast");
  assert.equal(explicitResolution.alias, "fast");
  assert.equal(explicitResolution.provider, "openai");
  assert.equal(explicitResolution.model, "gpt-4o-mini");

  await expectValidationError(
    () => resolveModelAlias("missing"),
    /model alias "missing" was not found/,
  );

  mockFetch({
    ok: false,
    status: 503,
    text: async () => "unavailable",
  });
  await expectValidationError(
    () => resolveModelAlias("balanced"),
    /model catalog lookup failed/,
  );

  mockFetch({
    ok: true,
    status: 200,
    json: async () => ({ success: true, data: { models: [] } }),
  });
  await expectValidationError(
    () => resolveModelAlias(undefined),
    /no modelAlias supplied and model catalog has no default alias/,
  );

  globalThis.fetch = originalFetch;
  console.log("ImmutableContract model resolution contract passed");
}

main().catch((err) => {
  globalThis.fetch = originalFetch;
  console.error(err);
  process.exit(1);
});
