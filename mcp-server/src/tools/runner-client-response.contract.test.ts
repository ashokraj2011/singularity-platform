import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const source = readFileSync(path.resolve(process.cwd(), "src/tools/runner-client.ts"), "utf8");

assert.match(
  source,
  /async function readRunnerEnvelope\(response: Response, source: string\): Promise<\{ success\?: boolean; data\?: unknown; error\?: unknown \}>/,
  "runner client should centralize sandbox runner JSON parsing",
);

assert.match(
  source,
  /MCP_RUNNER_UNAVAILABLE: \$\{source\} returned invalid JSON/,
  "runner client should return a clear MCP_RUNNER_UNAVAILABLE error for malformed runner bodies",
);

assert.match(
  source,
  /const body = await readRunnerEnvelope\(response, "runner execute"\)/,
  "runner execute should use the guarded parser",
);

assert.match(
  source,
  /const body = await readRunnerEnvelope\(response, "runner health"\)/,
  "runner health should use the guarded parser",
);

assert.doesNotMatch(
  source,
  /response\.json\(\)|await response\.json\(\)/,
  "runner client should not call response.json() directly",
);

console.log("mcp runner client response contract tests passed");
