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
  /const requestedCapabilityId = stringValue\(input\.capabilityId\)[\s\S]*?const selectedCapability = requestedCapabilityId[\s\S]*?launchableCapabilities\.find[\s\S]*?\?\? \{\}[\s\S]*?: launchableCapabilities\[0\] \?\? \{\}/,
  "start preview should not silently fall back when a requested capability id is not launchable",
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

console.log("start capability selection contract tests passed");
