import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const source = fs.readFileSync(path.join(process.cwd(), "src/components/workflows/WorkItemsConsole.tsx"), "utf8");

assert.match(
  source,
  /type WorkflowTemplateStatus = \{[\s\S]*?state\?: "valid" \| "invalid"/,
  "WorkItemsConsole should model workflowTemplateStatus returned by Workgraph",
);

assert.match(
  source,
  /const invalidTemplateTargetCount = items\.reduce\([\s\S]*?invalidTemplateTargets\(item\)\.length/,
  "WorkItems dashboard should count invalid target-template bindings",
);

assert.match(
  source,
  /<Metric label="Template issues" value=\{invalidTemplateTargetCount\}/,
  "WorkItems dashboard should show a Template issues metric",
);

assert.match(
  source,
  /href="\/workflows\/routing-policies"[\s\S]*Routing policies/,
  "WorkItems dashboard should link operators to routing-policy diagnostics",
);

assert.match(
  source,
  /invalidTemplateTargets\(item\)\.length > 0 && <Badge tone="#b91c1c">Template issue<\/Badge>/,
  "WorkItem list cards should flag rows with invalid template bindings",
);

assert.match(
  source,
  /Workflow template binding needs attention/,
  "WorkItem detail should explain invalid template bindings before target start",
);

assert.match(
  source,
  /target\.workflowTemplateStatus\?\.state === "invalid" && <Badge tone="#b91c1c">\{target\.workflowTemplateStatus\.reason \?\? "Template issue"\}<\/Badge>/,
  "Target rows should render the invalid template reason",
);

assert.match(
  source,
  /function invalidTemplateTargets\(item: WorkItem\): WorkItemTarget\[\]/,
  "WorkItemsConsole should centralize invalid template target detection",
);

console.log("work item template status UI contract tests passed");
