import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const BASE_ENV = {
  ...process.env,
  NODE_ENV: "test",
  MCP_BEARER_TOKEN: "test-bearer-token-12345",
  LLM_GATEWAY_URL: "mock",
};

function runConfig(extraEnv: Record<string, string | undefined>) {
  return spawnSync(
    process.execPath,
    [
      "-r",
      "ts-node/register/transpile-only",
      "-e",
      [
        "const { config } = require('./src/config');",
        "console.log([",
        "config.MCP_LOOP_REPETITION_THRESHOLD,",
        "config.MCP_LOOP_REPETITION_WINDOW,",
        "config.SYSTEM_PROMPT_CACHE_TTL_SEC,",
        "config.MCP_PROMPT_COMPOSER_TIMEOUT_SEC,",
        "config.MCP_AGENT_RUNTIME_WORLD_MODEL_TIMEOUT_SEC,",
        "config.MCP_MUTATION_FINALIZATION_MAX_TOKENS,",
        "config.MCP_PII_NER_CONFIDENCE_FLOOR",
        "].join(':'));",
      ].join(" "),
    ],
    {
      cwd: process.cwd(),
      env: { ...BASE_ENV, ...extraEnv },
      encoding: "utf8",
    },
  );
}

const defaults = runConfig({});
assert.equal(defaults.status, 0, defaults.stderr);
assert.match(defaults.stdout, /3:5:300:5:5:4096:0\.7/);

const custom = runConfig({
  MCP_LOOP_REPETITION_THRESHOLD: "4",
  MCP_LOOP_REPETITION_WINDOW: "9",
  SYSTEM_PROMPT_CACHE_TTL_SEC: "120",
  MCP_PROMPT_COMPOSER_TIMEOUT_SEC: "9",
  MCP_AGENT_RUNTIME_WORLD_MODEL_TIMEOUT_SEC: "12",
  MCP_MUTATION_FINALIZATION_MAX_TOKENS: "8192",
  MCP_PII_NER_CONFIDENCE_FLOOR: "0.85",
});
assert.equal(custom.status, 0, custom.stderr);
assert.match(custom.stdout, /4:9:120:9:12:8192:0\.85/);

const impossibleLoopDetector = runConfig({
  MCP_LOOP_REPETITION_THRESHOLD: "10",
  MCP_LOOP_REPETITION_WINDOW: "3",
});
assert.notEqual(impossibleLoopDetector.status, 0);
assert.match(impossibleLoopDetector.stderr, /MCP_LOOP_REPETITION_THRESHOLD/);

for (const [name, value] of [
  ["MCP_LOOP_REPETITION_THRESHOLD", "0"],
  ["MCP_LOOP_REPETITION_WINDOW", "101"],
  ["SYSTEM_PROMPT_CACHE_TTL_SEC", "999999"],
  ["MCP_PROMPT_COMPOSER_TIMEOUT_SEC", "0"],
  ["MCP_AGENT_RUNTIME_WORLD_MODEL_TIMEOUT_SEC", "0"],
  ["MCP_MUTATION_FINALIZATION_MAX_TOKENS", "999999"],
  ["MCP_PII_NER_CONFIDENCE_FLOOR", "1.1"],
] as const) {
  const result = runConfig({ [name]: value });
  assert.notEqual(result.status, 0, `${name}=${value} should be rejected`);
  assert.match(result.stderr, new RegExp(name));
}

const configSource = readFileSync("src/config.ts", "utf8");
assert.match(configSource, /MCP_LOOP_REPETITION_THRESHOLD: boundedPositiveInt\(3, MCP_LIMITS\.LOOP_REPETITION_THRESHOLD\)/);
assert.match(configSource, /MCP_LOOP_REPETITION_WINDOW: boundedPositiveInt\(5, MCP_LIMITS\.LOOP_REPETITION_WINDOW\)/);
assert.match(configSource, /SYSTEM_PROMPT_CACHE_TTL_SEC: boundedPositiveInt\(300, MCP_LIMITS\.SYSTEM_PROMPT_CACHE_TTL_SEC\)/);
assert.match(configSource, /MCP_PROMPT_COMPOSER_TIMEOUT_SEC: boundedPositiveInt\(5, MCP_LIMITS\.PROMPT_COMPOSER_TIMEOUT_SEC\)/);
assert.match(configSource, /MCP_AGENT_RUNTIME_WORLD_MODEL_TIMEOUT_SEC: boundedPositiveInt\([\s\S]*?5,[\s\S]*?MCP_LIMITS\.AGENT_RUNTIME_WORLD_MODEL_TIMEOUT_SEC/);
assert.match(configSource, /MCP_MUTATION_FINALIZATION_MAX_TOKENS: boundedPositiveInt\(4096, MCP_LIMITS\.MUTATION_FINALIZATION_MAX_TOKENS\)/);
assert.match(configSource, /MCP_PII_NER_CONFIDENCE_FLOOR: boundedNumber\(0\.7, 0, 1\)/);

const invokeSource = readFileSync("src/mcp/invoke.ts", "utf8");
assert.match(invokeSource, /const LOOP_REPETITION_THRESHOLD = config\.MCP_LOOP_REPETITION_THRESHOLD;/);
assert.match(invokeSource, /const LOOP_REPETITION_WINDOW\s+= config\.MCP_LOOP_REPETITION_WINDOW;/);
assert.match(invokeSource, /const NUDGE_PROMPT_TTL_MS = config\.SYSTEM_PROMPT_CACHE_TTL_SEC \* 1000;/);
assert.match(invokeSource, /const PROMPT_COMPOSER_TIMEOUT_MS = config\.MCP_PROMPT_COMPOSER_TIMEOUT_SEC \* 1000;/);
assert.match(invokeSource, /config\.MCP_MUTATION_FINALIZATION_MAX_TOKENS/);
assert.doesNotMatch(invokeSource, /Number\(process\.env\.MCP_LOOP_REPETITION_THRESHOLD/);
assert.doesNotMatch(invokeSource, /Number\(process\.env\.MCP_LOOP_REPETITION_WINDOW/);
assert.doesNotMatch(invokeSource, /Number\(process\.env\.SYSTEM_PROMPT_CACHE_TTL_SEC/);
assert.doesNotMatch(invokeSource, /AbortSignal\.timeout\(5_000\)/);
assert.doesNotMatch(invokeSource, /Number\(process\.env\.MCP_MUTATION_FINALIZATION_MAX_TOKENS/);

const piiSource = readFileSync("src/security/pii-ner.ts", "utf8");
assert.match(piiSource, /const NER_CONFIDENCE_FLOOR = config\.MCP_PII_NER_CONFIDENCE_FLOOR;/);
assert.doesNotMatch(piiSource, /Number\(process\.env\.MCP_PII_NER_CONFIDENCE_FLOOR/);

console.log("mcp runtime env config contract tests passed");
