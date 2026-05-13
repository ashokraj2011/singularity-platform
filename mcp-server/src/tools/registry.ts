/**
 * Local tool registry.
 *
 * In v0 this is a hard-coded set of safe tools, useful for smoke-testing the
 * LLM↔tool loop without external dependencies. In v1 the registry is
 * populated by syncing from `tool-service` (filtered to tools with
 * execution_target=LOCAL for this capability).
 *
 * A "local tool" runs inside this MCP server process. Customer-side tools
 * (filesystem, GitHub, internal HTTP APIs) belong here and never round-trip
 * through our cloud.
 */
export interface ToolDescriptor {
  name: string;
  description: string;
  natural_language: string;
  input_schema: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  risk_level: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  requires_approval: boolean;
}

export interface ToolHandler {
  descriptor: ToolDescriptor;
  execute(args: Record<string, unknown>): Promise<{
    output: unknown;
    success: boolean;
    error?: string;
  }>;
}

const echoTool: ToolHandler = {
  descriptor: {
    name: "echo",
    description: "Echoes the input text back, prefixed with 'echo:'.",
    natural_language:
      "Use this when the user asks you to echo, repeat, or repeat-back a piece of text exactly.",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The text to echo" },
      },
      required: ["text"],
    },
    output_schema: {
      type: "object",
      properties: { text: { type: "string" } },
    },
    risk_level: "LOW",
    requires_approval: false,
  },
  async execute(args) {
    const text = typeof args.text === "string" ? args.text : "";
    return { success: true, output: { text: `echo: ${text}` } };
  },
};

const nowTool: ToolHandler = {
  descriptor: {
    name: "current_time",
    description: "Returns the current ISO-8601 UTC timestamp.",
    natural_language:
      "Use this when the user asks for the current time, date, timestamp, or 'what time is it'.",
    input_schema: { type: "object", properties: {} },
    output_schema: {
      type: "object",
      properties: { now: { type: "string", format: "date-time" } },
    },
    risk_level: "LOW",
    requires_approval: false,
  },
  async execute() {
    return { success: true, output: { now: new Date().toISOString() } };
  },
};

// Approval-gated test tool — exercises the M9.z pause/resume flow.
// Realistic example: a tool that sends an external notification or kicks off
// a billable action. The agent loop pauses on this; an operator approves or
// rejects via /mcp/resume.
const notifyAdminTool: ToolHandler = {
  descriptor: {
    name: "notify_admin",
    description: "Send a high-priority notification to the on-call admin. Approval-gated.",
    natural_language:
      "Use this only when the user explicitly asks to escalate, page, or notify the admin or on-call.",
    input_schema: {
      type: "object",
      properties: {
        subject: { type: "string", description: "Short summary" },
        body: { type: "string", description: "Full message body" },
      },
      required: ["subject"],
    },
    output_schema: {
      type: "object",
      properties: { delivered_at: { type: "string", format: "date-time" } },
    },
    risk_level: "HIGH",
    requires_approval: true,
  },
  async execute(args) {
    const subject = typeof args.subject === "string" ? args.subject : "(no subject)";
    return {
      success: true,
      output: {
        delivered_at: new Date().toISOString(),
        subject,
        delivered_to: "admin@example.com",
      },
    };
  },
};

// ── M13 — code-change demo tools ────────────────────────────────────────────
//
// These two return the typed `kind:"code_change"` envelope the
// provenanceExtractor recognises. They don't actually touch the filesystem —
// just synthesise a believable record so we can smoke the pipeline end-to-end
// without wiring real fs/git tools yet. In v1 they get replaced by the real
// fs / patch / git tools synced from tool-service.

const writeFileDemoTool: ToolHandler = {
  descriptor: {
    name: "write_file_demo",
    description: "Demo tool that records a synthetic file-write code-change. Does NOT touch disk.",
    natural_language:
      "Use this when the user asks to write or create a file. Provide path and content.",
    input_schema: {
      type: "object",
      properties: {
        path:    { type: "string", description: "Relative file path" },
        content: { type: "string", description: "New file body" },
        language: { type: "string" },
      },
      required: ["path", "content"],
    },
    risk_level: "MEDIUM",
    requires_approval: false,
  },
  async execute(args) {
    const path     = typeof args.path === "string" ? args.path : "untitled.txt";
    const content  = typeof args.content === "string" ? args.content : "";
    const language = typeof args.language === "string" ? args.language : undefined;
    const lines    = content.split("\n").length;
    return {
      success: true,
      output: {
        kind: "code_change",
        paths_touched: [path],
        diff: `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines} @@\n${content.split("\n").map((l) => `+${l}`).join("\n")}\n`,
        language,
        lines_added: lines,
        lines_removed: 0,
      },
    };
  },
};

const applyPatchDemoTool: ToolHandler = {
  descriptor: {
    name: "apply_patch_demo",
    description: "Demo tool that records a synthetic patch + git commit code-change. Does NOT touch disk.",
    natural_language:
      "Use this when the user asks to apply a patch or commit a change.",
    input_schema: {
      type: "object",
      properties: {
        patch:        { type: "string" },
        commit_message: { type: "string" },
      },
      required: ["patch"],
    },
    risk_level: "MEDIUM",
    requires_approval: false,
  },
  async execute(args) {
    const patch  = typeof args.patch === "string" ? args.patch : "";
    // Fake a deterministic-ish sha so smoke tests are repeatable.
    const sha = "demo" + Math.random().toString(16).slice(2, 10).padEnd(8, "0");
    // Best-effort path extraction from `+++ b/<path>` lines in the patch.
    const paths = Array.from(patch.matchAll(/\+\+\+ b\/(\S+)/g)).map((m) => m[1]);
    return {
      success: true,
      output: {
        kind: "code_change",
        paths_touched: paths,
        patch,
        commit_sha: sha,
      },
    };
  },
};

// M16 — real fs/git tools alongside the M13 demos. Both are sandboxed to
// MCP_SANDBOX_ROOT. Demos are kept registered so existing smoke tests don't
// break; promote write_file / git_commit when consumers are ready.
import { writeFileTool, gitCommitTool } from "./fs-git";
// M18 — core utility tools (read-only fs + http + ripgrep search).
import {
  readFileTool, listDirectoryTool, searchCodeTool, httpGetTool, webFetchTool,
} from "./core";
// M26 — gh copilot headless wrappers (only meaningful in laptop mode where the
// user has run `gh auth login` and `gh extension install github/gh-copilot`).
import { copilotSuggestTool, copilotExplainTool } from "./copilot-headless";

const REGISTRY = new Map<string, ToolHandler>([
  [echoTool.descriptor.name, echoTool],
  [nowTool.descriptor.name, nowTool],
  [notifyAdminTool.descriptor.name, notifyAdminTool],
  [writeFileDemoTool.descriptor.name, writeFileDemoTool],
  [applyPatchDemoTool.descriptor.name, applyPatchDemoTool],
  [writeFileTool.descriptor.name, writeFileTool],
  [gitCommitTool.descriptor.name, gitCommitTool],
  [readFileTool.descriptor.name, readFileTool],
  [listDirectoryTool.descriptor.name, listDirectoryTool],
  [searchCodeTool.descriptor.name, searchCodeTool],
  [httpGetTool.descriptor.name, httpGetTool],
  [webFetchTool.descriptor.name, webFetchTool],
  [copilotSuggestTool.descriptor.name, copilotSuggestTool],
  [copilotExplainTool.descriptor.name, copilotExplainTool],
]);

export function listLocalTools(): ToolDescriptor[] {
  return Array.from(REGISTRY.values()).map((t) => t.descriptor);
}

export function getLocalTool(name: string): ToolHandler | undefined {
  return REGISTRY.get(name);
}
