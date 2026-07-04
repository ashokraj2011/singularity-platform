import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

const helper = read("src/app/api/_health-message.ts");
const topology = read("src/app/api/platform-topology/route.ts");
const runtime = read("src/app/api/runtime-infrastructure/route.ts");
const adoption = read("src/app/api/adoption/health/route.ts");

assert.match(
  helper,
  /export function healthProbeMessage\(raw: string, statusText: string, ok: boolean, maxText = 260\): string[\s\S]*?JSON\.parse\(text\) as unknown[\s\S]*?catch \{[\s\S]*?return text\.slice\(0, maxText\);/,
  "healthProbeMessage should parse JSON health payloads and safely preserve plaintext health responses",
);

assert.match(
  helper,
  /for \(const key of \["message", "error", "detail", "title", "reason"\]\)[\s\S]*?const connected = Array\.isArray\(record\.connected\) \? record\.connected\.length[\s\S]*?status: \$\{status\}; connected: \$\{connected\}/,
  "healthProbeMessage should prefer human-readable fields and summarize Runtime Bridge status payloads",
);

assert.match(
  helper,
  /function healthCheckMessage\(record: Record<string, unknown>, maxText: number\): string \| null[\s\S]*?const data = asRecord\(record\.data\) \?\? record[\s\S]*?const checks = Array\.isArray\(data\.checks\)[\s\S]*?failed checks: \$\{parts\.join\("; "\)\}/,
  "healthProbeMessage should unwrap strict health envelopes and summarize failing check names instead of returning success:false",
);

assert.match(
  topology,
  /import \{ healthProbeMessage \} from "\.\.\/_health-message";[\s\S]*?message: healthProbeMessage\(text, res\.statusText, res\.ok, 260\)/,
  "platform topology probes should normalize JSON health payloads before returning them to the UI",
);

assert.match(
  topology,
  /id: "agent-runtime"[\s\S]*?label: "Agent Runtime"[\s\S]*?strict schema invariants[\s\S]*?envKey: platformService\("agent-runtime"\)\.envKey[\s\S]*?healthPath: "\/healthz\/strict"[\s\S]*?required: true/,
  "platform topology should render Agent Runtime from strict health, not shallow liveness",
);

assert.match(
  runtime,
  /import \{ healthProbeMessage \} from "\.\.\/_health-message";[\s\S]*?const body = await readJsonish\(res, 1200\);[\s\S]*?message: healthProbeMessage\(body\.raw, res\.statusText, res\.ok, 220\)/,
  "runtime infrastructure probes should normalize JSON health payloads before returning them to the UI",
);

assert.match(
  runtime,
  /function strictHealthDetails\(value: unknown\): Record<string, unknown> \| undefined[\s\S]*?const root = record\(value\)[\s\S]*?const data = record\(root\?\.data\) \?\? root[\s\S]*?failingChecks: normalizedChecks\.filter\(\(check\) => !check\.ok\)\.map\(\(check\) => check\.name\)[\s\S]*?details: config\.id === "agent-runtime-strict" \? strictHealthDetails\(body\.data\) : undefined/,
  "runtime infrastructure should preserve structured strict-health check details for readiness/adoption diagnostics",
);

assert.match(
  runtime,
  /import \{ readJsonish \} from "\.\.\/_json";[\s\S]*?const body = await readJsonish\(res, 1200\);/,
  "runtime infrastructure should use jsonish parsing for JSON/plaintext health responses",
);

assert.match(
  runtime,
  /id: "agent-runtime-strict"[\s\S]*?label: "Agent Runtime Strict Health"[\s\S]*?envKey: platformService\("agent-runtime"\)\.envKey[\s\S]*?healthPath: "\/healthz\/strict"[\s\S]*?required: true/,
  "runtime infrastructure should include Agent Runtime strict health as a required service",
);

assert.match(
  adoption,
  /const agentRuntimeStrict = runtimeServices\.find\(\(service\) => service\.id === "agent-runtime-strict"\);[\s\S]*?"agent-runtime-strict"[\s\S]*?"Agent Runtime Strict Health"[\s\S]*?agentRuntimeStrict\?\.ok === true \? "ready" : "blocked"/,
  "adoption health should block on Agent Runtime strict health rather than only shallow liveness",
);

assert.match(
  adoption,
  /const strictHealthFixCommand = archivedCapabilityLifecycleDrift[\s\S]*?DATABASE_URL=\$DATABASE_URL_AGENT_TOOLS npx prisma db push --skip-generate[\s\S]*?Agent Runtime strict health failed/,
  "adoption health should give an actionable Prisma fix when Agent Runtime strict health fails",
);

assert.match(
  adoption,
  /hasStrictHealthFailure\(agentRuntimeStrict, "archived_capability_lifecycle"\)[\s\S]*?DATABASE_URL=\$DATABASE_URL_AGENT_TOOLS npx prisma migrate deploy/,
  "adoption health should recommend migrate deploy when archived capability lifecycle reconciliation is missing",
);

assert.doesNotMatch(
  topology,
  /message: text\.slice\(0, 260\) \|\| res\.statusText/,
  "platform topology should not expose raw JSON blobs as probe messages",
);

assert.doesNotMatch(
  runtime,
  /message: text\.slice\(0, 220\) \|\| res\.statusText/,
  "runtime infrastructure should not expose raw JSON blobs as probe messages",
);

console.log("health probe message contract tests passed");
