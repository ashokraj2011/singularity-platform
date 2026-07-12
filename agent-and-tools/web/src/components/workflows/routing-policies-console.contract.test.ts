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
  /New routing policy/,
  "Routing policies console should expose a create-policy action",
);

assert.match(
  component,
  /function openCreate\(\)/,
  "Routing policies console should wire the create-policy action",
);

assert.match(
  component,
  /function openEdit\(policy: RoutingPolicy\)[\s\S]*?function savePolicy\(\)/,
  "Routing policies console should provide an edit and save path",
);

assert.match(
  component,
  /\["items", "content", "data", "templates"/,
  "Routing policies console should unwrap paginated workflow-template content",
);

assert.match(
  component,
  /workgraphFetch<Record<string, unknown>>\("\/metadata-definitions", \{[\s\S]*?method: "POST"[\s\S]*?status: "ACTIVE"[\s\S]*?scopeType: "GLOBAL"/,
  "Routing policies console should create new metadata-backed types through WorkGraph",
);

assert.match(
  component,
  /onOpenTypeCreator\("WORK_ITEM_TYPE"\)[\s\S]*?onOpenTypeCreator\("WORKFLOW_TYPE"\)/,
  "Routing policy editor should expose creation actions for both type families",
);

assert.match(
  component,
  /function normalizeTypeKey\(value: unknown\): string[\s\S]*?toUpperCase\(\)[\s\S]*?replace\(\/\[\^A-Z0-9\]\+\//,
  "New metadata type keys should be normalized before they are persisted",
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
