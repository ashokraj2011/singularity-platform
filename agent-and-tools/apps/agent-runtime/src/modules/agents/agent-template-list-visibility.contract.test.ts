import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const service = fs.readFileSync(path.join(process.cwd(), "src/modules/agents/agent.service.ts"), "utf8");

assert.match(
  service,
  /where\.status = filter\.status \?\? \{ not: "ARCHIVED" \};/,
  "agent template list must hide archived templates unless a status filter explicitly asks for them",
);

console.log("agent template list visibility contract tests passed");
