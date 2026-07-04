import assert from "assert";
import fs from "fs";

import {
  readUpstreamJsonObject,
  responseSnippet,
  UpstreamJsonError,
} from "./upstream-json";

async function main() {
  const parsed = await readUpstreamJsonObject(
    new Response(JSON.stringify({ ok: true }), { status: 200 }),
    "test upstream",
  );
  assert.equal(parsed.ok, true);

  await assert.rejects(
    () => readUpstreamJsonObject(new Response("Internal Server Error", { status: 200 }), "plain upstream"),
    (err) => err instanceof UpstreamJsonError
      && err.upstream === "plain upstream"
      && err.status === 200
      && /invalid JSON/.test(err.message)
      && err.snippet === "Internal Server Error",
  );

  await assert.rejects(
    () => readUpstreamJsonObject(new Response("[1,2,3]", { status: 200 }), "array upstream"),
    (err) => err instanceof UpstreamJsonError
      && /invalid JSON object/.test(err.message),
  );

  assert.equal(responseSnippet(" one\n\n two\t three ", 20), "one two three");

  for (const file of [
    "src/lib/iam/service-token.ts",
    "src/middleware/auth.middleware.ts",
    "src/modules/capabilities/iam-capability-reference.ts",
    "src/modules/capabilities/capability.service.ts",
    "src/modules/capabilities/bootstrap-phase3-distill.ts",
  ]) {
    const source = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(source, /\.json\(\)/, `${file} should parse upstream responses through shared/upstream-json`);
  }

  const agentService = fs.readFileSync("src/modules/agents/agent.service.ts", "utf8");
  assert.doesNotMatch(
    agentService,
    /\.json\(\)|JSON\.parse/,
    "agent.service.ts should parse provider manifests and prompt-composer responses through shared/upstream-json",
  );

  console.log("agent-runtime upstream JSON contract tests passed");
}

void main();
