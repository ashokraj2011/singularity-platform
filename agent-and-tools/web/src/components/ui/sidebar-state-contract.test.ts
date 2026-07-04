import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const source = fs.readFileSync(path.join(process.cwd(), "src/components/ui/Sidebar.tsx"), "utf8");

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

console.log("sidebar persisted state contract tests passed");
