import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const proxy = fs.readFileSync(path.join(process.cwd(), "src/app/api/_proxy.ts"), "utf8");
const iamRoute = fs.readFileSync(path.join(process.cwd(), "src/app/api/iam/[...path]/route.ts"), "utf8");
const composerRoute = fs.readFileSync(path.join(process.cwd(), "src/app/api/composer/[...path]/route.ts"), "utf8");

assert.match(
  proxy,
  /const normalizeErrors = options\.normalizeTextErrors \?\? true/,
  "proxyRequest should normalize upstream error bodies by default",
);

assert.match(
  proxy,
  /if \(normalizeErrors && !res\.ok\) \{[\s\S]*?const text = await res\.text\(\)/,
  "proxyRequest should read and normalize failed upstream responses before returning them to clients",
);

assert.match(
  proxy,
  /contentType\.includes\("json"\)[\s\S]*?JSON\.parse\(text\)[\s\S]*?return new NextResponse\(text/,
  "proxyRequest should preserve valid JSON error bodies from upstream services",
);

assert.match(
  proxy,
  /NextResponse\.json\([\s\S]*?code: "UPSTREAM_ERROR"[\s\S]*?status: res\.status[\s\S]*?statusText: res\.statusText[\s\S]*?upstream: upstreamUrl/,
  "proxyRequest should convert plaintext or invalid JSON upstream errors into a JSON envelope",
);

assert.match(
  proxy,
  /import \{ jsonishMessage, readJsonish \} from "\.\/_json";/,
  "shared proxy auth should use the central jsonish helpers for IAM responses",
);

assert.match(
  proxy,
  /const verifyBody = await readJsonish\(verify\);[\s\S]*?IAM verify returned an invalid response[\s\S]*?jsonishMessage\(body, "IAM rejected token"\)/,
  "shared proxy auth should handle plaintext or malformed IAM verify responses without direct response.json parsing",
);

assert.match(
  proxy,
  /const meBody = await readJsonish\(me\);[\s\S]*?jsonishMessage\(meBody\.data, `IAM \/me returned \$\{me\.status\}`\)[\s\S]*?IAM \/me returned an invalid response/,
  "shared proxy auth should normalize IAM /me errors and malformed bodies",
);

assert.doesNotMatch(
  proxy,
  /\.json\(\)\.catch/,
  "shared proxy auth should not call response.json().catch directly",
);

assert.match(
  iamRoute,
  /return proxyRequest\(req, upstream, proxyHeaders\(req, IAM_BASE_URL\)\)/,
  "routes that do not explicitly opt in should still receive default error normalization",
);

assert.match(
  composerRoute,
  /import \{ readJsonish \} from "\.\.\/\.\.\/_json";/,
  "composer proxy should use the shared jsonish helper for upstream responses",
);

assert.match(
  composerRoute,
  /if \(!res\.ok\) \{[\s\S]*?const body = await readJsonish\(res\);[\s\S]*?if \(!body\.parseError\) \{[\s\S]*?return new NextResponse\(body\.raw/,
  "composer proxy should preserve valid JSON upstream errors through readJsonish",
);

assert.match(
  composerRoute,
  /code: "COMPOSER_UPSTREAM_ERROR"[\s\S]*?detail: body\.text \|\| res\.statusText[\s\S]*?upstream: upstream\.toString\(\)/,
  "composer proxy should wrap plaintext or invalid-JSON upstream errors in a stable JSON envelope",
);

assert.match(
  composerRoute,
  /if \(request\.method !== "HEAD"\) \{[\s\S]*?const body = await readJsonish\(res\);[\s\S]*?code: "COMPOSER_INVALID_RESPONSE"/,
  "composer proxy should reject successful malformed JSON responses with a stable JSON envelope",
);

assert.doesNotMatch(
  composerRoute,
  /JSON\.parse\(text\)|await res\.text\(\)/,
  "composer proxy should not hand-parse upstream response text",
);

console.log("proxy error normalization contract tests passed");
