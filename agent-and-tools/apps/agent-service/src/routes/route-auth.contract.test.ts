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

  assertRouterAuth("src/routes/agents.ts", "agentRoutes");
  assertRouterAuth("src/routes/versions.ts", "versionRoutes");
  assertRouterAuth("src/routes/learning.ts", "learningRoutes");
  assertRouterAuth("src/routes/runtime.ts", "runtimeRoutes");

  const learningPatterns = source("src/routes/learning-patterns.ts");
  assert.match(learningPatterns, /learningPatternsRoutes\.use\(requireServiceAuth\)/);
  assert.match(learningPatterns, /res\.status\(503\)\.json\(\{ error: "learning service token not configured" \}\)/);
  assert.doesNotMatch(learningPatterns, /AUTH_OPTIONAL/);
  assert.doesNotMatch(learningPatterns, /!SERVICE_TOKEN &&/);

  const events = source("src/lib/eventbus/routes.ts");
  assert.match(events, /eventSubscriptionsRouter\.use\(requireAuth\)/);

  console.log("agent-service route auth contracts passed");
}

main();
