import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

const settings = read("src/app/settings/page.tsx");
const routes = read("src/lib/nav/routes.ts");

for (const section of ["profile", "runtime", "source", "notifications", "workflows", "security"]) {
  assert.match(
    settings,
    new RegExp(`id: "${section}"`),
    `settings page should expose the ${section} section`,
  );
}

assert.match(
  routes,
  /id: "settings"[\s\S]*?label: "Platform Settings"[\s\S]*?href: "\/settings"/,
  "platform settings should be registered in shared route metadata",
);

assert.match(
  settings,
  /const res = await fetch\(apiPath\("\/api\/adoption\/health"\), \{ cache: "no-store", headers: authHeaders\(\) \}\);[\s\S]*?setHealth\(normalizeHealthSummary\(parsed\)\);/,
  "settings should show live platform health summary instead of static placeholder content",
);

assert.match(
  settings,
  /loadNotificationPreferences\(\)[\s\S]*?saveNotificationPreferences\(next\)[\s\S]*?saveNotificationState\(\{\}\)/,
  "notification settings should load preferences, save category toggles, and reset local notification state",
);

assert.match(
  settings,
  /<CopyButton text=\{command\} \/>/,
  "settings command blocks should use the shared copy button with the correct prop",
);

assert.match(
  settings,
  /bin\/mcp-runtime-setup\.sh[\s\S]*?\/llm-settings[\s\S]*?\/operations\/readiness/,
  "runtime settings should provide actionable MCP+LLM setup commands and routes",
);

assert.match(
  settings,
  /\/identity\/git-connections[\s\S]*?\/identity\/repository-grants/,
  "source settings should route users to GitHub connections and repository grants",
);

assert.match(
  settings,
  /\/operations\/access-keys[\s\S]*?\/identity\/roles/,
  "security settings should route users to access keys and roles",
);

assert.doesNotMatch(
  settings,
  /import \{ asNumber, asRow, asString \} from "@\/lib\/row";/,
  "settings should not import non-existent row helpers",
);

console.log("settings page contract tests passed");
