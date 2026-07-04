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
  assert.match(auth, /async function verifyWithIam\(token: string\): Promise<AuthUser \| null>/);
  assert.match(auth, /process\.env\.IAM_SERVICE_URL \?\? process\.env\.IAM_BASE_URL/);
  assert.match(auth, /import \{ boundedEnvInteger \} from ["']\.\.\/lib\/env["'];?/);
  assert.match(auth, /const IAM_AUTH_VERIFY_TIMEOUT_MS = boundedEnvInteger\("IAM_AUTH_VERIFY_TIMEOUT_SEC", \{[\s\S]*?defaultValue: 5,[\s\S]*?min: 1,[\s\S]*?max: 300,[\s\S]*?\}\) \* 1000;/);
  assert.match(auth, /\/me`, \{[\s\S]*?signal: AbortSignal\.timeout\(IAM_AUTH_VERIFY_TIMEOUT_MS\)/);
  assert.doesNotMatch(auth, /fetch\(`\$\{base\}\/me`, \{ headers: \{ Authorization: `Bearer \$\{token\}` \} \}\)/);
  assert.match(auth, /req\.user = await verifyWithIam\(token\) \?\? undefined/);

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
