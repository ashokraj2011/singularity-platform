import assert from "assert";
import fs from "fs";
import path from "path";

function source(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

function main() {
  const runtime = source("src/routes/runtime.ts");

  assert.match(runtime, /CONTEXT_FABRIC_URL/);
  assert.match(runtime, /CONTEXT_FABRIC_SERVICE_TOKEN/);
  assert.match(runtime, /\/api\/v1\/execute-governed-single-turn/);
  assert.match(runtime, /"x-service-token"/);
  assert.match(runtime, /system_prompt/);
  assert.match(runtime, /model_overrides/);
  assert.match(runtime, /source_type: "agent-service-distillation"/);
  assert.match(runtime, /timeoutSec: CONTEXT_FABRIC_SINGLE_TURN_CONFIG\.timeoutSec/);
  assert.match(runtime, /AbortSignal\.timeout\(CONTEXT_FABRIC_SINGLE_TURN_CONFIG\.timeoutMs\)/);
  assert.doesNotMatch(runtime, /\/mcp\/invoke/);
  assert.doesNotMatch(runtime, /MCP_UPSTREAM/);
  assert.doesNotMatch(runtime, /timeoutSec:\s*70/);
  assert.doesNotMatch(runtime, /AbortSignal\.timeout\(70_000\)/);

  console.log("agent-service Context Fabric single-turn contract passed");
}

main();
