import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

const shell = read("src/components/AppShell.tsx");
const login = read("src/components/identity/IdentityLoginPage.tsx");
const oidc = read("src/components/identity/IdentityOidcCallbackPage.tsx");
const launchpad = read("src/app/page.tsx");
const resourceList = read("src/components/ResourceListPage.tsx");
const workgraph = read("src/lib/workgraph.ts");
const api = read("src/lib/api.ts");

for (const [label, source] of [
  ["app shell", shell],
  ["identity login", login],
  ["oidc callback", oidc],
  ["launchpad", launchpad],
  ["resource list", resourceList],
  ["workgraph fetch helper", workgraph],
] as const) {
  assert.match(source, /readResponseBody/, `${label} should use the shared safe response reader`);
  assert.doesNotMatch(source, /response\.json\(\)|res\.json\(\)/, `${label} should not call response.json() directly`);
}

assert.doesNotMatch(
  launchpad,
  /text \? JSON\.parse\(text\)/,
  "launchpad counters should not directly parse backend JSON",
);

assert.doesNotMatch(
  resourceList,
  /text \? JSON\.parse\(text\)/,
  "generic resource lists should not directly parse backend JSON",
);

assert.doesNotMatch(
  workgraph,
  /text \? JSON\.parse\(text\)|await res\.text\(\)/,
  "workgraph helper should not hand-parse upstream JSON/text responses",
);

assert.match(
  workgraph,
  /throw new WorkgraphError\(responseMessage\(parsed, raw, res\.statusText\), res\.status, code\)/,
  "workgraph helper should preserve normalized non-JSON upstream error messages",
);

assert.match(
  api,
  /export async function readResponseBody\(res: Response\): Promise<\{ raw: string; parsed: unknown; parseError\?: string \}>/,
  "shared API response reader should expose parseError for malformed successful API bodies",
);

assert.match(
  api,
  /if \(parseError\) \{[\s\S]*?"INVALID_API_RESPONSE"[\s\S]*?\{ parseError, body: raw\.slice\(0, 500\) \}/,
  "shared API helpers should reject successful malformed JSON responses with a structured ApiError",
);

assert.match(
  login,
  /function isLoginResponse\(value: unknown\): value is LoginResponse[\s\S]*?normalizeLoginResponse\(value\) !== null/,
  "local login should validate IAM session response shape with the shared session parser before saving it",
);

assert.match(
  login,
  /function isLoginUrlResponse\(value: unknown\): value is LoginUrlResponse[\s\S]*?authorization_url[\s\S]*?state[\s\S]*?nonce/,
  "SSO start should validate the OIDC login URL response before redirecting",
);

assert.match(
  oidc,
  /function isLoginResponse\(value: unknown\): value is LoginResponse[\s\S]*?normalizeLoginResponse\(value\) !== null/,
  "OIDC callback should validate IAM session response shape with the shared session parser before saving it",
);

console.log("client safe response contract tests passed");
