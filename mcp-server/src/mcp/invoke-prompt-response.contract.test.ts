import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const source = readFileSync(path.resolve(process.cwd(), "src/mcp/invoke.ts"), "utf8");

assert.match(
  source,
  /async function readPromptComposerSystemPrompt\(res: Response, key: string\): Promise<string>/,
  "MCP invoke loop should centralize Prompt Composer system prompt response parsing",
);

assert.match(
  source,
  /returned invalid JSON/,
  "Prompt Composer system prompt parsing should surface malformed successful bodies clearly",
);

assert.match(
  source,
  /returned no prompt content/,
  "Prompt Composer system prompt parsing should validate prompt content before caching",
);

assert.match(
  source,
  /cachedNudgePrompt = await readPromptComposerSystemPrompt\(res, NUDGE_PROMPT_KEY\)/,
  "code-tool-use nudge prompt should use guarded parsing",
);

assert.match(
  source,
  /const PROMPT_COMPOSER_TIMEOUT_MS = config\.MCP_PROMPT_COMPOSER_TIMEOUT_SEC \* 1000;/,
  "Prompt Composer system prompt fetches should use a bounded MCP config timeout",
);

assert.match(
  source,
  /AbortSignal\.timeout\(PROMPT_COMPOSER_TIMEOUT_MS\)/,
  "Prompt Composer system prompt fetches should use the shared timeout constant",
);

assert.doesNotMatch(
  source,
  /AbortSignal\.timeout\(5_000\)/,
  "Prompt Composer system prompt fetches should not hardcode milliseconds",
);

assert.match(
  source,
  /cachedApplierPrompt = await readPromptComposerSystemPrompt\(res, APPLIER_PROMPT_KEY\)/,
  "applier system prompt should use guarded parsing",
);

assert.doesNotMatch(
  source.slice(source.indexOf("const NUDGE_PROMPT_KEY"), source.indexOf("async function appendCodeToolUseNudge")),
  /await res\.json\(\)/,
  "Prompt Composer system prompt fetches should not call res.json() directly",
);

console.log("mcp invoke prompt response contract tests passed");
