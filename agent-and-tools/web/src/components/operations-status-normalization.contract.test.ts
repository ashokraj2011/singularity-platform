import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

const source = read("src/components/OperationsStatusPage.tsx");

assert.match(
  source,
  /import \{ asBoolean, asRow, asRowArray, asString \} from "@\/lib\/row";/,
  "Operations status page should use shared row-normalization helpers",
);

assert.match(
  source,
  /async function runtimeInfrastructure\(\): Promise<RuntimeInfrastructure>[\s\S]*?return normalizeRuntimeInfrastructure\(parsed\);/,
  "runtime infrastructure response should be normalized before rendering",
);

assert.match(
  source,
  /async function adoptionHealth\(\): Promise<AdoptionHealth>[\s\S]*?return normalizeAdoptionHealth\(parsed\);/,
  "adoption health response should be normalized before rendering",
);

assert.match(
  source,
  /function normalizeRuntimeInfrastructure\(value: unknown\): RuntimeInfrastructure[\s\S]*?const services = asRowArray\(row\.services\)\.map\(normalizeRuntimeService\)[\s\S]*?requiredHealthy,/,
  "runtime infrastructure normalizer should coerce summary and service rows",
);

assert.match(
  source,
  /function normalizeRuntimeService\(value: unknown\): RuntimeService \| null[\s\S]*?const id = asString\(row\.id\);[\s\S]*?const status = normalizeRuntimeStatus\(row\.status\);[\s\S]*?const ok = normalizeOptionalBoolean\(row\.ok\);/,
  "runtime service rows should normalize IDs, status, and boolean health",
);

assert.match(
  source,
  /type RuntimeStrictCheck = \{[\s\S]*?name: string;[\s\S]*?ok: boolean;[\s\S]*?reason\?: string;[\s\S]*?\}/,
  "runtime service strict-health details should have a bounded client-side shape",
);

assert.match(
  source,
  /const strictChecks = normalizeRuntimeStrictChecks\(row\.details\);[\s\S]*?strictFailureSummary,[\s\S]*?function normalizeRuntimeStrictChecks\(value: unknown\): RuntimeStrictCheck\[\][\s\S]*?const details = asRow\(value\);[\s\S]*?const checks: RuntimeStrictCheck\[\] = \[\];[\s\S]*?for \(const check of asRowArray\(details\.checks\)\)[\s\S]*?if \(checks\.length >= 20\) break;[\s\S]*?return checks;/,
  "runtime service normalizer should preserve bounded strict-health check details from the API",
);

assert.match(
  source,
  /function runtimeStrictFailureSummary\(checks: RuntimeStrictCheck\[\]\): string \| undefined[\s\S]*?const failed = checks\.filter\(\(check\) => !check\.ok\);[\s\S]*?return `Failed checks: \$\{parts\.join\("; "\)\}`;/,
  "Operations UI should derive a concise strict-health failure summary",
);

assert.match(
  source,
  /\{service\.strictFailureSummary && \([\s\S]*?text-red-800[\s\S]*?\{service\.strictFailureSummary\}[\s\S]*?\)\}/,
  "runtime rows should render failed strict-health checks when present",
);

assert.match(
  source,
  /message: service\?\.strictFailureSummary \?\? service\?\.message \?\? "Waiting for runtime probe\."/,
  "evidence records should prefer strict-health failure summaries over generic runtime messages",
);

assert.match(
  source,
  /function normalizeAdoptionHealth\(value: unknown\): AdoptionHealth[\s\S]*?score: normalizeNumber\(row\.score, 0, 0, 100\)[\s\S]*?blocked: asRowArray\(row\.blocked\)\.map\(normalizeHealthIssue\)/,
  "adoption health normalizer should bound score and normalize blocker rows",
);

assert.match(
  source,
  /function normalizeHealthIssue\(value: unknown\): NonNullable<AdoptionHealth\["blocked"\]>\[number\] \| null[\s\S]*?fixCommand: asString\(row\.fixCommand \?\? row\.fix_command\) \|\| undefined[\s\S]*?fixRoute: asString\(row\.fixRoute \?\? row\.fix_route\) \|\| undefined/,
  "adoption health issues should normalize fix command and route fields",
);

assert.match(
  source,
  /function parseJsonBody\(value: string \| undefined\): Record<string, unknown> \| null[\s\S]*?const parsed: unknown = JSON\.parse\(value\);[\s\S]*?const row = asRow\(parsed\);/,
  "health payload preview should parse JSON bodies through the row guard",
);

assert.doesNotMatch(
  source,
  /parsed as RuntimeInfrastructure|parsed as AdoptionHealth|return parsed as|as RuntimeInfrastructure|as AdoptionHealth|as RuntimeService|as CheckResult/,
  "Operations status page should not cast runtime or adoption API payloads directly to trusted client types",
);

console.log("operations status normalization contract tests passed");
