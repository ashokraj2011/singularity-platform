import assert from "assert";
import fs from "fs";
import path from "path";

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

function assertRouterAuth(relativePath: string, routerName: string): void {
  const source = readRepoFile(relativePath);
  assert.match(source, /import \{ requireAuth \} from ["']\.\.\/\.\.\/middleware\/auth\.middleware["'];?/);
  assert.match(source, new RegExp(`${routerName}\\.use\\(requireAuth\\)`));
}

function main() {
  assertRouterAuth("src/modules/agents/agent.routes.ts", "agentRoutes");
  assertRouterAuth("src/modules/tools/tool.routes.ts", "toolRoutes");
  assertRouterAuth("src/modules/capabilities/capability.routes.ts", "capabilityRoutes");
  assertRouterAuth("src/modules/executions/execution.routes.ts", "executionRoutes");
  assertRouterAuth("src/modules/memory/memory.routes.ts", "memoryRoutes");

  const eventRoutes = readRepoFile("src/lib/eventbus/routes.ts");
  assert.match(eventRoutes, /import \{ requireAuth \} from ["']\.\.\/\.\.\/middleware\/auth\.middleware["'];?/);
  assert.match(eventRoutes, /r\.use\(requireAuth\)/);
  assert.match(eventRoutes, /assertAgentSourceUrlAllowed\(body\.targetUrl\)/);
  assert.match(eventRoutes, /throw new ValidationError\(\(err as Error\)\.message\)/);

  const eventDispatcher = readRepoFile("src/lib/eventbus/dispatcher.ts");
  assert.match(eventDispatcher, /import \{ assertAgentSourceUrlAllowed \} from ["']\.\.\/\.\.\/modules\/agents\/agent-source-url-policy["'];?/);
  assert.match(eventDispatcher, /const safeUrl = await assertAgentSourceUrlAllowed\(targetUrl\)/);
  assert.match(eventDispatcher, /fetch\(safeUrl,/);

  console.log("agent-runtime route auth and event target URL contracts passed");
}

main();
