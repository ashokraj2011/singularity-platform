import assert from "assert";
import fs from "fs";
import path from "path";

function source(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

function assertRouterAuth(relativePath: string, routerName: string): void {
  const file = source(relativePath);
  assert.match(file, /import \{ requireAuth \} from ["']\.\.\/\.\.\/middleware\/auth\.middleware["'];?/);
  assert.match(file, new RegExp(`${routerName}\\.use\\(requireAuth\\)`));
}

function main() {
  const auth = source("src/middleware/auth.middleware.ts");
  const env = source("src/config/env.ts");
  assert.match(auth, /async function verifyWithIam\(token: string\): Promise<AuthUser \| null>/);
  assert.match(auth, /process\.env\.IAM_SERVICE_URL \?\? process\.env\.IAM_BASE_URL/);
  assert.match(env, /IAM_AUTH_VERIFY_TIMEOUT_SEC: boundedInt\(5, 1, 300\)/);
  assert.match(auth, /const IAM_AUTH_VERIFY_TIMEOUT_MS = env\.IAM_AUTH_VERIFY_TIMEOUT_SEC \* 1000;/);
  assert.match(auth, /\/me`, \{[\s\S]*?signal: AbortSignal\.timeout\(IAM_AUTH_VERIFY_TIMEOUT_MS\)/);
  assert.doesNotMatch(auth, /fetch\(`\$\{base\}\/me`, \{ headers: \{ Authorization: `Bearer \$\{token\}` \} \}\)/);
  assert.match(auth, /function verifyServiceToken\(token: string\): AuthUser \| null/);
  assert.match(auth, /process\.env\.PROMPT_COMPOSER_SERVICE_TOKEN/);
  assert.match(auth, /env\.CONTEXT_FABRIC_SERVICE_TOKEN/);
  assert.match(auth, /timingSafeEqual/);

  assertRouterAuth("src/modules/compose/compose.routes.ts", "composeRoutes");
  assertRouterAuth("src/modules/compose/compose.routes.ts", "composeDebugRoutes");
  assertRouterAuth("src/modules/compose/compiled-context.routes.ts", "compiledContextRoutes");
  assertRouterAuth("src/modules/prompts/prompt.routes.ts", "promptProfileRoutes");
  assertRouterAuth("src/modules/prompts/prompt.routes.ts", "promptLayerRoutes");
  assertRouterAuth("src/modules/prompts/prompt.routes.ts", "promptAssemblyRoutes");
  assertRouterAuth("src/modules/stage-prompts/stage-prompts.routes.ts", "stagePromptsRoutes");
  assertRouterAuth("src/modules/stage-policies/stage-policies.routes.ts", "stagePoliciesRoutes");
  assertRouterAuth("src/modules/system-prompts/system-prompts.routes.ts", "systemPromptsRoutes");
  assertRouterAuth("src/modules/event-horizon-actions/event-horizon-actions.routes.ts", "eventHorizonActionsRoutes");
  assertRouterAuth("src/modules/lessons/lessons.routes.ts", "lessonsRoutes");
  assertRouterAuth("src/modules/contracts/contracts.routes.ts", "contractsRoutes");

  console.log("prompt-composer route auth contracts passed");
}

main();
