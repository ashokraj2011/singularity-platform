import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

const session = read("src/lib/identity/session.ts");
const api = read("src/lib/api.ts");
const login = read("src/components/identity/IdentityLoginPage.tsx");
const oidc = read("src/components/identity/IdentityOidcCallbackPage.tsx");

assert.match(
  session,
  /export function normalizeLoginUser\(value: unknown\): LoginUser \| null/,
  "identity session restore should normalize persisted users from unknown values",
);

assert.match(
  session,
  /const parsed = JSON\.parse\(raw\) as unknown;[\s\S]*?return normalizeLoginUser\(state\?\.user\);/,
  "getIdentityUser should parse localStorage as unknown and return only normalized users",
);

assert.doesNotMatch(
  session,
  /JSON\.parse\(raw\) as \{ state\?: \{ user\?: LoginUser \} \}/,
  "getIdentityUser must not cast persisted localStorage directly to LoginUser",
);

assert.match(
  session,
  /const session = normalizeLoginResponse\(body\);[\s\S]*?if \(!session\) throw new Error/,
  "saveIdentitySession should reject malformed IAM login responses before persisting",
);

assert.match(
  api,
  /function tokenFromPersistedJson\(value: unknown\): string \| null/,
  "API auth header restore should parse persisted stores through an unknown-value helper",
);

assert.match(
  api,
  /const parsed = JSON\.parse\(raw\) as unknown;[\s\S]*?return tokenFromPersistedJson\(parsed\);/,
  "tokenFromPersistedStore should not trust parsed localStorage shape directly",
);

assert.match(
  api,
  /const normalizedToken = normalizedStoredToken\(token\);[\s\S]*?if \(!normalizedToken\) throw new Error/,
  "saveAgentToolsToken should reject empty or non-string session tokens",
);

assert.match(
  api,
  /localStorage\.setItem\("iam-auth", persisted\);[\s\S]*?localStorage\.setItem\("workgraph-auth", persisted\);/,
  "inline platform login should write the same normalized session shape used by IAM and Workgraph",
);

assert.match(
  login,
  /function isLoginResponse\(value: unknown\): value is LoginResponse \{[\s\S]*?return normalizeLoginResponse\(value\) !== null;/,
  "local login response guard should delegate to the shared normalized IAM session parser",
);

assert.match(
  oidc,
  /function isLoginResponse\(value: unknown\): value is LoginResponse \{[\s\S]*?return normalizeLoginResponse\(value\) !== null;/,
  "OIDC callback response guard should delegate to the shared normalized IAM session parser",
);

console.log("identity session storage contract tests passed");
