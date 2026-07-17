import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const source = fs.readFileSync(path.join(process.cwd(), "src/components/workflows/WorkItemsConsole.tsx"), "utf8");

assert.match(source, /\/lookup\/capabilities\?size=200&status=ACTIVE/);
assert.match(source, /<select[\s\S]*?value=\{targetCapabilityId\}[\s\S]*?Choose an active capability/);
assert.match(source, /Loaded live from Agent and Tools/);
assert.doesNotMatch(source, /Field label="Target capability id"><input/);

console.log("WorkItem Agent and Tools capability picker contract tests passed");
