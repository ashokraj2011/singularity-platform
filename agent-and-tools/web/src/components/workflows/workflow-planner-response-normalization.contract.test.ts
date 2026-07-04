import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

const page = read("src/components/workflows/WorkflowPlannerConsole.tsx");

assert.match(
  page,
  /import \{ asBoolean, asRow, asRowArray, asString, asStringArray \} from "@\/lib\/row";/,
  "workflow planner should use shared row-normalization helpers",
);

assert.match(
  page,
  /useSWR<unknown>[\s\S]*?runtimeApi\.listCapabilities\(\)[\s\S]*?normalizeCapabilities\(capabilityRows\)/,
  "workflow planner should normalize capability rows from unknown API data",
);

assert.match(
  page,
  /const result = normalizeConverseResult\(await workgraphFetch<unknown>\("\/planner\/converse"[\s\S]*?\), capabilityId\.trim\(\)\);/,
  "planner conversation responses should be normalized before updating state",
);

assert.match(
  page,
  /const result = normalizeCommitResult\(await workgraphFetch<unknown>\("\/planner\/commit"[\s\S]*?\)\);[\s\S]*?setCommitResult\(result\);/,
  "planner commit responses should be normalized before rendering created and failed WorkItems",
);

assert.match(
  page,
  /const result = normalizeLaunchResult\(await workgraphFetch<unknown>\("\/planner\/launch"[\s\S]*?\)\);[\s\S]*?setLaunchResult\(result\);/,
  "planner launch responses should be normalized before rendering run and WorkItem links",
);

assert.match(
  page,
  /function normalizeConverseResult\(value: unknown, homeCapabilityId: string\): ConverseResult[\s\S]*?const row = asRow\(value\);[\s\S]*?questions = asStringArray\(row\.questions[\s\S]*?milestones = normalizeMilestones\(row\.milestones \?\? row\.plan, homeCapabilityId\)/,
  "planner conversation normalizer should bound nested planner fields before rendering",
);

assert.match(
  page,
  /function normalizeCommitResult\(value: unknown\): CommitResult[\s\S]*?created: rowsFrom\(row\.created \?\? row\.workItems[\s\S]*?failed: rowsFrom\(row\.failed \?\? row\.failedWorkItems/,
  "planner commit normalizer should coerce created and failed arrays",
);

assert.match(
  page,
  /function normalizeLaunchResult\(value: unknown\): LaunchResult[\s\S]*?workItems: rowsFrom\(row\.workItems[\s\S]*?failedWorkItems: rowsFrom\(row\.failedWorkItems[\s\S]*?warnings: asStringArray\(row\.warnings/,
  "planner launch normalizer should coerce work item, failure, and warning arrays",
);

assert.match(
  page,
  /function rowsFrom\(value: unknown, keys: string\[\] = \[\]\): Array<Record<string, unknown>>[\s\S]*?if \(Array\.isArray\(value\)\) return asRowArray\(value\);/,
  "workflow planner should share one rowsFrom helper for array envelopes",
);

assert.doesNotMatch(
  page,
  /workgraphFetch<ConverseResult>|workgraphFetch<CommitResult>|workgraphFetch<LaunchResult>|as ConverseResult|as CommitResult|as LaunchResult/,
  "workflow planner should not cast Workgraph planner API responses directly to trusted client types",
);

console.log("workflow planner response normalization contract tests passed");
