import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const shared = fs.readFileSync(path.join(process.cwd(), "src/app/api/start/_shared.ts"), "utf8");
const launch = fs.readFileSync(path.join(process.cwd(), "src/app/api/start/launch/route.ts"), "utf8");

assert.match(
  shared,
  /function isLaunchableCapability\(value: Record<string, unknown>\): boolean \{[\s\S]*?capabilityStatus\(value\) === "ACTIVE"/,
  "start preview should define launchable capabilities as ACTIVE only",
);

assert.match(
  shared,
  /const launchableCapabilities = capabilities\.filter\(isLaunchableCapability\)/,
  "start preview should filter capability choices to launchable capabilities",
);

assert.match(
  shared,
  /const workflowCapabilityId = stringValue\(workflowTemplate\.capabilityId\)[\s\S]*?const workflowCapability = workflowCapabilityId[\s\S]*?launchableCapabilities\.find[\s\S]*?const demoCapability = launchableCapabilities\.find/,
  "start preview should inspect the workflow-owned capability before choosing a default capability",
);

assert.match(
  shared,
  /const selectedCapability = requestedCapabilityId[\s\S]*?launchableCapabilities\.find[\s\S]*?\?\? \{\}[\s\S]*?: workflowCapability \?\? demoCapability \?\? launchableCapabilities\[0\] \?\? \{\}/,
  "start preview should prefer the workflow capability, then the seeded demo capability, before the first active capability",
);

assert.match(
  shared,
  /id: "workflow-capability-mismatch"[\s\S]*?Selected capability does not match the seeded workflow template capability/,
  "start preview should block manual capability/template mismatches before planner launch",
);

assert.match(
  shared,
  /id: "capability-not-launchable"[\s\S]*?only ACTIVE capabilities can launch guided SDLC workflows/,
  "start preview should surface an explicit blocker for inactive selected capabilities",
);

assert.match(
  shared,
  /capabilities: launchableCapabilities\.slice\(0, 50\)\.map/,
  "start preview should only expose launchable capabilities to start-page selectors",
);

assert.match(
  launch,
  /const hardBlockers = preview\.blockers\.filter\(\(blocker\) => blocker\.severity === "blocked"\)[\s\S]*?START_PREREQUISITES_BLOCKED/,
  "start launch should refuse to launch when preview emits blocked capability prerequisites",
);

assert.match(
  shared,
  /const blockers: StartBlocker\[] = \[[\s\S]*?healthRows\(health, "blocked"\)[\s\S]*?const warnings: StartBlocker\[] = \[[\s\S]*?healthRows\(health, "warning"\)/,
  "start preview should keep health warnings separate from hard launch blockers",
);

assert.match(
  shared,
  /blockers: \[\.\.\.blockers, \.\.\.warnings\],[\s\S]*?warnings,/,
  "start preview should return first-class warnings while preserving the legacy blockers envelope",
);

assert.match(
  launch,
  /preview\.warnings\.map\(\(warning\) => warning\.message\)/,
  "start launch should use first-class preview warnings in launch warnings",
);

console.log("start capability selection contract tests passed");
