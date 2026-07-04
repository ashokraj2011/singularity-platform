import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

// #25 — read-only slice: the governed turn resolves prompts via
// /stage-prompts/resolve, which now appends the capability's promoted long-term
// (distilled, ACTIVE) memory to extraContext. Source-asserted (the behavioral
// path needs the runtime-read DB; this locks the wiring against regression).
const svc = readFileSync("src/modules/stage-prompts/stage-prompts.service.ts", "utf8");
const schema = readFileSync("src/modules/stage-prompts/stage-prompts.schemas.ts", "utf8");
const pkg = readFileSync("package.json", "utf8");

assert.match(
  schema,
  /capabilityId:\s*z\.string\(\)\.min\(1\)\.optional\(\)/,
  "resolve schema must accept an optional capabilityId",
);
assert.match(
  svc,
  /import \{ prisma, runtimeReader \}/,
  "service must read distilled memory via the runtime-read client",
);
assert.match(
  svc,
  /async function renderLongTermMemory\(/,
  "a renderLongTermMemory helper must exist",
);
assert.match(
  svc,
  /import \{ stagePromptMemoryConfig \} from "\.\/stage-prompts\.config";/,
  "stage prompt memory limits must come from bounded config",
);
assert.match(
  svc,
  /const LONG_TERM_MEMORY_CONFIG = stagePromptMemoryConfig\(\);/,
  "stage prompt memory config must be read once through the helper",
);
assert.match(
  svc,
  /const LONG_TERM_MEMORY_TOP_K = LONG_TERM_MEMORY_CONFIG\.topK;/,
  "top-k must use bounded stage prompt memory config",
);
assert.match(
  svc,
  /const LONG_TERM_MEMORY_MAX_CHARS = LONG_TERM_MEMORY_CONFIG\.maxChars;/,
  "max chars must use bounded stage prompt memory config",
);
assert.doesNotMatch(
  svc,
  /Number\(process\.env\.STAGE_PROMPT_MEMORY_/,
  "stage prompt memory env must not be parsed directly",
);
assert.match(
  svc,
  /distilledMemory\.findMany\([\s\S]*?scopeType:\s*"CAPABILITY"[\s\S]*?status:\s*"ACTIVE"/,
  "must fetch ACTIVE capability-scoped distilled memory (the promoted long-term set)",
);
// Appended on BOTH resolve paths — the pinned-profile short-circuit AND the ladder.
const appendCount = (svc.match(/renderLongTermMemory\(input\.capabilityId\)/g) || []).length;
assert.ok(appendCount >= 2, `memory must be appended on both resolve paths (found ${appendCount})`);

assert.match(
  pkg,
  /stage-prompt-memory\.contract\.test\.ts/,
  "contract suite must include this test",
);

console.log("stage-prompt-memory.contract.test.ts: OK");
