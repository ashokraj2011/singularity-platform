import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

const legacy = read("src/components/workflows/LegacyWorkgraphAdminRoute.tsx");
const runs = read("src/components/workflows/RunSurfaceRoute.tsx");
const boundary = read("src/components/workflows/WorkgraphSurfaceBoundary.tsx");
const diagnostics = read("src/components/workflows/workgraph-diagnostics.ts");

type DiagnosticsModule = typeof import("./workgraph-diagnostics");
const { sanitizeWorkgraphSurfaceText } = require("./workgraph-diagnostics") as DiagnosticsModule;

assert.match(
  boundary,
  /export class WorkgraphSurfaceBoundary extends Component/,
  "Workgraph surfaces should have a shared client error boundary",
);

assert.match(
  legacy,
  /<WorkgraphSurfaceBoundary surfaceLabel="Workgraph surface">[\s\S]*?<Suspense[\s\S]*?\{children\}[\s\S]*?<\/Suspense>[\s\S]*?<\/WorkgraphSurfaceBoundary>/,
  "WgProvider should wrap every embedded Workgraph page with the error boundary",
);

assert.match(
  runs,
  /<WorkgraphSurfaceBoundary surfaceLabel="Run cockpit">[\s\S]*?<Page \/>[\s\S]*?<\/WorkgraphSurfaceBoundary>/,
  "run cockpit surfaces should be protected by the same Workgraph boundary",
);

assert.match(
  boundary,
  /\{label\} unavailable[\s\S]*?Retry surface[\s\S]*?\/operations\/readiness[\s\S]*?Technical details/,
  "Workgraph boundary should render operator-readable recovery actions and technical details",
);

assert.match(
  boundary,
  /componentDidCatch\(error: Error, info: ErrorInfo\)[\s\S]*?sanitizeWorkgraphSurfaceText\(error\.message\)[\s\S]*?console\.warn\("\[WorkgraphSurfaceBoundary\] Workgraph surface failed:", message, details\)/,
  "Workgraph boundary should log sanitized client exception details for diagnosis",
);

assert.match(
  boundary,
  /import \{ sanitizeWorkgraphSurfaceText \} from "\.\/workgraph-diagnostics";/,
  "Workgraph boundary should import shared diagnostic redaction",
);

assert.match(
  diagnostics,
  /export function sanitizeWorkgraphSurfaceText\(value: unknown\): string \{[\s\S]*?Bearer \[redacted\][\s\S]*?redacted-github-token[\s\S]*?redacted-jwt[\s\S]*?access_token[\s\S]*?password/,
  "Workgraph boundary should provide shared diagnostic redaction for tokens and secrets",
);

const dirty = [
  "Bearer eyJhbGciOiJIUzI1NiJ9.abcdefghijklmno.pqrstuvwxyz12345",
  "github_pat_11AABBCC_secretValue",
  "https://x.test/path?access_token=abc123&ok=true",
  "{\"password\":\"Admin1234!\",\"api_key\":\"sk-test\"}",
].join("\n");
const clean = sanitizeWorkgraphSurfaceText(dirty);
assert.match(clean, /Bearer \[redacted\]/);
assert.match(clean, /\[redacted-github-token\]/);
assert.match(clean, /access_token=\[redacted\]/);
assert.match(clean, /"password":"\[redacted\]"/);
assert.match(clean, /"api_key":"\[redacted\]"/);
assert.doesNotMatch(clean, /Admin1234|github_pat_11AABBCC|abc123|sk-test|eyJhbGciOiJIUzI1NiJ9/);

console.log("legacy Workgraph boundary contract passed");
