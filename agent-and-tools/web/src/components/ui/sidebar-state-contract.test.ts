import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const source = fs.readFileSync(path.join(process.cwd(), "src/components/ui/Sidebar.tsx"), "utf8");
const routesSource = fs.readFileSync(path.join(process.cwd(), "src/lib/nav/routes.ts"), "utf8");
const switcherSource = fs.readFileSync(path.join(process.cwd(), "src/components/AppSwitcher.tsx"), "utf8");
const appsSource = fs.readFileSync(path.join(process.cwd(), "src/lib/controlPlaneApps.ts"), "utf8");

const navGroupsBlock = routesSource.match(/export const NAV_GROUPS:[^=]+ = \[([\s\S]*?)\];/);
assert.ok(navGroupsBlock, "Navigation registry should declare ordered SDLC groups");
const navGroupLabels = [...navGroupsBlock[1].matchAll(/label: "([^"]+)"/g)].map((match) => match[1]);
assert.deepEqual(
  navGroupLabels,
  ["Home", "Discover", "Define", "Plan", "Execute", "Verify", "Release", "Operate", "Administration"],
  "Sidebar navigation should follow the SDLC lifecycle before administration",
);

assert.match(routesSource, /label: "Tool Registry"[^\n]+group: "Define"/, "Tools should be defined before execution");
assert.match(routesSource, /label: "Cost & Usage"[^\n]+group: "Operate"/, "Cost belongs with live platform operation");
assert.match(routesSource, /label: "Platform Guide"[^\n]+group: "Home"/, "Help should be available from Home");
assert.match(routesSource, /label: "Workflow Runs"[^\n]+group: "Execute"/, "Runs should be grouped under Execute");
assert.doesNotMatch(routesSource, /label: "Story Planner"|label: "Active Runs"|label: "App Catalog"/, "Navigation should avoid stale or ambiguous labels");

const routeIds = [...routesSource.matchAll(/\{ id: "([^"]+)", label:/g)].map((match) => match[1]);
assert.equal(new Set(routeIds).size, routeIds.length, "Navigation route IDs must remain unique for favorites and command-palette identity");

for (const workspace of ["Command Center", "Synthesis", "Work Management", "Agent Studio", "Workflows", "Platform Operations", "Identity & Access"]) {
  assert.ok(appsSource.includes(`label: "${workspace}"`), `App switcher should expose ${workspace}`);
}
assert.match(switcherSource, /pathname\.startsWith\("\/runs"\)[^\n]+return "workflows"/, "Runs should resolve to the Workflows workspace");
assert.match(switcherSource, /return "command-center";/, "Unknown and home routes should resolve to Command Center instead of Agent Studio");

assert.match(
  source,
  /const sidebarGroupLabels = new Set<NavGroup>\(menuSections\.map\(\(section\) => section\.label\)\)/,
  "Sidebar should keep a whitelist of known navigation groups for persisted open-group state",
);

assert.match(
  source,
  /function parseStoredBoolean\(raw: string \| null, fallback: boolean\): boolean[\s\S]*?raw === "true"[\s\S]*?raw === "false"[\s\S]*?return fallback/,
  "Sidebar should parse persisted booleans strictly and keep the current state for malformed values",
);

assert.match(
  source,
  /function parseStoredOpenGroups\(raw: string \| null\): Record<string, boolean>[\s\S]*?JSON\.parse\(raw\) as unknown[\s\S]*?!isRecord\(parsed\)[\s\S]*?const next: Record<string, boolean> = \{\};[\s\S]*?sidebarGroupLabels\.has\(key as NavGroup\) && typeof value === "boolean"[\s\S]*?next\[key\] = value;[\s\S]*?catch/,
  "Sidebar should ignore malformed, non-object, unknown, or non-boolean persisted open-group values",
);

assert.match(
  source,
  /setCollapsed\(\(current\) => parseStoredBoolean\(localStorage\.getItem\("sidebar-collapsed"\), current\)\);[\s\S]*?setOpenGroups\(parseStoredOpenGroups\(localStorage\.getItem\("sidebar-open-groups"\)\)\);[\s\S]*?setAdvancedOpen\(\(current\) => parseStoredBoolean\(localStorage\.getItem\("sidebar-advanced-open"\), current\)\);/,
  "Sidebar mount should use defensive parsers for all persisted navigation state",
);

assert.doesNotMatch(
  source,
  /setOpenGroups\(JSON\.parse\(storedGroups\) as Record<string, boolean>\)/,
  "Sidebar should not cast arbitrary localStorage JSON into open-group state",
);

assert.doesNotMatch(
  source,
  /Primary Journey/,
  "Sidebar should not duplicate lifecycle routes in a separate primary-journey list",
);

assert.match(
  source,
  /const primaryItems = section\.items\.filter\(\(item\) => !item\.advanced\);[\s\S]*?const advancedItems = section\.items\.filter\(\(item\) => item\.advanced\);[\s\S]*?visibleAdvancedItems/,
  "Advanced controls should remain inside their owning SDLC phase",
);

console.log("sidebar persisted state contract tests passed");
