import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  isJsonObject,
  readUpstreamJsonBody,
  readUpstreamJsonObjectOrNull,
  upstreamSnippet,
} from "./upstream-json";

function source(file: string): string {
  return readFileSync(path.resolve(process.cwd(), file), "utf8");
}

async function main(): Promise<void> {
  assert.deepEqual(
    await readUpstreamJsonBody(new Response('{"ok":true}', { status: 200 })),
    { raw: '{"ok":true}', data: { ok: true } },
  );

  const malformed = await readUpstreamJsonBody(new Response("Internal Server Error", { status: 200 }));
  assert.equal(malformed.raw, "Internal Server Error");
  assert.equal(malformed.data, "Internal Server Error");
  assert.equal(typeof malformed.parseError, "string");

  assert.deepEqual(await readUpstreamJsonBody(new Response("", { status: 200 })), { raw: "", data: null });
  assert.equal((await readUpstreamJsonObjectOrNull(new Response("[1,2,3]", { status: 200 }))).data, null);
  assert.equal(isJsonObject({ ok: true }), true);
  assert.equal(isJsonObject([1, 2, 3]), false);
  assert.equal(upstreamSnippet(" one\n\n two\t three ", 20), "one two three");

  for (const file of [
    "src/lib/audit-gov-check.ts",
    "src/lib/audit-gov-approvals.ts",
    "src/llm/client.ts",
    "src/tools/runner-client.ts",
    "src/tools/learning.ts",
    "src/mcp/source-discover.ts",
    "src/mcp/repo-fingerprint.ts",
  ]) {
    const text = source(file);
    assert.match(text, /readUpstreamJsonBody/, `${file} should use readUpstreamJsonBody`);
    assert.doesNotMatch(text, /JSON\.parse\(raw\)|JSON\.parse\(text\)|await\s+\w+\.json\(\)/, `${file} should not parse upstream response text inline`);
  }
}

void main()
  .then(() => {
    console.log("mcp shared upstream JSON contract tests passed");
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
