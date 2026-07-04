import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ValidationError } from "../../shared/errors";
import { boundedIntEnv } from "../../shared/env-bounds";

type FetchResponse = {
  ok: boolean;
  status: number;
  text?: () => Promise<string>;
};

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

function mockFetch(response: FetchResponse) {
  globalThis.fetch = (async () => response) as unknown as typeof fetch;
}

function jsonResponse(body: unknown): FetchResponse {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  };
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
  try {
    process.env.CONTRACT_MODEL_CATALOG_TIMEOUT_SEC = "bad";
    assert.equal(boundedIntEnv("CONTRACT_MODEL_CATALOG_TIMEOUT_SEC", 10, 1, 300), 10);

    process.env.CONTRACT_MODEL_CATALOG_TIMEOUT_SEC = "0";
    assert.equal(boundedIntEnv("CONTRACT_MODEL_CATALOG_TIMEOUT_SEC", 10, 1, 300), 10);

    process.env.CONTRACT_MODEL_CATALOG_TIMEOUT_SEC = "12.9";
    assert.equal(boundedIntEnv("CONTRACT_MODEL_CATALOG_TIMEOUT_SEC", 10, 1, 300), 12);

    process.env.CONTRACT_MODEL_CATALOG_TIMEOUT_SEC = "9999";
    assert.equal(boundedIntEnv("CONTRACT_MODEL_CATALOG_TIMEOUT_SEC", 10, 1, 300), 300);
  } finally {
    process.env = { ...originalEnv };
  }

  const configSource = readFileSync("src/modules/contracts/contracts.config.ts", "utf8");
  const serviceSource = readFileSync("src/modules/contracts/contracts.service.ts", "utf8");
  assert.match(
    configSource,
    /boundedIntEnv\("CONTRACT_MODEL_CATALOG_TIMEOUT_SEC", 10, 1, 300\)/,
    "ImmutableContract model catalog timeout must be bounded at 1..300 seconds",
  );
  assert.match(
    serviceSource,
    /const CONTRACTS_CONFIG = contractsConfig\(\);/,
    "ImmutableContract service must read bounded contracts config once",
  );
  assert.match(
    serviceSource,
    /AbortSignal\.timeout\(CONTRACTS_CONFIG\.modelCatalogTimeoutMs\)/,
    "ImmutableContract model catalog fetch must use bounded timeout config",
  );
  assert.doesNotMatch(
    serviceSource,
    /AbortSignal\.timeout\(10_000\)/,
    "ImmutableContract model catalog fetch must not hardcode a 10 second timeout",
  );

  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://test:test@localhost:5432/test";
  const { resolveModelAlias } = await import("./contracts.service");

  mockFetch(jsonResponse({
    success: true,
    data: {
      defaultModelAlias: "balanced",
      models: [
        { id: "balanced", provider: "anthropic", model: "claude-sonnet-4-5-20251001", version: "2026-06-19" },
        { id: "fast", provider: "openai", model: "gpt-4o-mini" },
      ],
    },
  }));

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

  mockFetch(jsonResponse({ success: true, data: { models: [] } }));
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
