import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

const page = read("src/app/capabilities/[id]/page.tsx");

assert.match(
  page,
  /const capEnvelope = asObject\(cap\);[\s\S]*?const latestBootstrapRunId = capabilityString\(asObjectArray\(capEnvelope\.bootstrapRuns\)\[0\]\?\.id\);/,
  "capability detail should derive latest bootstrap run from a normalized bootstrapRuns array",
);

assert.match(
  page,
  /const repos = asObjectArray\(c\.repositories\);[\s\S]*?const bindings = asObjectArray\(c\.bindings\);[\s\S]*?const know_artifacts = asObjectArray\(c\.knowledgeArtifacts\);/,
  "capability detail should normalize top-level repository, binding, and knowledge artifact arrays before rendering",
);

assert.match(
  page,
  /const tmplOptions = asObjectArray\(asObject\(templates\)\.items\);/,
  "capability detail should normalize template option envelopes before using them",
);

assert.match(
  page,
  /const candidates = asObjectArray\(run\.candidates\);[\s\S]*?const runWarnings = asStringArray\(run\.warnings\);[\s\S]*?const runErrors = asStringArray\(run\.errors\);/,
  "bootstrap review should normalize candidate, warning, and error arrays",
);

assert.match(
  page,
  /const repositories = asObjectArray\(runCapability\.repositories\)\.length[\s\S]*?asObjectArray\(capability\.repositories\);[\s\S]*?const knowledgeSources = asObjectArray\(runCapability\.knowledgeSources\);/,
  "bootstrap approved-source sync should normalize run/capability repository and knowledge source arrays",
);

assert.match(
  page,
  /const repositoryIds = repositories[\s\S]*?\.map\(repo => capabilityString\(repo\.id\)\)[\s\S]*?\.filter\(Boolean\);[\s\S]*?const knowledgeSourceIds = knowledgeSources[\s\S]*?\.map\(source => capabilityString\(source\.id\)\)[\s\S]*?\.filter\(Boolean\);/,
  "approved-source sync should only submit normalized non-empty repository and knowledge source IDs",
);

assert.match(
  page,
  /<h1 className="text-xl font-bold text-slate-900">\{capabilityString\(c\.name\) \|\| "Untitled capability"\}<\/h1>[\s\S]*?<StatusBadge value=\{capabilityString\(c\.status\) \|\| "unknown"\} \/>/,
  "capability header should render normalized strings instead of raw API fields",
);

assert.match(
  page,
  /const template = asObject\(binding\.agentTemplate\);[\s\S]*?const bindingName = capabilityString\(binding\.bindingName\) \|\| `Binding \$\{index \+ 1\}`;[\s\S]*?const templateId = capabilityString\(template\.id\) \|\| capabilityString\(binding\.agentTemplateId\);/,
  "binding cards should normalize nested template rows and binding labels before rendering",
);

assert.match(
  page,
  /function asObject\(value: unknown\): Record<string, unknown>[\s\S]*?!Array\.isArray\(value\)/,
  "capability detail should provide a guarded object helper",
);

assert.match(
  page,
  /function asStringArray\(value: unknown, maxItems = 80, maxLength = 160\): string\[\][\s\S]*?capabilityString\(item\)\.slice\(0, maxLength\)[\s\S]*?\.slice\(0, maxItems\)/,
  "capability detail should bound rendered string arrays from runtime payloads",
);

assert.match(
  page,
  /function formatDateTime\(value: unknown, fallback = "never"\): string[\s\S]*?Number\.isNaN\(date\.getTime\(\)\) \? fallback : date\.toLocaleString\(\);/,
  "capability detail should avoid rendering invalid dates in source/poll rows",
);

assert.match(
  page,
  /const list = asObjectArray\(sources\);[\s\S]*?const sourceId = capabilityString\(s\.id\);[\s\S]*?<span>last: \{formatDateTime\(s\.lastPolledAt\)\}<\/span>/,
  "knowledge source rows should normalize source arrays, IDs, and timestamps",
);

assert.match(
  page,
  /const repoId = capabilityString\(repo\.id\);[\s\S]*?disabled=\{busy \|\| disabled \|\| !repoId\}/,
  "repository polling rows should disable mutation when the repo ID is missing or malformed",
);

console.log("capability detail normalization contract tests passed");
