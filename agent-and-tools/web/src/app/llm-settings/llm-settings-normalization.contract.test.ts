import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

const source = read("src/app/llm-settings/page.tsx");

assert.match(
  source,
  /import \{ asBoolean, asRow, asRowArray, asString, asStringArray \} from "@\/lib\/row";/,
  "LLM settings page should use shared row-normalization helpers",
);

assert.match(
  source,
  /function normalizeLlmSettings\(value: unknown\): LlmSettings[\s\S]*?const row = asRow\(value\);[\s\S]*?configuredPaths: \{[\s\S]*?providerConfigPath:[\s\S]*?modelCatalogPath:/,
  "LLM settings response should be normalized into a complete settings envelope",
);

assert.match(
  source,
  /const \{ raw, parsed \} = await readResponseBody\(res\);[\s\S]*?setSettings\(normalizeLlmSettings\(parsed\)\);/,
  "LLM settings load should normalize parsed API data before setting state",
);

assert.match(
  source,
  /function normalizeGatewayResult\(value: unknown\): GatewayResult[\s\S]*?ok: asBoolean\(row\.ok\)[\s\S]*?status: normalizeOptionalNumber\(row\.status\) \?\? undefined/,
  "gateway result envelopes should normalize status and boolean fields",
);

assert.match(
  source,
  /function normalizeProviderRow\(value: unknown\): ProviderRow \| null[\s\S]*?const name = asString\(row\.name \?\? row\.provider\);[\s\S]*?warnings: asStringArray\(row\.warnings, 20, 240\)/,
  "provider rows should normalize names and bounded warnings",
);

assert.match(
  source,
  /function normalizeModelRow\(value: unknown\): ModelRow \| null[\s\S]*?const id = asString\(row\.id \?\? row\.alias\);[\s\S]*?supportsTools: asBoolean\(row\.supportsTools \?\? row\.supports_tools\)/,
  "model rows should normalize aliases, provider model IDs, and tool flags",
);

assert.match(
  source,
  /function normalizeRuntimeRows\(value: unknown\): RuntimeRow\[\][\s\S]*?supported_frame_types: asStringArray\(runtime\.supported_frame_types \?\? runtime\.supportedFrameTypes, 20, 80\)[\s\S]*?last_seen_at: normalizeOptionalNumber\(runtime\.last_seen_at \?\? runtime\.lastSeenAt\)/,
  "runtime bridge rows should normalize frames, owner metadata, health, and heartbeat time",
);

assert.match(
  source,
  /const connectedRuntimes = normalizeRuntimeRows\(runtimeBridgeEnvelope\.connected\);/,
  "runtime bridge connected rows should be normalized before rendering the runtime table",
);

assert.match(
  source,
  /function formatTimestamp\(value: unknown\): string[\s\S]*?const timestamp = normalizeOptionalNumber\(value\);/,
  "runtime heartbeat timestamps should tolerate numeric strings",
);

assert.doesNotMatch(
  source,
  /parsed as LlmSettings|as RuntimeRow|as ProviderRow|as ModelRow|as Record<string, unknown>\[\]|Array\.isArray\(runtimeBridgeEnvelope\.connected\)/,
  "LLM settings page should not cast nested settings, runtime, provider, or model payloads directly to trusted client types",
);

console.log("llm settings normalization contract tests passed");
