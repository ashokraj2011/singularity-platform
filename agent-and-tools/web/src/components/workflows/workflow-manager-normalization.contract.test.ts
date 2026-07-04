import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

const source = read("src/components/workflows/WorkflowManager.tsx");

assert.match(
  source,
  /import \{ asBoolean, asRow, asString \} from "@\/lib\/row";/,
  "WorkflowManager should use shared row-normalization helpers",
);

assert.match(
  source,
  /const templates = normalizeWorkflowTemplates\(templatesData\)[\s\S]*?const allRuns = normalizeWorkflowInstances\(runsData\)/,
  "workflow manager should normalize templates and run rows before filtering or rendering",
);

assert.match(
  source,
  /const workflows = normalizeWorkflowTemplates\(data\)\.filter/,
  "start workflow catalog should normalize workflow template rows before rendering cards",
);

assert.match(
  source,
  /const items = normalizeWorkItems\(data\);[\s\S]*?const choices = items\.flatMap/,
  "start workflow dialog should normalize WorkItems and targets before building choices",
);

assert.match(
  source,
  /const created = normalizeCreateWorkflowResult\(await workgraphFetch<unknown>\("\/workflow-templates"/,
  "workflow create response should be normalized from unknown before navigation",
);

assert.match(
  source,
  /const result = normalizeStartWorkflowResult\(await workgraphFetch<unknown>\(`\/work-items\/\$\{choice\.item\.id\}\/targets\/\$\{choice\.target\.id\}\/start`/,
  "workflow start response should be normalized from unknown before run routing",
);

assert.match(
  source,
  /function normalizeWorkflowTemplates\(value: unknown\): WorkflowTemplate\[\][\s\S]*?unwrapWorkgraphItems<Record<string, unknown>>\(value\)[\s\S]*?filter\(\(template\): template is WorkflowTemplate => template !== null\)/,
  "template rows should be filtered through a null-safe normalizer",
);

assert.match(
  source,
  /function normalizeWorkflowInstances\(value: unknown\): WorkflowInstance\[\][\s\S]*?unwrapWorkgraphItems<Record<string, unknown>>\(value\)[\s\S]*?filter\(\(run\): run is WorkflowInstance => run !== null\)/,
  "run rows should be filtered through a null-safe normalizer",
);

assert.match(
  source,
  /function normalizeWorkItem\(value: unknown\): WorkItemRow \| null[\s\S]*?targets: unwrapWorkgraphItems<Record<string, unknown>>\(row\.targets\)\.map\(normalizeWorkItemTarget\)/,
  "WorkItem target arrays should be normalized before target selection",
);

assert.doesNotMatch(
  source,
  /unwrapWorkgraphItems<WorkflowTemplate>|unwrapWorkgraphItems<WorkflowInstance>|unwrapWorkgraphItems<WorkItemRow>|workgraphFetch<\{ id: string \}>|workgraphFetch<\{ childWorkflowInstanceId/,
  "WorkflowManager should not cast Workgraph workflow/list/start responses directly to trusted client types",
);

console.log("workflow manager normalization contract tests passed");
