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
  const auth = source("src/tool/middleware/auth.ts");
  assert.match(auth, /export \{ optionalAuth, requireAuth \} from ["']\.\.\/\.\.\/middleware\/auth["'];?/);

  const canonicalAuth = source("src/middleware/auth.ts");
  assert.match(canonicalAuth, /async function authenticateToken\(token: string\): Promise<AuthUser \| null>/);
  assert.match(canonicalAuth, /AUTH_PROVIDER.*iam/);
  assert.match(canonicalAuth, /servicePrincipalFromToken\(token\)/);
  assert.match(canonicalAuth, /req\.user = await authenticateToken\(token\) \?\? undefined/);

  assertRouterAuth("src/tool/routes/tools.ts", "toolRoutes");
  assertRouterAuth("src/tool/routes/discovery.ts", "discoveryRoutes");
  assertRouterAuth("src/tool/routes/execution.ts", "executionRoutes");
  assertRouterAuth("src/tool/routes/runners.ts", "runnerRoutes");
  assertRouterAuth("src/tool/routes/internal-tools.ts", "internalToolsRoutes");
  assertRouterAuth("src/tool/routes/connector-tools.ts", "connectorToolsRoutes");

  const events = source("src/tool/lib/eventbus/routes.ts");
  assert.match(events, /eventSubscriptionsRouter\.use\(requireAuth\)/);

  console.log("tool-service route auth contracts passed");
}

main();
