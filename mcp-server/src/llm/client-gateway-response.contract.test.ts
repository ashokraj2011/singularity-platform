import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const client = fs.readFileSync(path.join(process.cwd(), "src/llm/client.ts"), "utf8");

assert.match(
  client,
  /async function parseGatewayJson<T>\(res: Response, upstreamStatus: number \| null, path: string\): Promise<T> \{[\s\S]*?readUpstreamJsonBody\(res\)[\s\S]*?LLM_GATEWAY_INVALID_RESPONSE[\s\S]*?returned invalid JSON/,
  "MCP LLM client should classify malformed 2xx gateway JSON as LLM_GATEWAY_INVALID_RESPONSE",
);

assert.match(
  client,
  /function gatewayErrorCodeForStatus\(status: number, text: string\): string \{[\s\S]*?status === 529[\s\S]*?LLM_PROVIDER_OVERLOADED[\s\S]*?status === 503[\s\S]*?LLM_PROVIDER_UNAVAILABLE[\s\S]*?status === 429[\s\S]*?LLM_PROVIDER_RATE_LIMITED[\s\S]*?status === 504[\s\S]*?LLM_GATEWAY_TIMEOUT/,
  "MCP LLM client should preserve operator-actionable gateway/provider status codes",
);

assert.match(
  client,
  /return parseGatewayJson<GatewayChatResponse>\(res, res\.status, "\/v1\/chat\/completions"\);/,
  "chat completions should parse success bodies through the guarded gateway parser",
);

assert.match(
  client,
  /return parseGatewayJson<GatewayEmbeddingsResponse>\(res, res\.status, "\/v1\/embeddings"\);/,
  "embeddings should parse success bodies through the guarded gateway parser",
);

assert.match(
  client,
  /async function callGatewayEmbeddings[\s\S]*?let res: Response;[\s\S]*?\/v1\/embeddings[\s\S]*?LLM_GATEWAY_TIMEOUT[\s\S]*?LLM_GATEWAY_UNREACHABLE/,
  "embeddings should classify timeout and unreachable gateway failures consistently",
);

assert.match(
  client,
  /async function callGatewayEmbeddings[\s\S]*?const code = gatewayErrorCodeForStatus\(res\.status, text\);[\s\S]*?makeGatewayError\(code, `LLM gateway embeddings \$\{res\.status\}:/,
  "embeddings should classify non-2xx gateway failures with the shared status mapping",
);

assert.match(
  client,
  /parseGatewayJson<\{ providers\?: Array<\{ name: string; ready: boolean; warnings: string\[\] \}> \}>\([\s\S]*?res,[\s\S]*?res\.status,[\s\S]*?"\/llm\/providers"/,
  "provider readiness refresh should tolerate malformed provider catalog bodies through the guarded parser",
);

assert.match(
  client,
  /LLM_GATEWAY_INVALID_RESPONSE:\s*502/,
  "invalid gateway JSON should map to a structured 502 AppError",
);

assert.doesNotMatch(
  client,
  /return JSON\.parse\(text\) as GatewayChatResponse|return JSON\.parse\(text\) as GatewayEmbeddingsResponse|await res\.json\(\)|parseGatewayJson<GatewayChatResponse>\(text|parseGatewayJson<GatewayEmbeddingsResponse>\(text/,
  "MCP LLM client should not directly parse gateway success bodies with raw JSON.parse/res.json",
);

console.log("MCP LLM gateway response contract tests passed");
