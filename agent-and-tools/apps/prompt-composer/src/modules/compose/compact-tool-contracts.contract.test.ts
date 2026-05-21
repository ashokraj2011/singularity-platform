/**
 * M44 Slice C — verify the compactToolContracts flag genuinely strips the
 * duplicated schema dump while preserving every signal the model needs
 * (name, purpose, risk, execution target, required args).
 *
 * Run with: ts-node --transpile-only this file.
 */
import assert from "node:assert/strict";

// The composeService module evaluates the env schema at import time. For this
// pure-function test we only need DATABASE_URL to be set to *something*; we
// never make a Prisma call. Set it before the dynamic import.
process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://test:test@localhost:5432/test";
process.env.RUNTIME_DATABASE_URL = process.env.RUNTIME_DATABASE_URL ?? process.env.DATABASE_URL;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { composeService } = require("./compose.service") as typeof import("./compose.service");

const sampleTool = {
  tool_name: "apply_patch",
  natural_language: "Apply a unified diff patch inside the MCP sandbox.",
  risk_level: "MEDIUM",
  requires_approval: false,
  execution_target: "LOCAL",
  input_schema: {
    type: "object",
    properties: {
      patch: { type: "string", description: "A unified diff that targets one or more sandbox-relative paths" },
      commit_message: { type: "string" },
    },
    required: ["patch"],
  },
};

// ── default (non-compact) keeps the full schema dump ───────────────────────

const defaultBlock = composeService.renderToolBlock(sampleTool);
assert(
  defaultBlock.includes("Input schema:"),
  "default mode must keep the Input schema line",
);
assert(
  defaultBlock.includes('"patch"') && defaultBlock.includes('"commit_message"'),
  "default mode must include schema property names",
);

// ── compact=true strips the schema but preserves identity + required args ─

const compactBlock = composeService.renderToolBlock(sampleTool, true);
assert(
  !compactBlock.includes("Input schema:"),
  "compact mode MUST NOT include the Input schema JSON dump",
);
assert(
  !compactBlock.includes('"patch"'),
  "compact mode MUST NOT include schema property names",
);
assert(
  compactBlock.includes("## Tool: apply_patch"),
  "compact mode must preserve tool name header",
);
assert(
  compactBlock.includes("Apply a unified diff patch inside the MCP sandbox."),
  "compact mode must preserve purpose / natural_language",
);
assert(
  compactBlock.includes("Risk: MEDIUM"),
  "compact mode must preserve risk level",
);
assert(
  compactBlock.includes("Execution target: LOCAL"),
  "compact mode must preserve execution_target",
);
assert(
  compactBlock.includes("Required args: patch"),
  "compact mode must preserve required-args summary",
);

// ── compact mode size win: must be materially smaller than default ────────

const ratio = compactBlock.length / defaultBlock.length;
assert(
  ratio < 0.6,
  `compact block should be <60% of default; got ratio ${ratio.toFixed(2)} (compact=${compactBlock.length}, default=${defaultBlock.length})`,
);

// ── tools with no required field: compact omits Required-args line ────────

const noRequiredTool = { ...sampleTool, input_schema: { type: "object", properties: {} } };
const compactNoRequired = composeService.renderToolBlock(noRequiredTool, true);
assert(
  !compactNoRequired.includes("Required args:"),
  "compact mode must omit Required args line when schema has none",
);

console.log("M44 compact tool contracts: 9 assertions passed");
