import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

const row = read("src/lib/row.ts");
const runners = read("src/app/runners/page.tsx");
const runtimeExecutions = read("src/app/runtime-executions/page.tsx");
const agentTemplateDetail = read("src/app/agent-templates/[id]/page.tsx");

assert.match(
  row,
  /export function isRecord\(value: unknown\): value is Row[\s\S]*?!Array\.isArray\(value\)/,
  "shared row helper should distinguish records from arrays and primitives",
);

assert.match(
  row,
  /export function asRowArray\(value: unknown\): Row\[\][\s\S]*?Array\.isArray\(value\) \? value\.filter\(isRecord\) : \[\]/,
  "shared row helper should filter list payloads to object rows only",
);

assert.match(
  row,
  /export function asStringArray\(value: unknown, maxItems = 80, maxLength = 160\): string\[\][\s\S]*?asString\(item\)\.slice\(0, maxLength\)[\s\S]*?\.slice\(0, maxItems\)/,
  "shared row helper should bound string-list rendering values",
);

assert.match(
  row,
  /export function asDateTime\(value: unknown, fallback = "-"\): string[\s\S]*?Number\.isNaN\(date\.getTime\(\)\) \? fallback : date\.toLocaleString\(\);/,
  "shared row helper should avoid rendering invalid dates",
);

for (const [label, source] of [
  ["runners", runners],
  ["runtime executions", runtimeExecutions],
  ["agent template detail", agentTemplateDetail],
] as const) {
  assert.match(source, /@\/lib\/row/, `${label} should use shared row-normalization helpers`);
}

assert.match(
  runners,
  /return \{ runners: asRowArray\(asRow\(parsed\)\.runners\) \};/,
  "runners fetcher should normalize the API envelope before rendering",
);

assert.doesNotMatch(
  runners,
  /caps\.(tools|providers) as string\[\]/,
  "runners page should not cast runner capability lists directly to string arrays",
);

assert.doesNotMatch(
  runtimeExecutions,
  /\(execs \?\? \[\]\) as Record<string, unknown>\[\]/,
  "runtime executions page should not cast execution payloads directly to row arrays",
);

assert.doesNotMatch(
  agentTemplateDetail,
  /t\.skills as Array<Record<string, unknown>>/,
  "agent template detail should not cast skills directly to row arrays",
);

console.log("row normalization contract tests passed");
