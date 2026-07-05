import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

const shell = read("src/components/AppShell.tsx");
const center = read("src/components/NotificationCenter.tsx");

assert.match(
  shell,
  /import \{ NotificationCenter \} from "@\/components\/NotificationCenter";[\s\S]*?<NotificationCenter \/>/,
  "AppShell should render the real notification center in the topbar",
);

assert.match(
  shell,
  /href="\/settings"[\s\S]*?aria-label="Settings"/,
  "AppShell settings gear should navigate to the platform settings page",
);

assert.doesNotMatch(
  shell,
  /alert\("Notifications coming soon"\)|alert\("Settings coming soon"\)/,
  "topbar notification and settings buttons should not be inert placeholders",
);

assert.match(
  center,
  /fetch\(apiPath\("\/api\/adoption\/health"\), \{ cache: "no-store", headers: authHeaders\(\) \}\)/,
  "notification center should source actionable signals from adoption health",
);

assert.match(
  center,
  /derivePlatformNotifications\(parsed\)/,
  "notification center should normalize health checks into platform notifications",
);

assert.match(
  center,
  /window\.addEventListener\("singularity-notification-state-changed"[\s\S]*?window\.addEventListener\("singularity-notification-preferences-changed"/,
  "notification center should react to local read/snooze/resolve and preference changes",
);

assert.match(
  center,
  /snoozedUntil: Date\.now\(\) \+ 4 \* 60 \* 60 \* 1000[\s\S]*?resolved: true/,
  "notification center should support snoozing and resolving notifications",
);

assert.match(
  center,
  /href="\/settings\?section=notifications"/,
  "notification drawer should link directly to notification settings",
);

console.log("notification center contract tests passed");
