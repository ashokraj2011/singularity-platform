import assert from "assert";
import fs from "fs";

import {
  parseUpstreamJson,
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

  assert.deepEqual(parseUpstreamJson("[1,2,3]", "array upstream"), [1, 2, 3]);
  assert.equal(responseSnippet(" one\n\n two\t three ", 20), "one two three");

  for (const file of [
    "src/middleware/auth.ts",
    "src/tool/middleware/auth.ts",
    "src/tool/routes/connector-tools.ts",
    "src/tool/routes/execution.ts",
    "src/tool/routes/internal-tools.ts",
    "src/routes/runtime.ts",
  ]) {
    const source = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(source, /await\s+(?:res|response)\.json\(\)/, `${file} should parse upstream responses through shared/upstream-json`);
  }

  console.log("agent-service upstream JSON contract tests passed");
}

void main();
