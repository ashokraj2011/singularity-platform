import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const source = readFileSync(path.resolve(process.cwd(), "src/mcp/repo-fingerprint.ts"), "utf8");

assert.match(
  source,
  /async function readAgentRuntimeFingerprintBody\(res: Response\): Promise<Record<string, unknown> \| null>/,
  "repo fingerprint reporting should centralize agent-runtime response parsing",
);

assert.match(
  source,
  /agent-runtime drift endpoint returned invalid JSON/,
  "repo fingerprint reporting should log malformed agent-runtime bodies and fail soft",
);

assert.match(
  source,
  /readUpstreamJsonBody\(res\)[\s\S]*?if \(!body\.raw\.trim\(\)\) return null/,
  "repo fingerprint reporting should use the shared upstream JSON parser",
);

assert.match(
  source,
  /const body = await readAgentRuntimeFingerprintBody\(res\);[\s\S]*?if \(!body\) return null/,
  "repo fingerprint reporting should ignore malformed best-effort responses",
);

assert.match(
  source,
  /const AGENT_RUNTIME_WORLD_MODEL_TIMEOUT_MS = config\.MCP_AGENT_RUNTIME_WORLD_MODEL_TIMEOUT_SEC \* 1000;/,
  "repo fingerprint reporting should use a bounded MCP config timeout",
);

assert.match(
  source,
  /AbortSignal\.timeout\(AGENT_RUNTIME_WORLD_MODEL_TIMEOUT_MS\)/,
  "repo fingerprint reporting should use the shared world-model timeout constant",
);

assert.doesNotMatch(
  source,
  /AbortSignal\.timeout\(5_000\)/,
  "repo fingerprint reporting should not hardcode milliseconds",
);

assert.doesNotMatch(
  source,
  /await res\.json\(\)|JSON\.parse\(text\)|JSON\.parse\(raw\)/,
  "repo fingerprint reporting should not call res.json() directly",
);

console.log("mcp repo fingerprint response contract tests passed");
