import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const component = fs.readFileSync(path.join(process.cwd(), "src/components/workflows/RoutingPoliciesConsole.tsx"), "utf8");
const route = fs.readFileSync(path.join(process.cwd(), "src/app/workflows/routing-policies/page.tsx"), "utf8");
const nav = fs.readFileSync(path.join(process.cwd(), "src/lib/nav/routes.ts"), "utf8");

assert.match(
  component,
  /type WorkflowTemplateStatus = \{[\s\S]*?state\?: "valid" \| "invalid" \| string \| null;[\s\S]*?reason\?: string \| null;[\s\S]*?message\?: string \| null;/,
  "Routing policies console should model workflowTemplateStatus diagnostics returned by Workgraph",
);

assert.match(
  component,
  /const path = `\/work-item-routing-policies\$\{filter \? `\?\$\{filter\}` : ""\}`;/,
  "Routing policies console should fetch the Workgraph routing-policy endpoint",
);

assert.match(
  component,
  /Metric label="Template issues" value=\{issueCount\}/,
  "Routing policies console should count invalid workflow-template bindings",
);

assert.match(
  component,
  /hasTemplateIssue\(policy\) && <Badge tone="#b91c1c">\{policy\.workflowTemplateStatus\?\.reason \?\? "Template issue"\}<\/Badge>/,
  "Routing policies console should surface per-policy template diagnostic reasons",
);

assert.match(
  component,
  /Workflow template binding needs attention/,
  "Routing policies console should explain broken template bindings in the detail view",
);

assert.match(
  component,
  /function hasTemplateIssue\(policy: RoutingPolicy\): boolean \{[\s\S]*?return policy\.workflowTemplateStatus\?\.state === "invalid";[\s\S]*?\}/,
  "Routing policies console should centralize invalid-template detection",
);

assert.match(
  route,
  /RoutingPoliciesConsole/,
  "Routing policies page should mount the native diagnostics console",
);

assert.match(
  nav,
  /href: "\/workflows\/routing-policies"[\s\S]*label: "Routing Policies"|label: "Routing Policies"[\s\S]*href: "\/workflows\/routing-policies"/,
  "Routing policies diagnostics route should be available from shared navigation metadata",
);

console.log("routing-policies-console contract passed");
