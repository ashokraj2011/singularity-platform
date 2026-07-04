import assert from "assert";
import fs from "fs";
import path from "path";

function source(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

function main() {
  const internalTools = source("src/tool/routes/internal-tools.ts");

  assert.match(internalTools, /CONTEXT_FABRIC_URL/);
  assert.match(internalTools, /CONTEXT_FABRIC_SERVICE_TOKEN/);
  assert.match(internalTools, /\/api\/v1\/execute-governed-single-turn/);
  assert.match(internalTools, /"x-service-token"/);
  assert.match(internalTools, /system_prompt/);
  assert.match(internalTools, /model_overrides/);
  assert.match(internalTools, /source_type: "tool-service-internal"/);
  assert.match(internalTools, /timeoutSec: CONTEXT_FABRIC_SINGLE_TURN_CONFIG\.timeoutSec/);
  assert.match(internalTools, /AbortSignal\.timeout\(CONTEXT_FABRIC_SINGLE_TURN_CONFIG\.timeoutMs\)/);
  assert.doesNotMatch(internalTools, /\/mcp\/invoke/);
  assert.doesNotMatch(internalTools, /MCP_UPSTREAM/);
  assert.doesNotMatch(internalTools, /timeoutSec:\s*70/);
  assert.doesNotMatch(internalTools, /AbortSignal\.timeout\(70_000\)/);

  console.log("tool-service Context Fabric single-turn contract passed");
}

main();
