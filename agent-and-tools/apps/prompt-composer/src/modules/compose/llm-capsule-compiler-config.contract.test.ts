import assert from "node:assert/strict";
import { llmCapsuleCompilerConfig } from "./llm-capsule-compiler.config";

const ORIGINAL_ENV = { ...process.env };

try {
  process.env.CAPSULE_COMPILE_TIMEOUT_MS = "bad";
  process.env.SYSTEM_PROMPT_CACHE_TTL_SEC = "bad";
  process.env.CAPSULE_COMPILE_MODEL_ALIAS = "  ";

  const invalid = llmCapsuleCompilerConfig();
  assert.equal(invalid.timeoutMs, 30_000);
  assert.equal(invalid.systemPromptCacheTtlMs, 300_000);
  assert.equal(invalid.modelAlias, undefined);

  process.env.CAPSULE_COMPILE_TIMEOUT_MS = "999999999";
  process.env.SYSTEM_PROMPT_CACHE_TTL_SEC = "999999999";
  process.env.CAPSULE_COMPILE_MODEL_ALIAS = "  claude-fast  ";

  const clamped = llmCapsuleCompilerConfig();
  assert.equal(clamped.timeoutMs, 5 * 60_000);
  assert.equal(clamped.systemPromptCacheTtlMs, 24 * 60 * 60_000);
  assert.equal(clamped.modelAlias, "claude-fast");

  process.env.CAPSULE_COMPILE_TIMEOUT_MS = "999";
  process.env.SYSTEM_PROMPT_CACHE_TTL_SEC = "0";

  const belowMin = llmCapsuleCompilerConfig();
  assert.equal(belowMin.timeoutMs, 30_000);
  assert.equal(belowMin.systemPromptCacheTtlMs, 300_000);
} finally {
  process.env = ORIGINAL_ENV;
}

console.log("llm capsule compiler config contract tests passed");
