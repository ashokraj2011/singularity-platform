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
const foundry = read("src/lib/foundry/api.ts");
const git = read("src/lib/git/api.ts");
const identity = read("src/lib/identity/api.ts");
const controlPlane = read("src/components/ControlPlaneConsole.tsx");
const api = read("src/lib/api.ts");

for (const [label, source] of [
  ["app shell", shell],
  ["identity login", login],
  ["oidc callback", oidc],
  ["launchpad", launchpad],
  ["resource list", resourceList],
  ["workgraph fetch helper", workgraph],
  ["foundry fetch helper", foundry],
  ["git broker fetch helper", git],
  ["identity fetch helper", identity],
  ["control plane fetch helper", controlPlane],
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
  /if \(parseError\) \{[\s\S]*?new WorkgraphError\(invalidApiResponseMessage\(url, raw, parseError\), res\.status, "INVALID_API_RESPONSE"\)/,
  "workgraph helper should reject malformed successful API bodies",
);

for (const [label, source] of [
  ["foundry", foundry],
  ["git broker", git],
  ["identity", identity],
] as const) {
  assert.match(
    source,
    /if \(parseError\) \{[\s\S]*?invalidApiResponseMessage\([\s\S]*?"INVALID_API_RESPONSE"/,
    `${label} helper should reject malformed successful API bodies`,
  );
}

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
  /export function invalidApiResponseMessage\(url: string, raw: string, parseError\?: string\): string/,
  "shared API helpers should centralize malformed successful response messages",
);

assert.match(
  api,
  /if \(parseError\) \{[\s\S]*?"INVALID_API_RESPONSE"[\s\S]*?invalidApiResponseDetails\(raw, parseError\)/,
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
