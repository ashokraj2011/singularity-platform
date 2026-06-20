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
  assert.doesNotMatch(runtime, /\/mcp\/invoke/);
  assert.doesNotMatch(runtime, /MCP_UPSTREAM/);

  console.log("agent-service Context Fabric single-turn contract passed");
}

main();
