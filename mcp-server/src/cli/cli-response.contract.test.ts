import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const cliSource = fs.readFileSync(path.join(process.cwd(), "src/cli/index.ts"), "utf8");

assert.match(
  cliSource,
  /import \{ isJsonObject, readUpstreamJsonBody, upstreamSnippet \} from "\.\.\/lib\/upstream-json";/,
  "CLI should use the shared upstream JSON parser for IAM responses",
);

assert.match(
  cliSource,
  /async function readCliJsonObject\(res: Response, source: string\): Promise<Record<string, unknown>> \{[\s\S]*?readUpstreamJsonBody\(res\)[\s\S]*?returned invalid JSON[\s\S]*?response JSON was not an object/,
  "CLI should reject malformed/non-object IAM success bodies with actionable errors",
);

assert.match(
  cliSource,
  /function boundedPositiveIntEnv\(name: string, defaultValue: number, maxValue: number\): number/,
  "CLI should parse bounded positive integer environment overrides for HTTP calls",
);

assert.match(
  cliSource,
  /const CLI_HTTP_TIMEOUT_MS = boundedPositiveIntEnv\("SINGULARITY_MCP_CLI_HTTP_TIMEOUT_MS", 10_000, 300_000\);/,
  "CLI login should expose a capped HTTP timeout knob",
);

assert.match(
  cliSource,
  /\/auth\/local\/login[\s\S]*?signal: AbortSignal\.timeout\(CLI_HTTP_TIMEOUT_MS\)/,
  "CLI local login call should use the bounded HTTP timeout",
);

assert.match(
  cliSource,
  /\/auth\/device-token[\s\S]*?signal: AbortSignal\.timeout\(CLI_HTTP_TIMEOUT_MS\)/,
  "CLI device-token call should use the bounded HTTP timeout",
);

assert.match(
  cliSource,
  /requiredStringField\(loginBody, "access_token", "\/auth\/local\/login"\)/,
  "CLI login should require an access_token before calling device-token mint",
);

assert.match(
  cliSource,
  /requiredStringField\(dt, "access_token", "\/auth\/device-token"\)[\s\S]*?requiredStringField\(dt, "user_id", "\/auth\/device-token"\)/,
  "CLI device-token flow should require token and user identity before saving",
);

assert.doesNotMatch(
  cliSource,
  /await\s+(?:loginRes|deviceRes)\.json\(\)/,
  "CLI login/device-token flow should not call response.json() directly",
);

console.log("mcp CLI response parsing contract passed");
