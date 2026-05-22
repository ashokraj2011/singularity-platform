/**
 * M61 Slice F — Contract test for CODE_AGENT_RULES + CODE_WORLD_MODEL.
 *
 * Pure-function tests of renderCodeAgentRulesLayer and
 * renderCodeWorldModelLayer. The world-model layer is conditional —
 * partial inputs produce partial output, fully-empty input produces
 * null (skip the layer). This test pins both paths so a future refactor
 * doesn't accidentally emit an empty heading.
 *
 * Run via:
 *   pnpm --filter @agentandtools/prompt-composer run test:contracts
 */
import assert from "node:assert/strict";

process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://test:test@localhost:5432/test";
process.env.RUNTIME_DATABASE_URL = process.env.RUNTIME_DATABASE_URL ?? process.env.DATABASE_URL;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const svc = require("./compose.service") as typeof import("./compose.service");

// ── CODE_AGENT_RULES ──────────────────────────────────────────────────────

function testAgentRulesEmpty() {
  const out = svc.renderCodeAgentRulesLayer({
    capabilityId: "cap-1",
    testCommands: [],
    buildCommands: [],
    agentRules: [],
  });
  assert.equal(out, null, "empty agent rules should skip the layer");
}

function testAgentRulesSingle() {
  const out = svc.renderCodeAgentRulesLayer({
    capabilityId: "cap-1",
    testCommands: [],
    buildCommands: [],
    agentRules: [
      { source: "CLAUDE.md", content: "Always run mvn test before commit.", sha256: "sha256:abc" },
    ],
  });
  assert.ok(out, "single rule should produce output");
  assert.ok(out!.includes("## Capability Agent Rules"), "must have section heading");
  assert.ok(out!.includes("### Rules from CLAUDE.md"), "must attribute source");
  assert.ok(out!.includes("Always run mvn test before commit."), "must include verbatim body");
}

function testAgentRulesMultiple() {
  const out = svc.renderCodeAgentRulesLayer({
    capabilityId: "cap-1",
    testCommands: [],
    buildCommands: [],
    agentRules: [
      { source: "CLAUDE.md", content: "rule one", sha256: "sha256:1" },
      { source: ".cursor/rules/style.md", content: "rule two", sha256: "sha256:2" },
    ],
  });
  assert.ok(out, "multi rules should produce output");
  assert.ok(out!.includes("### Rules from CLAUDE.md"));
  assert.ok(out!.includes("### Rules from .cursor/rules/style.md"));
  // Both bodies present.
  assert.ok(out!.includes("rule one"));
  assert.ok(out!.includes("rule two"));
}

// ── CODE_WORLD_MODEL ──────────────────────────────────────────────────────

function testWorldModelEmpty() {
  const out = svc.renderCodeWorldModelLayer({
    capabilityId: "cap-1",
    testCommands: [],
    buildCommands: [],
    agentRules: [],
  });
  assert.equal(out, null, "fully empty world model should skip the layer");
}

function testWorldModelFactsOnly() {
  const out = svc.renderCodeWorldModelLayer({
    capabilityId: "cap-1",
    primaryLanguage: "java",
    buildSystem: "maven",
    testCommands: [],
    buildCommands: [],
    agentRules: [],
  });
  assert.ok(out, "facts-only world model should still render");
  assert.ok(out!.includes("## Capability World Model"));
  assert.ok(out!.includes("Primary language: java"));
  assert.ok(out!.includes("Build system: maven"));
  // No test/build sections when those arrays are empty.
  assert.ok(!out!.includes("### Test commands"));
  assert.ok(!out!.includes("### Build commands"));
}

function testWorldModelTestCommands() {
  const out = svc.renderCodeWorldModelLayer({
    capabilityId: "cap-1",
    primaryLanguage: "typescript",
    buildSystem: "pnpm",
    testCommands: [
      { kind: "unit", cmd: "pnpm test", expectedDurationSec: 30 },
      { kind: "integration", cmd: "pnpm test:int", cwd: "apps/api", requiresNetwork: true },
    ],
    buildCommands: [{ kind: "build", cmd: "pnpm build" }],
    agentRules: [],
  });
  assert.ok(out);
  assert.ok(out!.includes("### Test commands"));
  assert.ok(out!.includes("- unit: `pnpm test`"));
  assert.ok(out!.includes("~30s"));
  assert.ok(out!.includes("- integration: `pnpm test:int` (cwd: apps/api)"));
  assert.ok(out!.includes("network"));
  assert.ok(out!.includes("### Build commands"));
  assert.ok(out!.includes("- build: `pnpm build`"));
}

function testWorldModelReadmeSummary() {
  const out = svc.renderCodeWorldModelLayer({
    capabilityId: "cap-1",
    testCommands: [],
    buildCommands: [],
    agentRules: [],
    readmeSummary: "RuleEngine service that evaluates operator-based conditions.",
  });
  assert.ok(out);
  assert.ok(out!.includes("### README summary"));
  assert.ok(out!.includes("RuleEngine service"));
}

function testWorldModelArchitectureSlice() {
  const out = svc.renderCodeWorldModelLayer({
    capabilityId: "cap-1",
    testCommands: [],
    buildCommands: [],
    agentRules: [],
    architectureSlice: {
      rootPackages: [
        { path: "src/main/java/org/example/rules", language: "java",
          publicSymbols: ["RuleEngineService", "Operator", "Condition"] },
      ],
    },
  });
  assert.ok(out);
  assert.ok(out!.includes("### Top-level package map"));
  assert.ok(out!.includes("- src/main/java/org/example/rules (java)"));
  assert.ok(out!.includes("RuleEngineService, Operator, Condition"));
}

function testWorldModelArchitectureSliceTruncation() {
  const out = svc.renderCodeWorldModelLayer({
    capabilityId: "cap-1",
    testCommands: [],
    buildCommands: [],
    agentRules: [],
    architectureSlice: {
      rootPackages: [
        { path: "src/main/java/big", language: "java",
          publicSymbols: ["A", "B", "C", "D", "E", "F", "G", "H", "I"] },
      ],
    },
  });
  assert.ok(out);
  // First 6 shown, "(+3 more)" suffix for the rest.
  assert.ok(out!.includes("A, B, C, D, E, F"));
  assert.ok(out!.includes("(+3 more)"));
  // 7th symbol must NOT appear in the rendered list.
  assert.ok(!out!.match(/A, B, C, D, E, F, G/));
}

// ── appendWorldModelLayers wiring ─────────────────────────────────────────

function testAppendWorldModelLayers() {
  const layers: Array<{ layerType: string; priority: number; contentSnapshot: string }> = [];
  svc.appendWorldModelLayers(layers as never, {
    capabilityId: "cap-1",
    primaryLanguage: "java",
    buildSystem: "maven",
    testCommands: [{ kind: "unit", cmd: "mvn test" }],
    buildCommands: [],
    agentRules: [{ source: "CLAUDE.md", content: "be careful", sha256: "sha256:x" }],
  });
  assert.equal(layers.length, 2, "should push both rules + world model layers");
  const types = layers.map((l) => l.layerType).sort();
  assert.deepEqual(types, ["CODE_AGENT_RULES", "CODE_WORLD_MODEL"]);
  // Priorities: rules at 305, world model at 308.
  const rules = layers.find((l) => l.layerType === "CODE_AGENT_RULES")!;
  const wm = layers.find((l) => l.layerType === "CODE_WORLD_MODEL")!;
  assert.equal(rules.priority, 305);
  assert.equal(wm.priority, 308);
}

function testAppendSkipsEmptyLayers() {
  const layers: Array<{ layerType: string }> = [];
  svc.appendWorldModelLayers(layers as never, {
    capabilityId: "cap-1",
    testCommands: [],
    buildCommands: [],
    agentRules: [],
    // No facts, no commands, no rules, no summary → both renderers return null.
  });
  assert.equal(layers.length, 0, "should not push empty layers");
}

// ── Runner ────────────────────────────────────────────────────────────────

const tests: Array<[string, () => void]> = [
  ["agent rules — empty → null", testAgentRulesEmpty],
  ["agent rules — single", testAgentRulesSingle],
  ["agent rules — multiple", testAgentRulesMultiple],
  ["world model — fully empty → null", testWorldModelEmpty],
  ["world model — facts only", testWorldModelFactsOnly],
  ["world model — test/build commands", testWorldModelTestCommands],
  ["world model — README summary", testWorldModelReadmeSummary],
  ["world model — architecture slice", testWorldModelArchitectureSlice],
  ["world model — architecture slice truncation", testWorldModelArchitectureSliceTruncation],
  ["append — both layers wired", testAppendWorldModelLayers],
  ["append — skips empty layers", testAppendSkipsEmptyLayers],
];

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    // eslint-disable-next-line no-console
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    // eslint-disable-next-line no-console
    console.error(`  ✗ ${name}`);
    // eslint-disable-next-line no-console
    console.error(`    ${(err as Error).message}`);
  }
}
if (failed > 0) {
  // eslint-disable-next-line no-console
  console.error(`\n${failed} of ${tests.length} world-model layer tests failed`);
  process.exit(1);
}
// eslint-disable-next-line no-console
console.log(`\nAll ${tests.length} world-model layer tests passed`);
