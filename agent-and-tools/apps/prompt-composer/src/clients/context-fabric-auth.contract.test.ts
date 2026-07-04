import assert from "assert";
import fs from "fs";
import path from "path";

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

function main() {
  const client = readRepoFile("src/clients/context-fabric.client.ts");
  assert.match(client, /serviceHeaders\(baseHeaders: Record<string, string> = \{\}\)/);
  assert.match(client, /config: contextFabricClientConfig\(\)/);
  assert.match(client, /env\.CONTEXT_FABRIC_SERVICE_TOKEN/);
  assert.match(client, /"X-Service-Token": env\.CONTEXT_FABRIC_SERVICE_TOKEN/);
  assert.match(client, /headers: contextFabricClient\.serviceHeaders\(\{ "Content-Type": "application\/json" \}\)/);
  assert.match(client, /AbortSignal\.timeout\(contextFabricClient\.config\.timeoutMs\)/);
  assert.doesNotMatch(client, /headers: \{ "Content-Type": "application\/json" \}/);
  assert.doesNotMatch(client, /AbortSignal\.timeout\(240_000\)/);

  const clientConfig = readRepoFile("src/clients/context-fabric.config.ts");
  assert.match(clientConfig, /boundedIntEnv\("CONTEXT_FABRIC_CLIENT_TIMEOUT_SEC", 240, 1, 900\)/);
  assert.match(clientConfig, /timeoutMs: timeoutSec \* 1000/);

  const envConfig = readRepoFile("src/config/env.ts");
  assert.match(envConfig, /CONTEXT_FABRIC_SERVICE_TOKEN: z\.string\(\)\.optional\(\)/);
  assert.match(envConfig, /set CONTEXT_FABRIC_SERVICE_TOKEN so prompt-composer can call Context Fabric execution endpoints/);
  assert.match(envConfig, /CONTEXT_FABRIC_GOVERNED_TURN:[\s\S]*\.default\(true\)/);
  assert.doesNotMatch(envConfig, /Off by\s+default/);

  assert.match(client, /const path = governed \? "\/api\/v1\/execute-governed-single-turn" : "\/execute"/);

  console.log("prompt-composer Context Fabric service auth contract tests passed");
}

main();
