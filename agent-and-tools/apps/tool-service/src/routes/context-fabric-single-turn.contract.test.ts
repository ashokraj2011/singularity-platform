import assert from "assert";
import fs from "fs";
import path from "path";

function source(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

function main() {
  const internalTools = source("src/routes/internal-tools.ts");

  assert.match(internalTools, /CONTEXT_FABRIC_URL/);
  assert.match(internalTools, /CONTEXT_FABRIC_SERVICE_TOKEN/);
  assert.match(internalTools, /\/api\/v1\/execute-governed-single-turn/);
  assert.match(internalTools, /"x-service-token"/);
  assert.match(internalTools, /system_prompt/);
  assert.match(internalTools, /model_overrides/);
  assert.match(internalTools, /source_type: "tool-service-internal"/);
  assert.doesNotMatch(internalTools, /\/mcp\/invoke/);
  assert.doesNotMatch(internalTools, /MCP_UPSTREAM/);

  console.log("tool-service Context Fabric single-turn contract passed");
}

main();
