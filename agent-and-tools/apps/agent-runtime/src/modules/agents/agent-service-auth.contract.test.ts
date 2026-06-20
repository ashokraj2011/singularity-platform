import assert from "assert";
import fs from "fs";
import path from "path";

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

function main() {
  const service = readRepoFile("src/modules/agents/agent.service.ts");
  assert.match(service, /import \{ getIamServiceAuthHeader \} from "\.\.\/\.\.\/lib\/iam\/service-token"/);
  assert.match(service, /const authHeader = await getIamServiceAuthHeader\(\);/);
  assert.match(service, /\.\.\.\(authHeader \? \{ authorization: authHeader \} : \{\}\)/);
  assert.doesNotMatch(
    service,
    /fetch\(`\$\{composerUrl\}\/api\/v1\/contracts`, \{\s*method: "POST",\s*headers: \{ "content-type": "application\/json" \}/s,
  );

  const capabilityReference = readRepoFile("src/modules/capabilities/iam-capability-reference.ts");
  assert.match(capabilityReference, /import \{ getIamServiceAuthHeader \} from "\.\.\/\.\.\/lib\/iam\/service-token"/);
  assert.doesNotMatch(capabilityReference, /jwt\.sign\(/);
  assert.doesNotMatch(capabilityReference, /serviceAuthHeader\(/);

  const envConfig = readRepoFile("src/config/env.ts");
  assert.match(envConfig, /IAM_SERVICE_TOKEN: z\.string\(\)\.optional\(\)/);
  assert.match(envConfig, /IAM_BOOTSTRAP_USERNAME\/IAM_BOOTSTRAP_PASSWORD/);

  console.log("agent-runtime service-to-service auth contract tests passed");
}

main();
