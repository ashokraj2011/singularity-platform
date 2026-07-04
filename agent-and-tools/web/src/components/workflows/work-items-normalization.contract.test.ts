import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

const source = read("src/components/workflows/WorkItemsConsole.tsx");

assert.match(
  source,
  /import \{ asRow, asString \} from "@\/lib\/row";/,
  "WorkItemsConsole should use shared row-normalization helpers",
);

assert.match(
  source,
  /useSWR<unknown>\(path, \(url: string\) => workgraphFetch<unknown>\(url\)/,
  "WorkItems list fetch should enter the console as unknown data",
);

assert.match(
  source,
  /const items = normalizeWorkItems\(data\)\.filter\(\(item\) => matches\(item, query\)\);/,
  "WorkItems console should normalize list rows before filtering and rendering",
);

assert.match(
  source,
  /function normalizeWorkItems\(value: unknown\): WorkItem\[\][\s\S]*?unwrapWorkgraphItems<Record<string, unknown>>\(value, \["workItems", "work_items"\]\)[\s\S]*?filter\(\(item\): item is WorkItem => item !== null\)/,
  "WorkItems normalizer should unwrap envelopes and filter malformed rows",
);

assert.match(
  source,
  /function normalizeWorkItem\(value: unknown\): WorkItem \| null[\s\S]*?targets: uniqueById\(unwrapWorkgraphItems<Record<string, unknown>>\(row\.targets\)\.map\(normalizeWorkItemTarget\)\)[\s\S]*?events: unwrapWorkgraphItems<Record<string, unknown>>\(row\.events\)\.map\(normalizeWorkItemEvent\)\.slice\(0, 30\)/,
  "WorkItem rows should normalize nested targets and bound recent events before rendering",
);

assert.match(
  source,
  /function normalizeWorkItemTarget\(value: unknown, index: number\): WorkItemTarget \| null[\s\S]*?const id = asString\(row\.id \?\? row\.targetId \?\? row\.target_id, `target-\$\{index \+ 1\}`\);[\s\S]*?workflowTemplateStatus: normalizeWorkflowTemplateStatus\(row\.workflowTemplateStatus \?\? row\.workflow_template_status\)/,
  "WorkItem targets should normalize IDs and workflow template diagnostics",
);

assert.match(
  source,
  /function normalizeWorkflowTemplateStatus\(value: unknown\): WorkflowTemplateStatus \| null[\s\S]*?state: state === "valid" \|\| state === "invalid" \? state : state \|\| "invalid"/,
  "workflowTemplateStatus should normalize missing or unexpected states before issue badges render",
);

assert.match(
  source,
  /function uniqueById<T extends \{ id: string \}>\(items: Array<T \| null>\): T\[\][\s\S]*?seen\.has\(item\.id\)/,
  "WorkItems console should dedupe nested target rows before React key usage",
);

assert.doesNotMatch(
  source,
  /unwrapWorkgraphItems<WorkItem>|workgraphFetch<WorkItem>|as WorkItem|as WorkItemTarget/,
  "WorkItems console should not cast Workgraph WorkItem payloads directly to trusted client types",
);

console.log("work items normalization contract tests passed");
