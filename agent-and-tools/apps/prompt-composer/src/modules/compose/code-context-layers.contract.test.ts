/**
 * M52 Slice B — Contract test for the 7 CODE_* layer renderers.
 *
 * Pure-function tests: each renderer is given a fixture package and
 * asserted to produce the right shape. Run via:
 *   pnpm --filter @agentandtools/prompt-composer run test:contracts
 *
 * The env stub for DATABASE_URL keeps the existing compose.service
 * import path working (the file's top-level imports validate env on
 * load).
 */
import assert from "node:assert/strict";

process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://test:test@localhost:5432/test";
process.env.RUNTIME_DATABASE_URL = process.env.RUNTIME_DATABASE_URL ?? process.env.DATABASE_URL;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const svc = require("./compose.service") as typeof import("./compose.service");

// Minimal but representative fixture — matches mcp-server's CodeContextPackage shape.
const samplePkg = {
  context_package_id: "ctx-test-001",
  task_intent: {
    kind: "code_modification" as const,
    summary: "Add containsACharacter operator to RuleEngineService",
  },
  target_symbols: [
    { symbol: "Operator", file: "src/main/java/org/example/rules/Operator.java", language: "java",
      start_line: 1, end_line: 12, reason: "derived from task_text via findSymbols" },
    { symbol: "evalCondition", file: "src/main/java/org/example/rules/RuleEngineService.java", language: "java",
      start_line: 63, end_line: 241, reason: "derived from task_text via findSymbols" },
  ],
  editable_slices: [
    { file: "src/main/java/org/example/rules/Operator.java", symbol: "Operator",
      start_line: 1, end_line: 12, content: "public enum Operator { eq, ne, contains }",
      token_count: 11, content_hash: "a".repeat(64) },
    { file: "src/main/java/org/example/rules/RuleEngineService.java", symbol: "evalCondition",
      start_line: 63, end_line: 241, content: "// evalCondition body\nswitch(op) { case contains: ... }",
      token_count: 14, content_hash: "b".repeat(64) },
  ],
  dependency_slices: [
    { file: "src/main/java/org/example/rules/JsonUtils.java", symbol: "JsonUtils",
      start_line: 1, end_line: 30, content: "public class JsonUtils { ... }",
      token_count: 9, content_hash: "c".repeat(64), dependency_depth: 1 },
  ],
  test_slices: [
    { file: "src/test/java/org/example/rules/RuleEngineServiceTest.java", symbol: "testContains",
      start_line: 50, end_line: 70, content: "@Test void testContains() { ... }",
      token_count: 10, content_hash: "d".repeat(64) },
  ],
  excluded_context: [
    { file: "src/main/java/.../Big.java", symbol: "Helper", reason: "over token budget",
      estimated_tokens_avoided: 1200 },
  ],
  optimization: {
    raw_estimate: 19000,
    optimized_estimate: 44,
    tokens_saved: 18956,
    percent_saved: 99.77,
  },
};

// ── 1. Task intent layer always emits ───────────────────────────────────
const intent = svc.renderCodeTaskIntentLayer(samplePkg);
assert(intent.includes("## Code Task Intent"));
assert(intent.includes("Kind: code_modification"));
assert(intent.includes("containsACharacter"));

// ── 2. Target symbols layer emits one bullet per symbol ─────────────────
const targets = svc.renderCodeTargetSymbolsLayer(samplePkg);
assert(targets);
assert(targets!.includes("## Target Symbols"));
assert(targets!.includes("`Operator`"));
assert(targets!.includes("Operator.java:1-12"));
assert(targets!.includes("`evalCondition`"));

// ── 3. Editable slices layer emits a fenced block per slice ─────────────
const editable = svc.renderCodeEditableSlicesLayer(samplePkg);
assert(editable);
assert(editable!.includes("## Editable Code Slices"));
assert(editable!.includes("Operator.java:1-12"));
assert(editable!.includes("public enum Operator"));
assert(editable!.includes("RuleEngineService.java:63-241"));

// ── 4. Dependency slices layer includes dep_depth tag ───────────────────
const deps = svc.renderCodeDependencySlicesLayer(samplePkg);
assert(deps);
assert(deps!.includes("## Dependency Slices"));
assert(deps!.includes("dep_depth=1"));
assert(deps!.includes("JsonUtils.java"));

// ── 5. Type contracts layer fires when dependency symbols look type-like ─
const types = svc.renderCodeTypeContractsLayer(samplePkg);
assert(types, "JsonUtils (PascalCase) should be recognized as a type contract");
assert(types!.includes("## Type Contracts"));
assert(types!.includes("kind=type"));

// ── 6. Test slices layer emits when tests are present ───────────────────
const tests = svc.renderCodeTestSlicesLayer(samplePkg);
assert(tests);
assert(tests!.includes("## Relevant Tests"));
assert(tests!.includes("RuleEngineServiceTest.java"));

// ── 7. Receipt layer summarises optimization + lists exclusions ─────────
const receipt = svc.renderCodeContextReceiptLayer(samplePkg);
assert(receipt.includes("## Code Context Receipt"));
assert(receipt.includes("ctx-test-001"));
assert(receipt.includes("raw estimate: 19000"));
assert(receipt.includes("saved: 18956"));
assert(receipt.includes("99.77%"));
assert(receipt.includes("over token budget"));

// ── 8. appendCodeContextLayers emits exactly the right 7 layer types in priority order ─
const layers: { layerType: string; priority: number; contentSnapshot: string; inclusionReason?: string; layerHash?: string }[] = [];
svc.appendCodeContextLayers(layers, samplePkg);
const names = layers.map((l) => l.layerType);
assert.deepEqual(names, [
  "CODE_TASK_INTENT",
  "CODE_TARGET_SYMBOLS",
  "CODE_EDITABLE_SLICES",
  "CODE_DEPENDENCY_SLICES",
  "CODE_TYPE_CONTRACTS",
  "CODE_TEST_SLICES",
  "CODE_CONTEXT_RECEIPT",
]);
// Priorities monotonically increasing (CODE_TASK_INTENT=310 … CODE_CONTEXT_RECEIPT=316)
for (let i = 1; i < layers.length; i++) {
  assert(layers[i].priority > layers[i - 1].priority, "priorities should monotonically increase");
}

// ── 9. Empty optional sections produce no layer (instead of an empty one) ─
const minimalPkg = {
  ...samplePkg,
  dependency_slices: [],
  test_slices: [],
};
const minimalLayers: { layerType: string; priority: number; contentSnapshot: string; inclusionReason?: string; layerHash?: string }[] = [];
svc.appendCodeContextLayers(minimalLayers, minimalPkg);
const minimalNames = minimalLayers.map((l) => l.layerType);
assert(!minimalNames.includes("CODE_DEPENDENCY_SLICES"), "no deps → no dependency-slices layer");
assert(!minimalNames.includes("CODE_TEST_SLICES"), "no tests → no test-slices layer");
assert(!minimalNames.includes("CODE_TYPE_CONTRACTS"), "no PascalCase dep symbols → no type-contracts layer");
assert(minimalNames.includes("CODE_TASK_INTENT"));
assert(minimalNames.includes("CODE_EDITABLE_SLICES"));
assert(minimalNames.includes("CODE_CONTEXT_RECEIPT"));

console.log("M52 code-context layer contract tests: 9 sections passed");
