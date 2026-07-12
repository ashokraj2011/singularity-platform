import assert from "node:assert/strict";
import { buildCopilotArgs } from "./copilot-execute";

// Default (current behaviour): --allow-all present, so the CLI edits files + runs commands unattended.
assert.deepEqual(buildCopilotArgs("do the thing", true), ["-p", "do the thing", "--allow-all"]);

// Opt-out: a governed run threading run_context.copilot_allow_all=false drops --allow-all to shrink
// the executor's blast radius.
assert.deepEqual(buildCopilotArgs("do the thing", false), ["-p", "do the thing"]);
assert.ok(buildCopilotArgs("x", false).every((a) => a !== "--allow-all"));

// The task is a single argv element (spawn shell:false), never shell-interpolated — so a prompt that
// looks like a shell command can't inject args around the CLI, regardless of allow_all.
const injected = buildCopilotArgs("a; rm -rf /", true);
assert.equal(injected[0], "-p");
assert.equal(injected[1], "a; rm -rf /");
assert.ok(injected.includes("--allow-all"));

console.log("copilot-execute.contract.test.ts OK");
