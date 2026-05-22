/**
 * M62 Slice D — Contract test for compressAssembledLayers.
 *
 * Stubs global fetch to canned responses so we can exercise:
 *   - allowlist semantics (only matching layerTypes considered)
 *   - budget gate (under-budget layers stay untouched)
 *   - happy path (over-budget allowlisted layer is replaced + stamped)
 *   - failure path (compressor 5xx → layer untouched + warning pushed)
 *   - disabled path (cfg.enabled=false → no-op even with over-budget layers)
 *
 * Run via the existing `test:contracts` npm script (Slice F's
 * world-model layer test pattern).
 */
import assert from "node:assert/strict";

process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://test:test@localhost:5432/test";
process.env.RUNTIME_DATABASE_URL = process.env.RUNTIME_DATABASE_URL ?? process.env.DATABASE_URL;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const svc = require("./compose.service") as typeof import("./compose.service");

type Layer = {
  layerType: string;
  priority: number;
  inclusionReason: string;
  contentSnapshot: string;
  layerHash: string;
  compressionReceipt?: Record<string, unknown>;
};

function makeLayer(layerType: string, chars: number, content?: string): Layer {
  const body = content ?? "X".repeat(chars);
  return {
    layerType,
    priority: 100,
    inclusionReason: "test",
    contentSnapshot: body,
    layerHash: "stale-hash",
  };
}

// ---- fetch stub ------------------------------------------------------------

type StubResponse = {
  status: number;
  body: Record<string, unknown> | string;
};

let stubResponses: StubResponse[] = [];
let stubCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
const realFetch = globalThis.fetch;

function installStub(responses: StubResponse[]): void {
  stubResponses = responses.slice();
  stubCalls = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const r = stubResponses.shift();
    if (!r) throw new Error("stub fetch: no canned response left");
    stubCalls.push({
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : {},
    });
    return new Response(
      typeof r.body === "string" ? r.body : JSON.stringify(r.body),
      { status: r.status, headers: { "content-type": "application/json" } },
    );
  }) as typeof globalThis.fetch;
}

function restoreFetch(): void {
  globalThis.fetch = realFetch;
  stubResponses = [];
  stubCalls = [];
}

// ---- Tests -----------------------------------------------------------------

async function testDisabledNoOp() {
  // 1500-token budget, 8000-char layer (≈2000 tokens) — would compress
  // if enabled. cfg.enabled=false → no fetch call, layer untouched.
  const layers = [makeLayer("CODE_AGENT_RULES", 8000)];
  installStub([]); // any call would throw
  const out = await svc.compressAssembledLayers(layers as never, {
    enabled: false,
    perLayerBudgetTokens: 1500,
    layerKindsAllowed: ["CODE_AGENT_RULES"],
    compressorUrl: "http://stub:8011",
    timeoutMs: 5000,
  });
  assert.equal(out.compressed, 0);
  assert.equal(stubCalls.length, 0, "no fetch when disabled");
  assert.equal(layers[0].contentSnapshot.length, 8000, "layer untouched");
  restoreFetch();
}

async function testMissingUrlNoOp() {
  // enabled=true but no compressorUrl → no-op (degraded mode).
  const layers = [makeLayer("CODE_AGENT_RULES", 8000)];
  installStub([]);
  const out = await svc.compressAssembledLayers(layers as never, {
    enabled: true,
    perLayerBudgetTokens: 1500,
    layerKindsAllowed: ["CODE_AGENT_RULES"],
    compressorUrl: undefined,
    timeoutMs: 5000,
  });
  assert.equal(out.compressed, 0);
  assert.equal(stubCalls.length, 0);
  restoreFetch();
}

async function testAllowlistFilter() {
  // Over-budget layer NOT in allowlist → no compression.
  const layers = [makeLayer("TOOL_CONTRACT", 12_000)];
  installStub([]);
  const out = await svc.compressAssembledLayers(layers as never, {
    enabled: true,
    perLayerBudgetTokens: 1500,
    layerKindsAllowed: ["CODE_AGENT_RULES", "RUNTIME_EVIDENCE"],
    compressorUrl: "http://stub:8011",
    timeoutMs: 5000,
  });
  assert.equal(out.compressed, 0);
  assert.equal(stubCalls.length, 0, "non-allowlisted layer never POSTed");
  restoreFetch();
}

async function testUnderBudgetNoOp() {
  // Allowlisted layer UNDER budget → skipped to avoid round-trip cost.
  // 4000 chars ≈ 1000 tokens; budget 1500.
  const layers = [makeLayer("CODE_AGENT_RULES", 4000)];
  installStub([]);
  const out = await svc.compressAssembledLayers(layers as never, {
    enabled: true,
    perLayerBudgetTokens: 1500,
    layerKindsAllowed: ["CODE_AGENT_RULES"],
    compressorUrl: "http://stub:8011",
    timeoutMs: 5000,
  });
  assert.equal(out.compressed, 0);
  assert.equal(stubCalls.length, 0);
  restoreFetch();
}

async function testHappyPath() {
  // Over-budget allowlisted layer → POST → snapshot replaced + receipt stamped.
  const layers = [
    makeLayer("CODE_AGENT_RULES", 8000),
    makeLayer("CODE_WORLD_MODEL", 3000),  // under budget, untouched
    makeLayer("RUNTIME_EVIDENCE", 9000),  // also over → 2 calls
  ];
  installStub([
    { status: 200, body: { compressed_text: "tiny-1", original_tokens: 2000, compressed_tokens: 500, ratio: 0.25, model: "stub", duration_ms: 100, receipt_id: "cmprx-A" } },
    { status: 200, body: { compressed_text: "tiny-2", original_tokens: 2250, compressed_tokens: 450, ratio: 0.2, model: "stub", duration_ms: 110, receipt_id: "cmprx-B" } },
  ]);
  const out = await svc.compressAssembledLayers(layers as never, {
    enabled: true,
    perLayerBudgetTokens: 1500,
    layerKindsAllowed: ["CODE_AGENT_RULES", "RUNTIME_EVIDENCE"],
    compressorUrl: "http://stub:8011",
    timeoutMs: 5000,
  });
  assert.equal(out.compressed, 2);
  assert.equal(out.warnings.length, 0);
  assert.equal(layers[0].contentSnapshot, "tiny-1", "rules replaced");
  assert.equal(layers[1].contentSnapshot.length, 3000, "world-model untouched");
  assert.equal(layers[2].contentSnapshot, "tiny-2", "evidence replaced");
  assert.equal(layers[0].compressionReceipt?.receiptId, "cmprx-A");
  assert.equal(layers[2].compressionReceipt?.receiptId, "cmprx-B");
  assert.notEqual(layers[0].layerHash, "stale-hash", "hash re-stamped");
  // Verify POST body shape
  assert.equal(stubCalls.length, 2);
  assert.equal(stubCalls[0].body.target_token, 1500);
  assert.equal((stubCalls[0].body.metadata as Record<string, unknown>).layerType, "CODE_AGENT_RULES");
  restoreFetch();
}

async function testHttpFailureWarnsAndSkips() {
  // Compressor returns 503 → layer left alone, warning pushed.
  const layers = [makeLayer("CODE_AGENT_RULES", 8000)];
  installStub([{ status: 503, body: { error: "model unloaded" } }]);
  const out = await svc.compressAssembledLayers(layers as never, {
    enabled: true,
    perLayerBudgetTokens: 1500,
    layerKindsAllowed: ["CODE_AGENT_RULES"],
    compressorUrl: "http://stub:8011",
    timeoutMs: 5000,
  });
  assert.equal(out.compressed, 0);
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0], /CODE_AGENT_RULES/);
  assert.match(out.warnings[0], /compressor unreachable or failed/);
  assert.equal(layers[0].contentSnapshot.length, 8000, "layer untouched on failure");
  assert.equal(layers[0].layerHash, "stale-hash", "hash NOT re-stamped on failure");
  assert.equal(layers[0].compressionReceipt, undefined);
  restoreFetch();
}

async function testNetworkFailureWarns() {
  // fetch itself throws → captured + warned (not propagated).
  const layers = [makeLayer("CODE_AGENT_RULES", 8000)];
  const realFetchSaved = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as typeof globalThis.fetch;
  try {
    const out = await svc.compressAssembledLayers(layers as never, {
      enabled: true,
      perLayerBudgetTokens: 1500,
      layerKindsAllowed: ["CODE_AGENT_RULES"],
      compressorUrl: "http://stub:8011",
      timeoutMs: 5000,
    });
    assert.equal(out.compressed, 0);
    assert.equal(out.warnings.length, 1);
    assert.match(out.warnings[0], /compressor unreachable or failed/);
  } finally {
    globalThis.fetch = realFetchSaved;
  }
}

// ---- Runner ----------------------------------------------------------------

const tests: Array<[string, () => Promise<void>]> = [
  ["disabled cfg → no fetch + no layer changes", testDisabledNoOp],
  ["missing compressorUrl → no-op", testMissingUrlNoOp],
  ["allowlist filter skips non-allowlisted layers", testAllowlistFilter],
  ["under-budget layer skipped to save round-trip", testUnderBudgetNoOp],
  ["over-budget allowlisted layers compressed + stamped", testHappyPath],
  ["compressor 5xx → warn, layer untouched", testHttpFailureWarnsAndSkips],
  ["network error → warn, layer untouched", testNetworkFailureWarns],
];

// Wrapped in an async IIFE because ts-node --transpile-only on CJS
// modules doesn't permit top-level await. The other contract tests
// in this directory are sync; this one needs async because the
// stubbed fetch + compressor walker are async.
(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      // eslint-disable-next-line no-console
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failed += 1;
      // eslint-disable-next-line no-console
      console.error(`  ✗ ${name}\n    ${(err as Error).message}`);
    }
  }
  if (failed > 0) {
    // eslint-disable-next-line no-console
    console.error(`\n${failed} of ${tests.length} compression contract tests failed`);
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.log(`\nAll ${tests.length} compression contract tests passed`);
})();
