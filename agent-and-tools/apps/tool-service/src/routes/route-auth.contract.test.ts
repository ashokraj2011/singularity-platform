import assert from "assert";
import fs from "fs";
import path from "path";

function source(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

function assertRouterAuth(relativePath: string, routerName: string): void {
  const file = source(relativePath);
  assert.match(file, /import \{ requireAuth \} from ["']\.\.\/middleware\/auth["'];?/);
  assert.match(file, new RegExp(`${routerName}\\.use\\(requireAuth\\)`));
  assert.doesNotMatch(file, new RegExp(`${routerName}\\.use\\(optionalAuth\\)`));
}

function main() {
  const auth = source("src/middleware/auth.ts");
  assert.match(auth, /async function verifyWithIam\(token: string\): Promise<AuthUser \| null>/);
  assert.match(auth, /process\.env\.IAM_SERVICE_URL \?\? process\.env\.IAM_BASE_URL/);
  assert.match(auth, /fetch\(`\$\{base\}\/me`, \{ headers: \{ Authorization: `Bearer \$\{token\}` \} \}\)/);
  assert.match(auth, /req\.user = await verifyWithIam\(token\) \?\? undefined/);

  assertRouterAuth("src/routes/tools.ts", "toolRoutes");
  assertRouterAuth("src/routes/discovery.ts", "discoveryRoutes");
  assertRouterAuth("src/routes/execution.ts", "executionRoutes");
  assertRouterAuth("src/routes/runners.ts", "runnerRoutes");
  assertRouterAuth("src/routes/internal-tools.ts", "internalToolsRoutes");
  assertRouterAuth("src/routes/connector-tools.ts", "connectorToolsRoutes");

  const events = source("src/lib/eventbus/routes.ts");
  assert.match(events, /eventSubscriptionsRouter\.use\(requireAuth\)/);

  console.log("tool-service route auth contracts passed");
}

main();
