import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

const source = read("src/lib/platformNotifications.ts");

assert.match(
  source,
  /export const NOTIFICATION_PREFERENCES_KEY = "singularity\.notification\.preferences\.v1";[\s\S]*?export const NOTIFICATION_STATE_KEY = "singularity\.notification\.state\.v1";/,
  "notification preferences and local state should use stable versioned localStorage keys",
);

for (const category of ["workflow", "runtime", "security", "governance", "setup", "agents"]) {
  assert.match(
    source,
    new RegExp(`\\{ id: "${category}"`),
    `notification category ${category} should be defined for settings and filtering`,
  );
}

assert.match(
  source,
  /export function derivePlatformNotifications\(health: unknown\): PlatformNotification\[\][\s\S]*?status === "blocked" \|\| status === "warning"/,
  "platform notifications should derive actionable items from blocked and warning health checks",
);

assert.match(
  source,
  /fixRoute[\s\S]*?category === "runtime" \? "\/llm-settings" : "\/operations\/readiness"/,
  "health-derived notifications should route to the check fix route or a useful default route",
);

assert.match(
  source,
  /id: "health:platform-ready"[\s\S]*?severity: "success"[\s\S]*?href: "\/operations\/readiness"/,
  "notification center should show a positive ready state when no checks need action",
);

assert.match(
  source,
  /export function applyNotificationState\([\s\S]*?!prefs\[item\.category\][\s\S]*?local\?\.resolved[\s\S]*?local\?\.snoozedUntil/,
  "notification filtering should respect category preferences, resolved state, and snoozes",
);

assert.match(
  source,
  /export function unresolvedNotificationCount\([\s\S]*?item\.severity !== "success"[\s\S]*?!state\[item\.id\]\?\.read/,
  "topbar badge should count unread actionable notifications only",
);

console.log("platform notifications contract tests passed");
