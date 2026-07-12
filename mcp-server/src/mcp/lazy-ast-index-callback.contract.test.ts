import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// The lazy AST index builds (/mcp/invoke's invoke_start|branch_start and
// /mcp/tool-run's tool_run_bootstrap) must report back so agent-runtime stamps
// CapabilityWorldModel.astIndexedAt. Previously ONLY /mcp/code-context/build and
// /mcp/source/ground reported, so the lazy path left astIndexedAt NULL forever
// even though a local SQLite index existed.
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
const invoke = read("src/mcp/invoke.ts");
const toolRun = read("src/mcp/tool-run.ts");

// The exact guarded, fire-and-forget report (identical at both sites).
const REPORT =
  /if \(correlation\.capabilityId && config\.AGENT_RUNTIME_URL\)\s*\{\s*void reportAstIndexBuiltToAgentRuntime\(config\.AGENT_RUNTIME_URL, correlation\.capabilityId, astStats\.indexedFiles\)/;

// invoke.ts — report after the invoke_start / branch_start build.
assert.match(invoke, REPORT, "invoke.ts must report astIndexedAt (guarded, fire-and-forget)");
assert.ok(
  invoke.indexOf("reportAstIndexBuiltToAgentRuntime(config.AGENT_RUNTIME_URL") >
    invoke.indexOf('indexWorkspace("invoke_start")'),
  "invoke.ts report must come after the lazy invoke_start build",
);

// tool-run.ts — report after the tool_run_bootstrap build.
assert.match(toolRun, REPORT, "tool-run.ts must report astIndexedAt (guarded, fire-and-forget)");
assert.ok(
  toolRun.indexOf("reportAstIndexBuiltToAgentRuntime(config.AGENT_RUNTIME_URL") >
    toolRun.indexOf('indexWorkspace("tool_run_bootstrap")'),
  "tool-run.ts report must come after the lazy tool_run_bootstrap build",
);

console.log("mcp-server lazy-ast-index-callback contract tests passed");
